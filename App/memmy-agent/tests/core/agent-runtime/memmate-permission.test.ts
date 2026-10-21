import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeMemmateTool, createMemmatePermissionScope, withMemmatePermission } from "../../../src/core/agent-runtime/memmate-permission.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { ToolCallRequest } from "../../../src/providers/base.js";
import { createApp } from "../../../src/entrypoints/openai-like-api/server.js";

const credential = { url: "http://127.0.0.1:12345/authorize", token: "a".repeat(64) };
const scope = () => createMemmatePermissionScope(credential, new AbortController().signal);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("mandatory MemMate permission", () => {
  it("uses the Host web result without executing any native network tool", async () => {
    vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", result: "approved page" })));
    const execute = vi.fn();
    const results = await withMemmatePermission(scope(), () => new AgentRunner().executeTools(new AgentRunSpec({
      tools: { execute, get: () => ({ readOnly: true }) } as any
    }), [new ToolCallRequest({ id: "web", name: "web_fetch", arguments: { url: "https://example.com" } })]));
    expect(execute).not.toHaveBeenCalled(); expect(results[0].result).toContain("approved page");
  });
  it("does not fall back to direct networking when the Host omits its web result", async () => {
    vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow" })));
    await expect(withMemmatePermission(scope(), () => authorizeMemmateTool("web_fetch", { url: "https://example.com" }))).rejects.toThrow("result is missing");
  });
  it("blocks managed tools without an authenticated request context", async () => {
    vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1");
    await expect(authorizeMemmateTool("write_file", {})).rejects.toThrow("context is missing");
  });
  it("rejects non-local approval endpoints", () => {
    for (const url of ["https://evil.example/authorize", "http://localhost:123/authorize", "http://127.0.0.1:123/authorize?redirect=x"]) {
      expect(() => createMemmatePermissionScope({ ...credential, url }, new AbortController().signal)).toThrow();
    }
  });
  it.each([true, false])("waits before the %s direct-execute branch and runs only approved normalized arguments", async direct => {
    vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1");
    let reply!: (value: Response) => void;
    const received: any[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, init) => { received.push(JSON.parse(init.body)); return new Promise(resolve => { reply = resolve; }); }));
    const execute = vi.fn(async (args: any) => args.path);
    const original = { path: "before.txt" };
    const tools = { get: () => ({ readOnly: false }), prepareCall: () => [direct ? { execute } : null, original, null], execute: (_name: string, args: any) => execute(args) };
    const pending = withMemmatePermission(scope(), () => new AgentRunner().executeTools(new AgentRunSpec({ tools: tools as any }), [new ToolCallRequest({ id: "one", name: "write_file", arguments: {} })]));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(execute).not.toHaveBeenCalled(); original.path = "after.txt";
    reply(Response.json({ decision: "allow" }));
    await pending;
    expect(execute).toHaveBeenCalledWith({ path: path.resolve("before.txt") }, ...(direct ? [expect.anything()] : []));
  });
  it.each(["deny", "allow_always", "unavailable"])("never executes on %s", async decision => {
    vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1");
    vi.stubGlobal("fetch", vi.fn(async () => decision === "unavailable" ? Promise.reject(new Error("offline")) : Response.json({ decision })));
    const execute = vi.fn();
    const results = await withMemmatePermission(scope(), () => new AgentRunner().executeTools(new AgentRunSpec({
      tools: { execute, get: () => ({ readOnly: true }) } as any
    }), [new ToolCallRequest({ id: "one", name: "read_file", arguments: { path: "a" } })]));
    expect(execute).not.toHaveBeenCalled(); expect(results[0].event.status).toBe("error");
  });
  it("checks runtime authentication before parsing attachments or invoking the agent", async () => {
    vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1"); vi.stubEnv("MEMMATE_RUNTIME_TOKEN", "b".repeat(64));
    const loop = vi.fn(); const app = createApp(loop);
    const response = await app.fetch(new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", body: "invalid json" }));
    expect(response.status).toBe(401); expect(loop).not.toHaveBeenCalled();
  });
  it("carries the verified request scope to tool execution and ends it with the response", async () => {
    vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1"); vi.stubEnv("MEMMATE_RUNTIME_TOKEN", "b".repeat(64));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow" })));
    let detached!: () => Promise<unknown>;
    const app = createApp(async () => {
      // AsyncResource preserves the request scope for deferred work, which must expire.
      const { AsyncResource } = await import("node:async_hooks");
      detached = AsyncResource.bind(() => authorizeMemmateTool("read_file", { path: "a" }));
      await authorizeMemmateTool("read_file", { path: "a" }); return "ok";
    });
    const result = await app.fetch(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-memmate-runtime-token": "b".repeat(64) },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }], memmate_permission: credential })
    }));
    expect(result.status).toBe(200); await expect(detached()).rejects.toThrow("run has ended");
  });
});
