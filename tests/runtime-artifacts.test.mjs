import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import YAML from "yaml";
import { buildMemoryAll, verifyMemoryDownload } from "../scripts/internal/shared/build-memory-all.mjs";

const root = resolve(import.meta.dirname, "..");
const collector = join(root, "scripts/internal/shared/collect-runtime-artifacts.mjs");
const workflow = YAML.parse(await readFile(join(root, ".github/workflows/runtime-artifacts.yml"), "utf8"));
const roots = [];
afterEach(async () => { for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });

it("collects all target artifacts and rejects corrupted downloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-artifact-test-"));
  roots.push(directory);
  const targets = workflow.jobs.build.strategy.matrix.include.map((entry) => entry.target);
  expect(new Set(targets)).toEqual(new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"]));
  let corrupted;
  for (const target of targets) {
    const input = join(directory, "input", `runtimes-${target}`);
    await mkdir(input, { recursive: true });
    for (const kind of ["agent", "memory"]) {
      const manifestPath = kind === "agent" ? "App/memmy-agent/package.json" : "Memory/package.json";
      const version = JSON.parse(await readFile(join(root, manifestPath))).version;
      const name = `memmy-${kind}-runtime-${version}-${target}.${kind === "agent" ? "tgz" : "tar.gz"}`;
      const bytes = Buffer.from(`${kind}:${target}`);
      corrupted = join(input, name);
      await writeFile(corrupted, bytes);
      const metadata = { version, assets: { [target]: { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } };
      await writeFile(join(input, kind === "agent" ? `agent-release-${target}.json` : "memory-release.json"), JSON.stringify(metadata));
    }
  }
  const args = [collector, join(directory, "input"), join(directory, "output")];
  execFileSync(process.execPath, args);
  expect((await readdir(join(directory, "output"))).length).toBe(14);
  const manifest = JSON.parse(await readFile(join(directory, "output/runtime-artifacts.json")));
  expect(Object.keys(manifest.runtimes.agent.assets)).toHaveLength(6);
  expect(Object.keys(manifest.runtimes.memory.assets)).toHaveLength(6);
  for (const target of targets) {
    const input = join(directory, "input", `runtimes-${target}`);
    for (const name of await readdir(input)) if (name.includes("agent")) await rm(join(input, name));
  }
  const memoryOutput = join(directory, "memory-output");
  const memoryArgs = [collector, join(directory, "input"), memoryOutput, "memory"];
  execFileSync(process.execPath, memoryArgs, { env: { ...process.env, GITHUB_SHA: "test-commit" } });
  expect(await readdir(memoryOutput)).toHaveLength(8);
  await verifyMemoryDownload(memoryOutput, "test-commit");
  await expect(verifyMemoryDownload(memoryOutput, "other-commit")).rejects.toThrow("requested commit");
  await writeFile(join(memoryOutput, (await readdir(memoryOutput)).find((name) => name.endsWith("tar.gz"))), "corrupt download");
  await expect(verifyMemoryDownload(memoryOutput, "test-commit")).rejects.toThrow("Checksum");
  await writeFile(corrupted, "corrupted");
  expect(() => execFileSync(process.execPath, memoryArgs, { stdio: "pipe" })).toThrow();
});

it("rejects local changes before uploading source", async () => {
  await expect(buildMemoryAll({ run: () => " M package.json" })).rejects.toThrow("Commit your local changes");
});

it("tracks the pushed build and propagates failure before downloading", async () => {
  let branch;
  let watched = false;
  const calls = [];
  await expect(buildMemoryAll({
    wait: async () => {},
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === "git") {
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "sha";
        if (args[0] === "remote") return "https://github.com/owner/repo.git";
        if (args[0] === "push") {
          expect(args[1]).toBe("origin");
          expect(args[2]).toMatch(/^sha:refs\/heads\/zy_memory_runtime_/);
          branch = args[2].split("/").at(-1);
          return "";
        }
      }
      if (args[0] === "repo") {
        expect(args[2]).toBe("https://github.com/owner/repo.git");
        return "owner/repo";
      }
      if (args[1] === "list") {
        expect(args).toContain(branch);
        expect(args).toContain("push");
        return JSON.stringify([
          { databaseId: 10, headSha: "other-sha" },
          { databaseId: 11, headSha: "sha", url: "https://example.test/run/11" },
        ]);
      }
      if (args[1] === "watch") {
        expect(args[2]).toBe("11");
        watched = true;
        throw new Error("Windows build failed");
      }
      throw new Error("Unexpected command");
    },
  })).rejects.toThrow("Windows build failed");
  expect(watched).toBe(true);
  expect(calls.some((args) => args.includes("download"))).toBe(false);
});
