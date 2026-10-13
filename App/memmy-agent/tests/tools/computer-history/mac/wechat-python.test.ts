import { describe, expect, it, vi } from "vitest";
import { resolveMacWeChatPython, type MacWeChatPythonDiscovery } from "../../../../src/tools/computer-history/mac/wechat-python.js";

function discovery(executables: string[], selected: string | null = null): MacWeChatPythonDiscovery {
  return {
    developerDirectory: vi.fn(() => selected),
    xcodeApplications: vi.fn(() => ["/Applications/Xcode.app"]),
    executable: vi.fn(file => executables.includes(file)),
  };
}

describe("WeChat macOS Python discovery", () => {
  it("returns unavailable on a clean Mac without invoking the Apple python3 shim", () => {
    const probe = discovery(["/usr/bin/python3"]);
    expect(resolveMacWeChatPython(probe)).toBeNull();
    expect(probe.executable).not.toHaveBeenCalledWith("/usr/bin/python3");
  });
  it("prefers the selected developer directory", () => {
    const selected = "/Applications/Xcode-beta.app/Contents/Developer";
    const python = `${selected}/usr/bin/python3`;
    expect(resolveMacWeChatPython(discovery([python, "/Library/Developer/CommandLineTools/usr/bin/python3"], selected))).toBe(python);
  });
  it("uses installed tools when the selected directory has gone away", () => {
    const python = "/Applications/Xcode.app/Contents/Developer/usr/bin/python3";
    expect(resolveMacWeChatPython(discovery([python], "/removed/tools"))).toBe(python);
  });
});
