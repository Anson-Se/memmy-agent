import { describe, expect, it } from "vitest";
import {
  buildEvidenceFragments,
  clipToolOutput,
  extractToolPaths
} from "../../../src/service/l3-field/evidence-fragments.js";
import type { ResolvedProject } from "../../../src/service/l3-field/types.js";
import type { RawTurnRecord } from "../../../src/storage/repositories.js";

function rawTurn(toolCalls: unknown[], toolResults: unknown[] = [], userText = "帮我看一下"): RawTurnRecord {
  return {
    id: "raw-1",
    sessionId: "s",
    episodeId: "e",
    turnId: "t",
    userId: "u",
    userText,
    assistantText: "好的",
    toolCalls,
    toolResults,
    sourceMemoryIds: [],
    usage: {},
    status: "succeeded",
    createdAt: "2026-10-24T01:00:00.000Z"
  };
}

/** Projects are the first two path components under /work, e.g. /work/repo-a. */
function resolve(target: string): ResolvedProject | null {
  const match = /^\/work\/([^/]+)/.exec(target);
  if (!match) return null;
  return { identity: `id:${match[1]}`, checkoutRoot: `/work/${match[1]}`, source: "git", displayName: match[1]! };
}
const unitKeyOf = (project: ResolvedProject) => `unit:${project.identity}`;

function build(turn: RawTurnRecord, sessionCwd: string | null = "/work/repo-a") {
  return buildEvidenceFragments({ rawTurn: turn, l1MemoryId: "l1-1", sessionCwd, sessionProjectRoot: sessionCwd, resolve, unitKeyOf });
}

describe("extractToolPaths", () => {
  it("reads Claude Code file tools and resolves relative paths against the working directory", () => {
    expect(extractToolPaths({ name: "Read", input: { file_path: "/work/repo-a/src/a.ts" } }, null)).toEqual(["/work/repo-a/src/a.ts"]);
    expect(extractToolPaths({ name: "Edit", input: { file_path: "src/a.ts" } }, "/work/repo-a")).toEqual(["/work/repo-a/src/a.ts"]);
    expect(extractToolPaths({ name: "NotebookEdit", input: { notebook_path: "/work/repo-a/n.ipynb" } }, null)).toEqual(["/work/repo-a/n.ipynb"]);
  });

  it("parses Codex arguments given as a JSON string, including workdir", () => {
    const call = { name: "exec_command", input: JSON.stringify({ cmd: "npm test", workdir: "/work/repo-b" }) };
    expect(extractToolPaths(call, "/work/repo-a")).toEqual(["/work/repo-b"]);
  });

  it("reads cmd and workdir out of a Codex code-mode snippet", () => {
    const code = [
      "const r = await Promise.allSettled([",
      "  tools.exec_command({cmd: \"sed -n 1,20p src/a.ts\", workdir: \"/work/repo-b\"}),",
      "  tools.exec_command({cmd: 'cat /work/repo-c/x.md'}),",
      "]);"
    ].join("\n");
    expect(extractToolPaths({ name: "exec", input: code }, "/work/repo-a")).toEqual([
      "/work/repo-b", "/work/repo-c/x.md"
    ]);
  });

  it("skips arguments that are broken JSON", () => {
    expect(extractToolPaths({ name: "exec_command", input: "{not json" }, "/work/repo-a")).toEqual([]);
  });

  it("takes cd and git -C targets and absolute path arguments from commands, but not URLs or the executable", () => {
    const command = `cd /work/repo-a && git -C "/work/repo b" status && /usr/bin/env cat /work/repo-c/README.md && curl https://example.com/x`;
    expect(extractToolPaths({ name: "Bash", input: { command } }, null)).toEqual([
      "/work/repo-a", "/work/repo b", "/work/repo-c/README.md"
    ]);
  });

  it("follows a relative cd from the current directory", () => {
    expect(extractToolPaths({ name: "Bash", input: { command: "cd packages/app && npm test" } }, "/work/mono"))
      .toEqual(["/work/mono/packages/app"]);
  });

  it("recognizes Windows drive paths", () => {
    expect(extractToolPaths({ name: "Read", input: { file_path: "C:\\work\\repo\\a.ts" } }, null)).toEqual(["C:\\work\\repo\\a.ts"]);
  });
});

describe("clipToolOutput", () => {
  it("keeps head, tail and the error lines in between, and marks the cut", () => {
    const middle = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    middle[200] = "Error: ENOENT: no such file or directory";
    const clipped = clipToolOutput(middle.join("\n"));
    expect(clipped).toContain("line 0");
    expect(clipped).toContain("line 399");
    expect(clipped).toContain("Error: ENOENT: no such file or directory");
    expect(clipped).toContain("[已截断]");
  });

  it("returns short output unchanged", () => {
    expect(clipToolOutput("ok")).toBe("ok");
  });
});

describe("buildEvidenceFragments", () => {
  it("makes one fragment for the user text and one per tool call with its own candidates", () => {
    const fragments = build(rawTurn([
      { id: "c1", name: "Edit", input: { file_path: "/work/repo-a/a.ts" }, output: "done", success: true },
      { id: "c2", name: "Bash", input: { command: "cd /work/repo-b && npm test" }, output: "1 failed", success: false }
    ]));
    expect(fragments.map((fragment) => [fragment.toolName, fragment.candidateUnitKeys, fragment.isError])).toEqual([
      [null, ["unit:id:repo-a"], false],
      ["Edit", ["unit:id:repo-a"], false],
      ["Bash", ["unit:id:repo-b"], true]
    ]);
    expect(fragments[0]!.output).toBe("帮我看一下");
    expect(new Set(fragments.map((fragment) => fragment.id)).size).toBe(3);
    expect(fragments.every((fragment) => fragment.l1MemoryId === "l1-1" && fragment.rawTurnId === "raw-1")).toBe(true);
  });

  it("gives stable fragment ids for the same raw turn", () => {
    const turn = rawTurn([{ id: "c1", name: "Read", input: { file_path: "/work/repo-a/a.ts" }, output: "x" }]);
    expect(build(turn).map((fragment) => fragment.id)).toEqual(build(turn).map((fragment) => fragment.id));
  });

  it("falls back to the session folder when a tool call has no path, and to nothing outside any project", () => {
    expect(build(rawTurn([{ name: "WebSearch", input: { query: "x" }, output: "y" }]))[1]!.candidateUnitKeys)
      .toEqual(["unit:id:repo-a"]);
    expect(build(rawTurn([{ name: "WebSearch", input: { query: "x" }, output: "y" }]), "/Users/me")[1]!.candidateUnitKeys)
      .toEqual([]);
  });

  it("keeps a tool result that matches no call as its own fragment", () => {
    const fragments = build(rawTurn(
      [{ id: "c1", name: "Read", input: { file_path: "/work/repo-a/a.ts" }, output: "x" }],
      [{ id: "c1", output: "x" }, { id: "orphan", name: "Bash", output: "permission denied", success: false }]
    ));
    expect(fragments.at(-1)).toMatchObject({ toolName: "Bash", output: "permission denied", isError: true });
  });

  it("treats an explicit error message as an error even without success=false", () => {
    const fragments = build(rawTurn([{ id: "c1", name: "Bash", input: { command: "ls" }, error: "exit code 1" }]));
    expect(fragments[1]).toMatchObject({ isError: true, output: "exit code 1" });
  });
});
