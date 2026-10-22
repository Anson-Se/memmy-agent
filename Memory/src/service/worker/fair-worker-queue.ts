import { createHash } from "node:crypto";
import type { Repositories, EvolutionJobRecord, EmbeddingRetryRecord } from "../../storage/repositories.js";
import type { QueueEligibilityOptions } from "../../storage/queue-eligibility.js";
import { LaneQueueSelector } from "./lane-queue-selector.js";
import { QUEUE_LANES } from "./job-policy-registry.js";
import type { ResolvedWorkerSchedulingOptions } from "./worker-scheduling-options.js";

export type FairClaimedWork = { queue: "main"; job: EvolutionJobRecord } |
  { queue: "embedding_retry"; retry: EmbeddingRetryRecord };
const CURSOR_KEY = "worker.scheduler.wrr_cursor.v1";
export const FAIR_CLAIM_BATCH_LIMIT = 200;

function normalizeFilter(values: readonly string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : [...new Set(values)].sort();
}

function scopeCursorKey(filters: QueueEligibilityOptions & { includeRetries: boolean }): string {
  if (filters.targetMemoryIds === undefined && filters.allowedJobTypes === undefined &&
    !filters.excludedJobTypes?.length && filters.includeRetries) return CURSOR_KEY;
  // A manual/targeted drain must not skip other lanes in the automatic round.
  // Keep a persistent round for each equivalent scope, including limit=1 calls.
  // Hash the full sets: truncating large target lists would merge distinct scopes.
  const scope = JSON.stringify({ targets: filters.targetMemoryIds ?? null,
    allowed: filters.allowedJobTypes ?? null, excluded: filters.excludedJobTypes ?? [],
    includeRetries: filters.includeRetries });
  return `${CURSOR_KEY}.scope.${createHash("sha256").update(scope).digest("hex")}`;
}

/** Both backing tables share one selection, one budget and one atomic cursor. */
export function claimFairWorkerBatch(
  repos: Pick<Repositories, "transaction" | "runtime">,
  input: QueueEligibilityOptions & {
    at: string; limit: number; includeRetries: boolean; owner: string;
    retryOwner: string; leaseSeconds: number; retryLeaseMs: number;
    options: ResolvedWorkerSchedulingOptions;
  }
): FairClaimedWork[] {
  const request = { ...input,
    targetMemoryIds: normalizeFilter(input.targetMemoryIds),
    allowedJobTypes: normalizeFilter(input.allowedJobTypes),
    excludedJobTypes: normalizeFilter(input.excludedJobTypes),
    includeDueFailed: true
  };
  const cursorKey = scopeCursorKey(request);
  return repos.transaction(() => {
    repos.runtime.scheduling.refreshRunnablePolicies(request);
    const weightsKey = QUEUE_LANES.map((lane) => input.options.laneWeights[lane]).join("/");
    const saved = repos.runtime.getKv(cursorKey)?.value as { weightsKey?: unknown; cursor?: unknown } | undefined;
    const cursor = saved?.weightsKey === weightsKey && Number.isSafeInteger(saved.cursor) && Number(saved.cursor) >= 0
      ? Number(saved.cursor) : 0;
    const selector = new LaneQueueSelector(input.options.laneWeights, cursor);
    const limit = Math.min(FAIR_CLAIM_BATCH_LIMIT, input.limit);
    const candidates = repos.runtime.scheduling.candidates({ ...request, limit, includeUnregistered: true });
    const claimed: FairClaimedWork[] = [];
    while (claimed.length < limit && candidates.length > 0) {
      const before = selector.getCursor();
      const chosen = selector.select(candidates, 1).selected[0];
      if (!chosen) break;
      candidates.splice(candidates.findIndex((item) => item.queue === chosen.queue && item.id === chosen.id), 1);
      if (chosen.queue === "main") {
        const job = repos.runtime.claimQueuedJob(chosen.id, request);
        if (job) claimed.push({ queue: "main", job });
        else selector.setCursor(before);
      } else {
        const retry = repos.runtime.claimEmbeddingRetryById(chosen.id, {
          now: Date.parse(input.at), workerId: input.retryOwner,
          leaseUntil: Date.parse(input.at) + input.retryLeaseMs,
          targetMemoryIds: request.targetMemoryIds
        });
        if (retry) claimed.push({ queue: "embedding_retry", retry });
        else selector.setCursor(before);
      }
    }
    // Commit the cursor with the claims. Rollback cannot consume opportunities,
    // and a process restart or a series of limit=1 calls cannot reset the round.
    if (claimed.length > 0) repos.runtime.setKv(cursorKey, { weightsKey, cursor: selector.getCursor() }, input.at);
    return claimed;
  });
}
