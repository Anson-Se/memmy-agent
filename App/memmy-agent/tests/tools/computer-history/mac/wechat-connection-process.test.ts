import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ConnectionChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn();
}
const state = vi.hoisted(() => ({ children: [] as ConnectionChild[], python: "/developer/python3" as string | null,
  privateStateReady: true,
  windowsPython: { executable: "C:\\Memmy\\python\\python.exe", args: ["-I", "-B", "-X", "utf8"] } as { executable: string; args: string[] } | null }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(() => {
    const child = new ConnectionChild();
    state.children.push(child);
    return child;
  }),
}));
vi.mock("../../../../src/tools/computer-history/mac/wechat-python.js", () => ({ resolveMacWeChatPython: vi.fn(() => state.python) }));
vi.mock("../../../../src/tools/computer-history/win/python-runtime.js", () => ({ resolveWindowsWeChatPython: vi.fn(() => state.windowsPython) }));
vi.mock("../../../../src/tools/computer-history/win/private-files.js", () => ({
  prepareWindowsWeChatState: vi.fn(() => {
    if (!state.privateStateReady || !state.windowsPython) throw new Error("fixture private state is unavailable");
  }),
  validateWindowsWeChatConsent: vi.fn(() => state.privateStateReady),
}));
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

let root: string;
let service: ComputerHistoryDemoService;
beforeEach(() => {
  state.children.length = 0;
  state.python = "/developer/python3";
  state.privateStateReady = true;
  state.windowsPython = { executable: "C:\\Memmy\\python\\python.exe", args: ["-I", "-B", "-X", "utf8"] };
  vi.mocked(spawn).mockClear();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-process-"));
  const library = path.join(root, "sqlcipher.dylib");
  fs.writeFileSync(library, "inert fixture: never loaded");
  vi.stubEnv("MEMMY_SQLCIPHER_LIBRARY", library);
  service = new ComputerHistoryDemoService({
    historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"),
    weChatConsentFile: path.join(root, "wechat", "consent.json"),
  });
});
afterEach(async () => {
  await service.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function connect() {
  service.setWeChatChatAccess(true);
  expect(service.connectWeChat().wechat?.connection).toBe("connecting");
  return state.children.at(-1)!;
}

describe("WeChat connection process diagnostics", () => {
  it("shares a running connection instead of launching another helper for repeated requests", () => {
    const child = connect();
    expect(service.connectWeChat().wechat?.connection).toBe("connecting");
    expect(state.children).toEqual([child]);
  });

  it("keeps a private-storage failure distinct from logout and never retries it from a snapshot", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "preparing_wechat_data" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_private_storage_unsafe_path" }) + "\n");
    child.emit("close", 2, null);
    for (let i = 0; i < 3; i++) {
      expect(service.snapshot().wechat).toMatchObject({
        connection: "error", error: "wechat_private_storage_unsafe_path", phase: null,
      });
    }
    expect(state.children).toEqual([child]);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "wechat_private_storage_unsafe_path", phase: "preparing_wechat_data" });
  });

  it.each(["wechat_data_access_interrupted", "wechat_data_access_timeout"])(
    "retains the helper-reported %s and bounded metadata without retrying", (category) => {
      const child = connect();
      const diagnostic = { operation: "scandir_next", source: "container", errno: category.endsWith("timeout") ? 60 : 4 };
      child.stdout.write(JSON.stringify({ event: "preparing_wechat_data" }) + "\n");
      child.stdout.write(JSON.stringify({ event: "connection_error", category, diagnostic }) + "\n");
      // A duplicate parent error must not overwrite the original diagnostic or phase.
      child.stdout.write(JSON.stringify({ event: "connection_error", category }) + "\n");
      child.emit("close", 2, null);
      for (let i = 0; i < 3; i++) expect(service.snapshot().wechat?.error).toBe(category);
      expect(state.children).toEqual([child]);
      const file = path.join(root, "wechat", "last-connection-error.json");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(saved).toEqual({ category, phase: "preparing_wechat_data", diagnostic, failedAt: expect.any(String) });
      expect(fs.statSync(file).mode & 0o077).toBe(0);
    },
  );

  it("permits a bounded metadata diagnostic without an errno", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_data_access_timeout",
      diagnostic: { operation: "open", source: "state" } }) + "\n");
    child.emit("close", 2, null);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ diagnostic: { operation: "open", source: "state" } });
  });

  it.each([
    { label: "an extra filename", diagnostic: { operation: "lstat", source: "container", filename: "private.db" } },
    { label: "an extra path", diagnostic: { operation: "lstat", source: "container", path: "/private/chat.db" } },
    { label: "a raw error message", diagnostic: { operation: "open", source: "container", message: "denied /private/chat.db" } },
    { label: "a path as operation", diagnostic: { operation: "/private/chat.db", source: "container" } },
    { label: "a path as source", diagnostic: { operation: "lstat", source: "/private/chat.db" } },
    { label: "an unknown operation", diagnostic: { operation: "read_chat", source: "container" } },
    { label: "an unknown source", diagnostic: { operation: "lstat", source: "other_app" } },
    { label: "a nonnumeric errno", diagnostic: { operation: "lstat", source: "container", errno: "EINTR: private.db" } },
    { label: "a negative errno", diagnostic: { operation: "lstat", source: "container", errno: -1 } },
    { label: "an excessive errno", diagnostic: { operation: "lstat", source: "container", errno: 4096 } },
    { label: "a fractional errno", diagnostic: { operation: "lstat", source: "container", errno: 4.5 } },
    { label: "a missing source", diagnostic: { operation: "lstat" } },
    { label: "a missing operation", diagnostic: { source: "container" } },
    { label: "an array", diagnostic: ["lstat", "container"] },
    { label: "a raw string", diagnostic: "/private/chat.db" },
  ])("drops diagnostics containing $label while retaining the failure category", ({ diagnostic }) => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_data_access_interrupted", diagnostic }) + "\n");
    child.emit("close", 2, null);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8"));
    expect(saved.category).toBe("wechat_data_access_interrupted");
    expect(saved).not.toHaveProperty("diagnostic");
    expect(JSON.stringify(saved)).not.toMatch(/private[.]db|chat[.]db|other_app|read_chat/u);
  });

  it("does not attach metadata diagnostics to unrelated helper failures", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_login_required",
      diagnostic: { operation: "lstat", source: "container", errno: 4 } }) + "\n");
    child.emit("close", 2, null);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .not.toHaveProperty("diagnostic");
  });

  it("does not infer a data access category from a Python process interruption", () => {
    const child = connect();
    child.emit("close", null, "SIGINT");
    expect(service.snapshot().wechat?.error).toBe("connection_process_crashed");
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "connection_process_crashed" });
  });

  it("rejects Windows consent with a friendly 503 before enabling an unavailable local reader", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    state.windowsPython = null;
    let thrown: unknown;
    try { service.setWeChatChatAccess(true); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ status: 503, message: "Windows WeChat local reader is unavailable" });
    expect(service.snapshot().wechat?.enabled).toBe(false);
    expect(fs.existsSync(path.join(root, "wechat", "consent.json"))).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a missing bundled Windows interpreter before trying any system launcher", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    service.setWeChatChatAccess(true);
    state.windowsPython = null;
    expect(service.connectWeChat().wechat?.error).toBe("python_unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps an existing disabled Windows consent unchanged when its NTFS check fails", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    service.setWeChatChatAccess(false);
    const consentFile = path.join(root, "wechat", "consent.json");
    const previous = fs.readFileSync(consentFile, "utf8");
    state.privateStateReady = false;
    expect(() => service.setWeChatChatAccess(true)).toThrow("Windows WeChat local reader is unavailable");
    expect(fs.readFileSync(consentFile, "utf8")).toBe(previous);
    expect(service.snapshot().wechat?.enabled).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps the Windows reason and its diagnostic when no key matches", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    // Windows has no POSIX owner, which used to drop every diagnostic.
    const getuid = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      const child = connect();
      child.stdout.write(JSON.stringify({ event: "capture_finished", verified_databases: 0 }) + "\n");
      child.stdout.write(JSON.stringify({ event: "capture_error", category: "weixin_keys_not_found" }) + "\n");
      child.emit("close", 3, null);
      expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "weixin_keys_not_found" });
      expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
        .toMatchObject({ category: "weixin_keys_not_found", phase: "capture_finished" });
    } finally {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true });
    }
  });

  it("launches Windows WeChat with the private interpreter and isolated UTF-8 arguments", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    connect();
    expect(spawn).toHaveBeenCalledWith(state.windowsPython!.executable, [
      ...state.windowsPython!.args, expect.stringMatching(/weixin_keys[.]py$/u),
      "--output", path.join(root, "wechat", "keys.json"),
      "--consent-file", path.join(root, "wechat", "consent.json"),
    ], { stdio: ["pipe", "pipe", "pipe"] });
    state.children.at(-1)!.emit("close", 2, null);
  });

  it("reports missing Mac developer tools before launching Python or changing WeChat", async () => {
    state.python = null;
    await expect(service.prepareWeChatReader()).resolves.toMatchObject({ ready: false, error: "lldb_unavailable" });
    service.setWeChatChatAccess(true);
    expect(service.connectWeChat().wechat?.error).toBe("lldb_unavailable");
    expect(state.children).toHaveLength(0);
  });

  it("checks the managed reader independently of consent and coalesces concurrent preparation", async () => {
    const first = service.prepareWeChatReader();
    const second = service.prepareWeChatReader();
    expect(second).toBe(first);
    const child = state.children.at(-1)!;
    const appPath = path.join(root, "wechat", "connection-helper", "Memmy WeChat Reader.app");
    child.stdout.write(JSON.stringify({ event: "permission_prepared", ready: false, appPath,
      error: "wechat_data_access_required", probePid: 123 }) + "\n");
    child.emit("close", 0, null);
    await expect(first).resolves.toEqual({ ready: false, appPath, error: "wechat_data_access_required" });
    expect(service.snapshot().wechat?.enabled).toBe(false);
    expect(state.children).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "wechat_data_access_required", phase: "reader_permission_check" });
  });

  it("does not trust a permission result for another application path", async () => {
    const pending = service.prepareWeChatReader();
    const child = state.children.at(-1)!;
    child.stdout.write(JSON.stringify({ ready: true, appPath: "/Applications/Other.app", error: null }));
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual({ ready: false, appPath: null, error: "wechat_permission_helper_unavailable" });
    expect(service.snapshot().wechat?.enabled).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "wechat_permission_helper_unavailable", phase: "reader_permission_check" });
  });

  it("does not approve a reader whose preparation process failed after reporting success", async () => {
    const pending = service.prepareWeChatReader();
    const child = state.children.at(-1)!;
    child.stdout.write(JSON.stringify({ ready: true,
      appPath: path.join(root, "wechat", "connection-helper", "Memmy WeChat Reader.app"), error: null }));
    child.emit("close", 2, null);
    await expect(pending).resolves.toMatchObject({ ready: false, error: "wechat_permission_helper_unavailable" });
  });

  it("retains a safe failure category after the UI revokes incomplete chat access", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "awaiting_wechat_login" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "capture_error", category: "wechat_data_access_required" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "original_reopened", success: true }) + "\n");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_data_access_required" }) + "\n");
    child.emit("close", 2, null);
    service.setWeChatChatAccess(false);
    expect(service.snapshot().wechat?.error).toBeNull();
    const info = fs.statSync(path.join(root, "wechat", "last-connection-error.json"));
    expect(info.mode & 0o077).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "wechat_data_access_required", phase: "awaiting_wechat_login" });
  });
  it("waits for terminal status after exit and parses a final line without a newline", () => {
    const child = connect();
    child.emit("exit", 2, null);
    expect(service.snapshot().wechat?.connection).toBe("connecting");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "key_capture_crashed" }));
    child.emit("close", 2, null);
    expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "key_capture_crashed", phase: null });
  });

  it("keeps the capture cause when a legacy parent reports only key_capture_failed", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "capture_error", category: "lldb_unavailable" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "key_capture_failed" }) + "\n");
    child.emit("close", 2, null);
    expect(service.snapshot().wechat?.error).toBe("lldb_unavailable");
  });

  it("distinguishes a Python process signal from an ordinary connection failure", () => {
    const child = connect();
    child.emit("close", null, "SIGBUS");
    expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "connection_process_crashed" });
  });

  it("reports an interpreter launch failure and permits an explicit retry", () => {
    connect().emit("error", new Error("ENOENT"));
    expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "connection_process_failed", phase: null });
    connect().emit("close", 2, null);
    expect(state.children).toHaveLength(2);
  });

  it("keeps chat access disabled if the user revokes it before the helper closes", () => {
    const child = connect();
    service.setWeChatChatAccess(false);
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "key_capture_crashed" }) + "\n");
    child.emit("close", 2, null);
    expect(service.snapshot().wechat).toEqual({ enabled: false, connection: "disabled", phase: null, error: null });
  });
});
