import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface MacWeChatPythonDiscovery {
  developerDirectory(): string | null;
  xcodeApplications(): string[];
  executable(file: string): boolean;
}

const discovery: MacWeChatPythonDiscovery = {
  developerDirectory() {
    // xcode-select -p only reads the selection. Apple python3/xcrun shims can
    // show an install dialog on a clean Mac, so never invoke those to discover.
    const result = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 5_000 });
    const directory = result.stdout?.trim();
    return result.status === 0 && directory && path.isAbsolute(directory) ? directory : null;
  },
  xcodeApplications() {
    try {
      return fs.readdirSync("/Applications").filter(name => /^Xcode.*\.app$/u.test(name)).sort()
        .map(name => path.join("/Applications", name));
    } catch { return []; }
  },
  executable(file) {
    try {
      // A developer path that resolves back to Apple's installation shim is
      // still unsafe to launch when tools are absent.
      if (fs.realpathSync(file) === "/usr/bin/python3") return false;
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch { return false; }
  },
};

let cached: { expiresAt: number; python: string | null } | undefined;

/** Resolve a real developer Python without launching it or altering tool selection. */
export function resolveMacWeChatPython(probe: MacWeChatPythonDiscovery = discovery): string | null {
  if (probe === discovery && cached && cached.expiresAt > Date.now()
    && (!cached.python || probe.executable(cached.python))) return cached.python;
  const selected = probe.developerDirectory();
  const candidates = [
    ...(selected ? [path.join(selected, "usr/bin/python3")] : []),
    "/Library/Developer/CommandLineTools/usr/bin/python3",
    ...probe.xcodeApplications().map(app => path.join(app, "Contents/Developer/usr/bin/python3")),
  ];
  const python = [...new Set(candidates)].find(file => file !== "/usr/bin/python3" && probe.executable(file)) ?? null;
  if (probe === discovery) cached = { expiresAt: Date.now() + 5_000, python };
  return python;
}
