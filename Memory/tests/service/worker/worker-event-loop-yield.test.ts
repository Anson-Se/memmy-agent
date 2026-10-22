import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { WorkerConcurrencyController, type WorkerProviderDescriptor } from "../../../src/service/worker/worker-concurrency.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const resources: Array<{ root: string; db: MemoryDb; runner: WorkerRunner; concurrency: WorkerConcurrencyController }> = [];
const total = 200;
function harness() {
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-event-loop-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db), concurrency = new WorkerConcurrencyController({}, {});
  const processed: string[] = [];
  let peakJobs = 0;
  const unexpected = () => { throw new Error("Unexpected model or startup operation"); };
  const deps: WorkerRunnerDeps = {
    repos, concurrency, scheduling: { algorithm: "wrr" }, schedulingShadow: { enabled: false },
    embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: false }, embeddingRetryWorkerId: "event-loop-test",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "event-loop-test", runWorkerNoWrite: async () => unexpected(),
    restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob: unexpected, enqueueEmbeddingRetry: unexpected, appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob: async job => {
      peakJobs = Math.max(peakJobs, concurrency.snapshot().activeJobs);
      processed.push(job.id);
      repos.runtime.setKv("event-loop.database-progress", { id: job.id }, new Date().toISOString());
    } },
    embeddingJobs: { prepareEmbeddingJob: unexpected, applyEmbeddingVector: unexpected,
      persistEmbeddingVector: unexpected, enqueueEmbeddingRetryAfterFailure: () => false }
  };
  const runner = new WorkerRunner(deps);
  resources.push({ root, db, runner, concurrency });
  function job(id: string, type: EvolutionJobRecord["jobType"] = "l2_association", target = id, delayed = false) {
    const at = new Date().toISOString();
    const queued = repos.runtime.enqueueJob({ id, jobType: type, userId: "event-loop-user", targetMemoryId: target,
      payload: {}, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    if (delayed) db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id=?")
      .run("2100-01-01T00:00:00.000Z", id);
    return queued;
  }
  function jobs(type: EvolutionJobRecord["jobType"] = "l2_association") {
    repos.transaction(() => { for (let i = 0; i < total; i++) job(`auto-${i}`, type); });
  }
  function expectClean() {
    expect(concurrency.snapshot()).toEqual({ activeJobs: 0, availableJobs: 4, resources: {}, providers: {}, scopeKeys: [], embeddingRequests: 0 });
    const queued = db.db.prepare("SELECT attempts,lease_token FROM evolution_jobs WHERE status='queued'").all();
    expect(queued.every(row => (row as { attempts: number; lease_token: string | null }).attempts === 0
      && (row as { lease_token: string | null }).lease_token === null)).toBe(true);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get()).toEqual({ n: 0 });
  }
  return { db, repos, concurrency, runner, deps, processed, job, jobs, expectClean, peakJobs: () => peakJobs };
}
function timerEvent(operation: () => void): Promise<void> {
  return new Promise((resolve, reject) => setTimeout(() => { try { operation(); resolve(); } catch (error) { reject(error); } }, 0));
}
afterEach(async () => {
  for (const { root, db, runner, concurrency } of resources.splice(0)) {
    await runner.stop(); await concurrency.close();
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("continuous worker event-loop fairness", () => {
  it("lets an already scheduled zero-delay abort run before synchronous database work is drained", async () => {
    const h = harness(), abort = new AbortController(); h.jobs();
    let atAbort = -1;
    const event = timerEvent(() => { atAbort = h.processed.length; abort.abort(); });
    const run = await h.runner.runWorkerOnce(4, {}, { continuous: true, signal: abort.signal });
    await event;
    expect(atAbort).toBeGreaterThan(0);
    // Allow a timers/check phase turn; do not assert an exact refill boundary.
    expect(atAbort).toBeLessThanOrEqual(64);
    expect(h.processed).toHaveLength(atAbort);
    expect(run.leased).toBe(atAbort);
    expect(run.failed).toBe(0); h.expectClean();
  });

  it("admits a manual request posted from a timer before exhausting the automatic backlog", async () => {
    const h = harness(); h.jobs(); h.job("manual", "l2_association", "manual-target", true);
    let beforeManual = -1, manual: ReturnType<WorkerRunner["runWorkerOnce"]> | undefined;
    const event = timerEvent(() => {
      beforeManual = h.processed.length;
      h.db.db.prepare("UPDATE evolution_jobs SET available_at=NULL WHERE id='manual'").run();
      manual = h.runner.runWorkerOnce(1, { targetMemoryIds: ["manual-target"] });
    });
    const automatic = await h.runner.runWorkerOnce(4, {}, { continuous: true });
    await event; const result = await manual!;
    expect(beforeManual).toBeLessThanOrEqual(64);
    expect(automatic.leased).toBe(beforeManual);
    expect(result.jobs.map(job => job.jobId)).toEqual(["manual"]);
    expect(h.processed.slice(-1)).toEqual(["manual"]);
    expect(h.processed).toHaveLength(beforeManual + 1); h.expectClean();
  });

  it("honors stop issued from a timer and leaves unadmitted records untouched", async () => {
    const h = harness(); h.jobs();
    let atStop = -1, stopped: Promise<void> | undefined;
    const event = timerEvent(() => { atStop = h.processed.length; stopped = h.runner.stop(); });
    const result = await h.runner.runWorkerOnce(4, {}, { continuous: true });
    await event; await stopped;
    expect(atStop).toBeLessThanOrEqual(64);
    expect(h.processed).toHaveLength(atStop);
    expect(result.leased).toBe(atStop);
    await expect(h.runner.runWorkerOnce(1)).rejects.toThrow(/stopped/i);
    h.expectClean();
  });

  it("retains the global and actual Provider request limits across macro-task turns", async () => {
    const h = harness(); h.jobs("trace_summary");
    const descriptors: WorkerProviderDescriptor[] = ["provider-a", "provider-b"].map(key => ({
      local: false, providers: [{ key, limit: 2 }, { key: `${key}:model`, limit: 2 }]
    }));
    const descriptorFor = (id: string) => descriptors[Number(id.split("-")[1]) % 2]!;
    h.deps.prepareExecution = work => ({
      providers: descriptorFor(work.queue === "main" ? work.job.id : work.retry.id).providers,
      run: operation => operation()
    });
    const process = h.deps.jobHandlers.processJob;
    const activeByProvider = [0, 0], peakByProvider = [0, 0];
    let activeRequests = 0, peakRequests = 0, atTimer = -1;
    h.deps.jobHandlers.processJob = async job => {
      const index = Number(job.id.split("-")[1]) % 2;
      await h.concurrency.runRequest(descriptors[index]!, async () => {
        peakRequests = Math.max(peakRequests, ++activeRequests);
        peakByProvider[index] = Math.max(peakByProvider[index]!, ++activeByProvider[index]!);
        try { await Promise.resolve(); await process(job); }
        finally { activeRequests--; activeByProvider[index]!--; }
      });
    };
    const event = timerEvent(() => { atTimer = h.processed.length; });
    const result = await h.runner.runWorkerOnce(4, {}, { continuous: true });
    await event;
    expect(atTimer).toBeGreaterThan(0); expect(atTimer).toBeLessThanOrEqual(64);
    expect(result).toMatchObject({ leased: total, succeeded: total, failed: 0 });
    expect(h.processed).toHaveLength(total);
    // Both Providers can run concurrently, while neither exceeds its own cap.
    expect(peakRequests).toBe(4); expect(peakByProvider).toEqual([2, 2]);
    expect(h.peakJobs()).toBe(4);
    expect(activeRequests).toBe(0); expect(activeByProvider).toEqual([0, 0]); h.expectClean();
  });

  it("clears deadline and heartbeat timers when cancellation arrives during a macro-task turn", async () => {
    // Keep native immediates live: the production yield must not need a test
    // clock advance. Track only the owned deadline/heartbeat timer handles.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const h = harness(), abort = new AbortController(); h.jobs(); h.job("future", "l2_association", "future", true);
    let atAbort = -1;
    const event = nextTurn().then(() => { atAbort = h.processed.length; abort.abort(); });
    const run = await h.runner.runWorkerOnce(4, {}, { continuous: true, signal: abort.signal });
    await event;
    expect(atAbort).toBeGreaterThan(0); expect(atAbort).toBeLessThanOrEqual(64);
    expect(h.processed).toHaveLength(atAbort); expect(run.leased).toBe(atAbort);
    expect(schedule.mock.calls.some(([, delay]) => Number(delay) > 1000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0); h.expectClean();
  });

  it("clears timer handles and permits if admission throws after the event loop gets a turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const h = harness(); h.jobs(); h.job("future", "l2_association", "future", true);
    let failAdmission = false, completedBeforeFailure = -1;
    h.deps.prepareExecution = () => {
      if (failAdmission) throw new Error("admission failed after macro-task turn");
      return { providers: [], run: operation => operation() };
    };
    const event = nextTurn().then(() => { completedBeforeFailure = h.processed.length; failAdmission = true; });
    const rejected = expect(h.runner.runWorkerOnce(4, {}, { continuous: true }))
      .rejects.toThrow("admission failed after macro-task turn");
    await Promise.all([event, rejected]);
    expect(completedBeforeFailure).toBeGreaterThan(0); expect(completedBeforeFailure).toBeLessThanOrEqual(64);
    expect(h.processed).toHaveLength(completedBeforeFailure);
    expect(schedule.mock.calls.some(([, delay]) => Number(delay) > 1000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0); h.expectClean();
  });
});
