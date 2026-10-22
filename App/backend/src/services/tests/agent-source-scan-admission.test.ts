import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceRegistry } from "../../adapters/outbound/agent-source/source-registry.js";
import type { SourceAdapter } from "../../adapters/outbound/agent-source/types.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import { createAgentSourceService, type AgentSourceService } from "../agent-source-service.js";
import { createIngestionService } from "../ingestion-service.js";

const roots: string[] = [], stores: AppStateStore[] = [];
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function harness() {
  const root = mkdtempSync(join(tmpdir(), "source-scan-admission-")); roots.push(root);
  const store = createAppStateStore({ databasePath: join(root, "app.sqlite") }); stores.push(store);
  const client = createMockMemoryClient();
  const entered = deferred(), finishFirst = deferred();
  let calls = 0, active = 0, maxActive = 0;
  const adapter: SourceAdapter = {
    descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: root },
    async detect() { return true; },
    async *scan() {
      calls++; active++; maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) { entered.resolve(); await finishFirst.promise; }
      } finally { active--; }
    }
  };
  function service(persistent = false, adapters = [adapter]) {
    return createAgentSourceService({ sourceRegistry: createSourceRegistry(adapters),
      agentSourceRepository: store.repositories.agentSources, memoryClient: client,
      ingestionService: createIngestionService({ memoryClient: client, agentSourceRepository: store.repositories.agentSources }),
      skillDistributionService: { install: async () => undefined, uninstall: async () => undefined,
        installPlugin: async () => undefined, uninstallPlugin: async () => undefined },
      ...(persistent ? { scanStoreDirectory: join(root, "scans") } : {}) });
  }
  return { service, entered, finishFirst, adapter, calls: () => calls, maxActive: () => maxActive };
}
type Entry = "collectOne" | "collectAll" | "scanOne" | "scanAll";
function invoke(service: AgentSourceService, entry: Entry, signal?: AbortSignal) {
  const options = { mode: "full" as const, signal };
  return entry === "collectOne" ? service.collectOne("codex", options)
    : entry === "scanOne" ? service.scanOne("codex", options)
      : entry === "collectAll" ? service.collectAll(options) : service.scanAll(options);
}

describe("per-source backend scan admission", () => {
  it.each([
    ["collectOne", "collectOne", false], ["scanOne", "collectOne", false],
    ["collectAll", "scanOne", false], ["scanAll", "collectAll", false],
    ["scanOne", "collectOne", true], ["scanAll", "scanOne", true]
  ] as const)("serializes %s against %s (persistent=%s) across service instances", async (firstEntry, nextEntry, persistent) => {
    const h = harness();
    const first = invoke(h.service(persistent), firstEntry);
    await h.entered.promise;
    const second = invoke(h.service(), nextEntry);
    await nextTurn();
    const callsBeforeRelease = h.calls();
    h.finishFirst.resolve();
    await Promise.all([first, second]);
    expect(callsBeforeRelease).toBe(1);
    expect(h.calls()).toBe(2);
    expect(h.maxActive()).toBe(1);
  });

  it("allows another source to scan while the first source holds its permit", async () => {
    const h = harness(); let otherStarted = false;
    const other: SourceAdapter = { descriptor: { ...h.adapter.descriptor, sourceId: "cursor" },
      detect: async () => true, async *scan() { otherStarted = true; } };
    const service = h.service(false, [h.adapter, other]);
    const first = service.collectOne("codex", { mode: "full" }); await h.entered.promise;
    await service.collectOne("cursor", { mode: "full" });
    const beforeRelease = otherStarted;
    h.finishFirst.resolve(); await first;
    expect(beforeRelease).toBe(true);
  });

  it.each([false, true])("canceling a waiting request does not release or abort the current holder (persistent=%s)", async persistent => {
    const h = harness(), service = h.service();
    const first = service.collectOne("codex", { mode: "full" }); await h.entered.promise;
    const controller = new AbortController();
    const canceled = invoke(h.service(persistent), persistent ? "scanOne" : "collectOne", controller.signal).then(() => "completed", error => error);
    await nextTurn(); controller.abort(new Error("cancel waiting scan"));
    const canceledResult = await canceled;
    const third = service.collectOne("codex", { mode: "full" }); await nextTurn();
    const callsBeforeRelease = h.calls();
    h.finishFirst.resolve(); await Promise.all([first, third]);
    expect(canceledResult).toBeInstanceOf(Error);
    expect(canceledResult.message).toBe("cancel waiting scan");
    expect(callsBeforeRelease).toBe(1);
    expect(h.calls()).toBe(2);
    expect(h.maxActive()).toBe(1);
  });

  it("does not reserve all sources while a persistent scan-all is staging one source", async () => {
    const h = harness(); let otherCalls = 0;
    const other: SourceAdapter = { descriptor: { ...h.adapter.descriptor, sourceId: "cursor" },
      detect: async () => true, async *scan() { otherCalls++; } };
    const all = h.service(true, [h.adapter, other]).scanAll({ mode: "full" }); await h.entered.promise;
    await h.service(false, [other]).collectOne("cursor", { mode: "full" });
    const beforeRelease = otherCalls;
    h.finishFirst.resolve(); await all;
    expect(beforeRelease).toBe(1);
    expect(otherCalls).toBe(2);
  });

  it("does not start adapter work for an already canceled request", async () => {
    const h = harness(), controller = new AbortController(); controller.abort(new Error("already canceled"));
    // This adapter has no blocking first call, so a missing cancellation check cannot hang the test.
    let calls = 0;
    const adapter: SourceAdapter = { ...h.adapter, async *scan() { calls++; } };
    const result = await h.service(false, [adapter]).collectOne("codex", { signal: controller.signal }).then(() => "completed", error => error);
    expect(result).toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });

  it("releases the source after adapter failure and after a progress callback throws", async () => {
    const h = harness(); let calls = 0;
    const adapter: SourceAdapter = { ...h.adapter, async *scan() { calls++; if (calls === 1) throw new Error("scan failed"); } };
    const service = h.service(false, [adapter]);
    const failed = await service.collectOne("codex", { mode: "full" });
    expect(failed.errors).toContainEqual({ conversationId: "scan", reason: "scan failed" });
    await expect(service.collectOne("codex", { onProgress() { throw new Error("progress failed"); } })).rejects.toThrow("progress failed");
    await expect(service.collectOne("codex", { mode: "full" })).resolves.toMatchObject({ errors: [] });
    expect(calls).toBe(2);
  });
});
