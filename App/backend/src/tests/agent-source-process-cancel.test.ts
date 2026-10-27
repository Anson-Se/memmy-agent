import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import { registerAgentSourceRoutes } from "../adapters/inbound/local-api/routes/agent-sources.js";
import { createAppStateStore } from "../infrastructure/app-state-store/index.js";
import { createProgressBus } from "../services/progress-bus.js";
import type { AgentSourceService } from "../services/agent-source-service.js";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));

it("shares process cancellation, ignores late messages and waits for child close before accepting a replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "memmy-child-cancel-"));
  const store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn(), kill: vi.fn() });
  vi.mocked(fork).mockReturnValue(child as never);
  const app = Fastify();
  const progressBus = createProgressBus();
  const emit = vi.spyOn(progressBus, "emit");
  const control = registerAgentSourceRoutes(app, {
    agentSources: {} as AgentSourceService,
    agentSourceAutoInject: { runOnce: vi.fn() },
    progressBus, permissionManager: { async canScanAgentSource() { return true; } },
    authenticateRuntimeToken: async () => {}, scanProcess: { databasePath: store.databasePath }
  });
  try {
    const start = await app.inject({ method: "POST", url: "/api/agent-sources/scan", payload: { sourceId: "all" } });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
    let completed = 0;
    const first = control.cancel().then(() => { completed += 1; });
    const second = control.cancel().then(() => { completed += 1; });
    expect(child.send).toHaveBeenCalledWith({ type: "abort" });
    expect((await app.inject({ method: "POST", url: "/api/agent-sources/scan", payload: { sourceId: "all" } })).statusCode).toBe(409);
    emit.mockClear();
    child.emit("message", { type: "progress", progress: { sourceId: "all", phase: "scan", current: 42, total: 100 } });
    child.emit("message", { type: "completed", results: [] });
    expect(emit).not.toHaveBeenCalled();
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(completed).toBe(0);
    child.emit("close", 0, null);
    await Promise.all([first, second]);
    expect(completed).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/agent-sources/scan/status" })).json()).toEqual({ active: false, progress: null });
    expect(emit).toHaveBeenCalledWith("agent_source.scan_completed", { jobId: start.json().jobId, sourceId: "all", results: [] });
  } finally { child.emit("close", 0, null); await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
