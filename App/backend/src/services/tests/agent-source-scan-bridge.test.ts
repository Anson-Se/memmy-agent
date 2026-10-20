import { describe, expect, it, vi } from "vitest";
import type { MemoryAgentSourceScanState } from "@memmy/local-api-contracts";
import type { AgentSourceScanClient } from "../../adapters/outbound/memory-client/types.js";
import { createAgentSourceScanBridge } from "../agent-source-scan-bridge.js";
import { createProgressBus } from "../progress-bus.js";
import { MemoryLayerError, MemoryLayerNetworkError } from "../../adapters/outbound/memory-client/errors.js";

const empty = (): MemoryAgentSourceScanState => ({ running: false, jobId: null, sourceId: null, mode: null, progress: null, startedAt: null, completedAt: null, error: null });
it("preserves Memory job identity, progress and failures in existing desktop events", async () => {
  let state = empty();
  const client = { status: vi.fn(async () => state), start: vi.fn(async () => {
    state = { ...state, running: true, jobId: "memory-1", sourceId: "all", progress: { sourceId: "all", phase: "scan", current: 0, total: 0 } };
    return { jobId: "memory-1" };
  }), cancel: vi.fn(async () => ({ ok: true })) } as unknown as AgentSourceScanClient;
  const bus = createProgressBus();
  const completed = vi.fn();
  bus.on("agent_source.scan_completed", completed);
  const bridge = createAgentSourceScanBridge(client, bus, 60_000);
  try {
    expect(await bridge.start({ sourceId: "all" })).toEqual({ jobId: "memory-1" });
    expect(await bridge.status()).toMatchObject({ active: true, progress: { jobId: "memory-1" } });
    state = { ...state, running: false, completedAt: new Date().toISOString(), error: "source unavailable" };
    expect(await bridge.status()).toMatchObject({ completion: { succeeded: false } });
    await bridge.status();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]?.[0].results[0].errors[0].reason).toBe("source unavailable");
  } finally { await bridge.dispose(); }
  expect(client.cancel).not.toHaveBeenCalled();
});
describe("transport failure", () => {
  it.each([
    new MemoryLayerError("memory_scan_upgrade_required", 503, "Update Memory"),
    new MemoryLayerNetworkError(new Error("connection refused"))
  ])("keeps status readable while refusing scans, then recovers when Memory returns", async (error) => {
    let unavailable = true;
    const bus = createProgressBus();
    const completed = vi.fn(); bus.on("agent_source.scan_completed", completed);
    const start = vi.fn(async () => ({ jobId: "new-job" }));
    const client = { status: async () => { if (unavailable) throw error; return empty(); }, start } as unknown as AgentSourceScanClient;
    const bridge = createAgentSourceScanBridge(client, bus, 60_000);
    try {
      expect(await bridge.status()).toMatchObject({ active: false, progress: null, unavailable: { code: expect.any(String) } });
      await expect(bridge.start({ sourceId: "all" })).rejects.toBe(error);
      expect(start).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      unavailable = false;
      expect(await bridge.status()).toEqual({ active: false, progress: null });
      expect(await bridge.start({ sourceId: "all" })).toEqual({ jobId: "new-job" });
    } finally { await bridge.dispose(); }
  });
  it("does not fall back or report successful completion", async () => {
    const bus = createProgressBus();
    const completed = vi.fn(); bus.on("agent_source.scan_completed", completed);
    const bridge = createAgentSourceScanBridge({ status: async () => { throw new Error("offline"); } } as unknown as AgentSourceScanClient, bus, 60_000);
    try { await expect(bridge.status()).rejects.toThrow("offline"); expect(completed).not.toHaveBeenCalled(); }
    finally { await bridge.dispose(); }
  });
});

it("maps every raw scan phase at the desktop boundary", async () => {
  let state = { ...empty(), running: true, jobId: "job", sourceId: "all" };
  const bus = createProgressBus();
  const progress = vi.fn(); bus.on("agent_source.scan_progress", progress);
  const bridge = createAgentSourceScanBridge({ status: async () => state } as AgentSourceScanClient, bus, 60_000);
  try {
    for (const phase of ["discover", "read", "redact", "emit", "prepare"] as const) {
      state = { ...state, progress: { sourceId: "all", phase, current: 1, total: 2 } };
      expect((await bridge.status()).progress?.phase).toBe("scan");
    }
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "scan" }));
  } finally { await bridge.dispose(); }
});

it("reports complete error counts and emits each retry once for SSE and polling", async () => {
  let state: MemoryAgentSourceScanState = { ...empty(), jobId: "same-job", attemptId: "first", sourceId: "all", completedAt: new Date().toISOString(),
    results: [{ sourceId: "fixture", emittedMessages: 1000, discoveredConversations: 500, skipped: 0, errors: [], errorCount: 1, detailsTruncated: true }] };
  const bus = createProgressBus(); const completed = vi.fn(); bus.on("agent_source.scan_completed", completed);
  const bridge = createAgentSourceScanBridge({ status: async () => state } as AgentSourceScanClient, bus, 60_000);
  try {
    expect((await bridge.status()).completion?.succeeded).toBe(false);
    await bridge.status();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]![0].succeeded).toBe(false);
    state = { ...state, attemptId: "second", results: [{ ...state.results![0]!, errorCount: 0 }] };
    expect((await bridge.status()).completion?.succeeded).toBe(true);
    await bridge.status();
    expect(completed).toHaveBeenCalledTimes(2);
    expect(completed.mock.calls[1]![0]).toMatchObject({ jobId: "same-job", attemptId: "second", succeeded: true });
  } finally { await bridge.dispose(); }
});
