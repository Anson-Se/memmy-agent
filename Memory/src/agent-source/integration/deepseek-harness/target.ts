import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveDeepseekHarnessHomeDirectory } from "../../agent-paths.js";
import {
  removeMemmyResumeSkillDirectory,
  removeMemmySkillDirectory,
  replaceMemmyResumeSkillDirectory,
  replaceMemmySkillDirectory
} from "../skill-directory.js";
import { readMemmyMemoryServiceConfig } from "../memmy-runtime-config.js";
import {
  createDeepseekHarnessPluginPackageManifest,
  DEEPSEEK_HARNESS_PLUGIN_CLIENT,
  DEEPSEEK_HARNESS_PLUGIN_INDEX
} from "../templates/memmy-deepseek-harness-plugin.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import type { SkillTarget } from "../types.js";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../workspace-bridge/runtime-loader.js";

const TARGET_ID = "deepseek_harness";
const DISPLAY_NAME = "DeepSeek Harness";
const PATCH_START = "# memmy-memory plugin:start";
const PATCH_END = "# memmy-memory plugin:end";
const PLUGIN_PACKAGE_NAME = "@memmy/memmy-memory";
const PROCESS_PROBE_TIMEOUT_MS = 5_000;

export interface CreateDeepseekHarnessSkillTargetDeps {
  rootDirectory?: string;
  memmyConfigPath?: string;
  isDeepseekHarnessRunning?: () => Promise<boolean>;
}

export function createDeepseekHarnessSkillTarget(
  deps: CreateDeepseekHarnessSkillTargetDeps = {}
): SkillTarget {
  const rootDirectory = deps.rootDirectory ?? resolveDeepseekHarnessHomeDirectory();
  const memmyConfigPath = deps.memmyConfigPath ?? join(homedir(), ".memmy", "config.yaml");
  const isDeepseekHarnessRunning = deps.isDeepseekHarnessRunning ?? detectDeepseekHarnessProcess;
  const pluginDirectory = join(rootDirectory, "profiles", "node_modules", "@memmy", "memmy-memory");
  const patchPath = join(rootDirectory, "cordis.patch.yml");

  return {
    targetId: TARGET_ID,
    displayName: DISPLAY_NAME,

    async resolveRootDirectory() {
      return resolveExistingDirectory(rootDirectory);
    },

    async install(manifest) {
      if (!(await this.resolveRootDirectory())) {
        throw new Error("DeepSeek Harness is not installed or its directory is unavailable");
      }
      await replaceMemmySkillDirectory(rootDirectory, manifest);
      await replaceMemmyResumeSkillDirectory(rootDirectory, TARGET_ID);
    },

    async uninstall() {
      await removeMemmyResumeSkillDirectory(rootDirectory);
      await removeMemmySkillDirectory(rootDirectory);
    },

    async isInstalled() {
      if (!(await this.resolveRootDirectory())) return false;
      const patch = await readTextFile(patchPath);
      const pluginSource = await readTextFile(join(pluginDirectory, "index.mjs"));
      const clientSource = await readTextFile(join(pluginDirectory, "client.js"));
      const packageSource = await readTextFile(join(pluginDirectory, "package.json"));
      const bridgeSource = await readTextFile(join(pluginDirectory, "memmy-workspace-bridge.mjs"));
      return patch.includes("name: " + yamlString(PLUGIN_PACKAGE_NAME)) &&
        pluginSource === DEEPSEEK_HARNESS_PLUGIN_INDEX &&
        clientSource === DEEPSEEK_HARNESS_PLUGIN_CLIENT &&
        packageSource === JSON.stringify(createDeepseekHarnessPluginPackageManifest(), null, 2) + "\n" &&
        bridgeSource === await loadMemmyWorkspaceBridgeRuntimeAsset();
    },

    async installPlugin() {
      if (!(await this.resolveRootDirectory())) {
        throw new Error("DeepSeek Harness is not installed or its directory is unavailable");
      }
      const generatedFiles: Array<readonly [string, string]> = [
        [join(pluginDirectory, "package.json"), JSON.stringify(createDeepseekHarnessPluginPackageManifest(), null, 2) + "\n"],
        [join(pluginDirectory, "index.mjs"), DEEPSEEK_HARNESS_PLUGIN_INDEX],
        [join(pluginDirectory, "client.js"), DEEPSEEK_HARNESS_PLUGIN_CLIENT],
        [join(pluginDirectory, "memmy-workspace-bridge.mjs"), await loadMemmyWorkspaceBridgeRuntimeAsset()],
        [
          join(pluginDirectory, "memmy-memory-config.json"),
          JSON.stringify({ memmy_config_path: memmyConfigPath, ...(await readMemmyMemoryServiceConfig(memmyConfigPath)) }, null, 2) + "\n"
        ]
      ];
      const currentPatch = await readTextFile(patchPath);
      const nextPatch = renderPatchedContent(currentPatch, renderPluginPatch(memmyConfigPath));
      const generatedFileContents = await Promise.all(generatedFiles.map(([filePath]) => readTextFile(filePath)));
      const patchNeedsUpdate = normalizeLineEndings(nextPatch) !== normalizeLineEndings(currentPatch);
      const pluginNeedsUpdate = patchNeedsUpdate || generatedFiles.some(([, content], index) => (
        content !== generatedFileContents[index]
      ));
      if (pluginNeedsUpdate && await isDeepseekHarnessRunning()) {
        throw new Error("DeepSeek Harness is running. Quit it, retry the plugin installation, then restart DeepSeek Harness.");
      }
      for (const [filePath, content] of generatedFiles) {
        await writeFileIfChanged(filePath, content);
      }
      if (patchNeedsUpdate) await writeFileAtomically(patchPath, nextPatch);
      await replaceMemmySkillDirectory(rootDirectory, renderMemmyPluginSkillManifest(TARGET_ID));
      await replaceMemmyResumeSkillDirectory(rootDirectory, TARGET_ID);
    },

    async uninstallPlugin() {
      if (!(await this.resolveRootDirectory())) return;
      await removePatch(patchPath);
      await rm(pluginDirectory, { recursive: true, force: true });
      await removeMemmyResumeSkillDirectory(rootDirectory);
      await removeMemmySkillDirectory(rootDirectory);
    }
  };
}

function renderPluginPatch(memmyConfigPath: string): string {
  return [
    PATCH_START,
    "- insert:",
    "    - id: memmy-memory",
    "      name: " + yamlString(PLUGIN_PACKAGE_NAME),
    "      config:",
    "        memmyConfigPath: " + yamlString(memmyConfigPath),
    PATCH_END
  ].join("\n");
}

function renderPatchedContent(current: string, block: string): string {
  const existing = removePatchBlock(current);
  const lines = existing.split(/\r?\n/u);
  const contentLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  const base = contentLines.length === 1 && contentLines[0] === "[]"
    ? lines.filter((line) => line.trim() !== "[]").join("\n").trimEnd()
    : existing.trimEnd();
  return [base, block, ""].filter((part, index) => part || index === 2).join("\n");
}

async function removePatch(filePath: string): Promise<void> {
  const existing = await readTextFile(filePath);
  if (!existing.includes(PATCH_START)) return;
  const without = removePatchBlock(existing).trimEnd();
  const hasEntries = without.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  await writeFileIfChanged(filePath, without + (without ? "\n" : "") + (hasEntries ? "" : "[]\n"));
}

function removePatchBlock(value: string): string {
  let result = value;
  while (true) {
    const start = result.indexOf(PATCH_START);
    if (start < 0) return result;
    const end = result.indexOf(PATCH_END, start);
    if (end < 0) throw new Error("Invalid Memmy patch block starting at " + PATCH_START);
    const lineEnd = result.indexOf("\n", end + PATCH_END.length);
    const after = lineEnd < 0 ? result.length : lineEnd + 1;
    result = result.slice(0, start).trimEnd() + "\n" + result.slice(after).trimStart();
  }
}

function yamlString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function resolveExistingDirectory(directory: string): Promise<string | null> {
  try {
    return (await stat(directory)).isDirectory() ? directory : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    "." + basename(filePath) + "." + process.pid + "." + Date.now() + "." + Math.random().toString(16).slice(2) + ".tmp"
  );
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  if (await readTextFile(filePath) === content) return;
  await writeFileAtomically(filePath, content);
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

async function detectDeepseekHarnessProcess(): Promise<boolean> {
  if (process.platform === "win32") {
    return commandOutputMatches("tasklist", ["/FO", "CSV", "/NH"], /DeepSeek Harness(?: Helper)?\.exe/iu);
  }
  return commandOutputMatches("pgrep", ["-f", deepseekHarnessProcessPattern(process.platform)], /\S/u, 1);
}

export function deepseekHarnessProcessPattern(platform: NodeJS.Platform): string {
  const hostEntry = "/dsh-desktop-host/(lib/)?(cli|index|main)\\.js([[:space:]]|$)";
  if (platform === "darwin") {
    const appExecutable = "(^|/)DeepSeek Harness( Helper)?(\\.app/Contents/MacOS/DeepSeek Harness( Helper)?)?([[:space:]]|$)";
    return appExecutable + "|(^|/)dsh-desktop([[:space:]]|$)|" + hostEntry;
  }
  return "(^|/)(deepseek-harness|dsh-desktop)([[:space:]]|$)|" + hostEntry;
}

function commandOutputMatches(
  command: string,
  args: string[],
  pattern: RegExp,
  noMatchExitCode?: number
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: PROCESS_PROBE_TIMEOUT_MS
    }, (error, stdout) => {
      if (!error) {
        resolve(pattern.test(stdout));
        return;
      }
      if (noMatchExitCode !== undefined && isNodeError(error) && Number(error.code) === noMatchExitCode) {
        resolve(false);
        return;
      }
      const probeError = new Error(
        "Could not determine whether DeepSeek Harness is running. Quit DeepSeek Harness and retry the plugin installation."
      );
      (probeError as Error & { cause?: unknown }).cause = error;
      reject(probeError);
    });
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
