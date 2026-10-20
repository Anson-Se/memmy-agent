import { expect, it } from "vitest";
import { MemoryAgentSourceScanStateSchema, AgentSourceScanProgressPayloadSchema, AgentSourceScanJobResponseSchema, ScanCompletedSseEventSchema } from "../src/index.js";

it.each(["discover", "read", "redact", "emit", "scan", "prepare", "add", "summarize", "done", "stopped"])("accepts Memory phase %s without expanding desktop phases", (phase) => {
  expect(MemoryAgentSourceScanStateSchema.parse({ running: true, jobId: "job", attemptId: "round", sourceId: "codex", mode: "full",
    startedAt: null, completedAt: null, error: null, progress: { phase, sourceId: "codex", current: 1, total: 2 } }).progress?.phase).toBe(phase);
  if (["discover", "read", "redact", "emit", "prepare"].includes(phase)) {
    expect(AgentSourceScanProgressPayloadSchema.safeParse({ jobId: "job", phase, sourceId: "codex", current: 1, total: 2 }).success).toBe(false);
  }
});
it("keeps optional attempt identity and authoritative outcome while accepting old peers", () => {
  expect(AgentSourceScanJobResponseSchema.parse({ jobId: "job" })).toEqual({ jobId: "job" });
  const payload = { jobId: "job", attemptId: "retry", succeeded: false, results: [], sourceId: "all" };
  expect(ScanCompletedSseEventSchema.parse({ id: "event", type: "agent_source.scan_completed", timestamp: new Date().toISOString(), payload }).payload).toEqual(payload);
});
