import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/index.js";
import { ModelHttpError } from "../../../src/model/http.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import {
  MODEL_JUDGMENT_MAX_ATTEMPTS,
  MODEL_OUTPUT_INVALID_LIMIT,
  ModelOutputInvalidError,
  modelJudgmentFailurePlan
} from "../../../src/service/worker/job-handlers.js";

const AT = "2026-10-08T12:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function job(payload: Record<string, unknown> = {}): EvolutionJobRecord {
  return {
    id: "job-turn-relation",
    jobType: "turn_relation",
    status: "queued",
    dedupeKey: "turn_relation:raw-1",
    userId: "user-1",
    payload: { rawTurnId: "raw-1", ...payload },
    attempts: 1,
    maxAttempts: MODEL_JUDGMENT_MAX_ATTEMPTS,
    createdAt: AT,
    updatedAt: AT
  };
}

function delayMs(plan: { payload: Record<string, unknown> }): number {
  return Date.parse(String(plan.payload.runAfter)) - Date.parse(AT);
}

describe("model judgment job failures", () => {
  it("backs off network and quota errors from one minute up to one hour without dead-lettering", () => {
    const first = modelJudgmentFailurePlan(job(), new Error("network timeout"), AT);
    expect(first).toMatchObject({ deadLetter: false, errorCode: "transient_provider_error" });
    expect(delayMs(first)).toBe(60_000);

    const second = modelJudgmentFailurePlan(job(first.payload), new Error("network timeout"), AT);
    expect(delayMs(second)).toBe(120_000);

    const late = modelJudgmentFailurePlan(job({ failureCount: 30 }), new Error("network timeout"), AT);
    expect(delayMs(late)).toBe(60 * 60 * 1000);

    const quota = modelJudgmentFailurePlan(
      job(),
      new ModelHttpError("quota exhausted", "host", 403, "40309", "quota"),
      AT
    );
    expect(quota.deadLetter).toBe(false);
    expect(quota.errorCode).toBe("40309");
  });

  it("retries empty, HTML and 404 replies instead of treating them as configuration", () => {
    expect(modelJudgmentFailurePlan(job(), new Error("model returned HTML instead of JSON"), AT).deadLetter).toBe(false);
    const notFound = modelJudgmentFailurePlan(job(), new ModelHttpError("not found", "host", 404, undefined, "404"), AT);
    expect(notFound).toMatchObject({ deadLetter: false, errorCode: "transient_provider_error" });
  });

  it("dead-letters a request the model will never accept", () => {
    const invalid = modelJudgmentFailurePlan(job(), new ModelHttpError("bad request", "host", 400, undefined, "bad"), AT);
    expect(invalid).toMatchObject({ deadLetter: true, errorCode: "invalid_model_request" });
    expect(invalid.payload.runAfter).toBeUndefined();
  });

  it("stops after five invalid outputs; other failures neither count nor reset the limit", () => {
    let payload: Record<string, unknown> = {};
    for (let index = 1; index < MODEL_OUTPUT_INVALID_LIMIT; index += 1) {
      const plan = modelJudgmentFailurePlan(job(payload), new ModelOutputInvalidError("relation outside the five labels"), AT);
      expect(plan).toMatchObject({ deadLetter: false, errorCode: "model_output_invalid" });
      payload = plan.payload;
      if (index === 2) {
        payload = modelJudgmentFailurePlan(job(payload), new Error("network timeout"), AT).payload;
        expect(payload.invalidOutputCount).toBe(2);
      }
    }
    const last = modelJudgmentFailurePlan(job(payload), new ModelOutputInvalidError("feedback missing"), AT);
    expect(last).toMatchObject({ deadLetter: true, errorCode: "model_output_invalid" });
    expect(last.payload.invalidOutputCount).toBe(MODEL_OUTPUT_INVALID_LIMIT);
  });

  it("stores the retry plan on the job and re-queues a dead letter with fresh counters", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-model-judgment-"));
    roots.push(root);
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    try {
      const repos = new Repositories(db.db);
      const queued = repos.runtime.enqueueJob(job());
      const retry = modelJudgmentFailurePlan(queued, new Error("network timeout"), AT);
      const failed = repos.runtime.failJobWithPayload(queued.id, "transient_provider_error: network timeout", retry.payload, false, AT);
      expect(failed).toMatchObject({ status: "failed", payload: { runAfter: retry.payload.runAfter, failureCount: 1 } });

      const dead = repos.runtime.failJobWithPayload(
        queued.id,
        "model_output_invalid",
        { ...retry.payload, invalidOutputCount: MODEL_OUTPUT_INVALID_LIMIT },
        true,
        AT
      );
      expect(dead?.status).toBe("dead_letter");
      expect(repos.runtime.failJobWithPayload(queued.id, "late", {}, false, AT)?.status).toBe("dead_letter");

      const requeued = repos.runtime.requeueDeadLetterJob(queued.id, AT);
      expect(requeued).toMatchObject({ status: "queued", attempts: 0 });
      expect(requeued?.payload).toMatchObject({ rawTurnId: "raw-1", manualRetryAt: AT });
      expect(requeued?.payload).not.toHaveProperty("invalidOutputCount");
      expect(requeued?.payload).not.toHaveProperty("runAfter");
      expect(repos.runtime.requeueDeadLetterJob(queued.id, AT)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
