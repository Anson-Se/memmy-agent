import { QUEUE_LANES, type QueueLane } from "./job-policy-registry.js";

/** Section 6.1's starting weights. Phase 3 uses these only for observation. */
export const DEFAULT_LANE_WEIGHTS: Readonly<Record<QueueLane, number>> = Object.freeze({
  interactive: 4,
  repair_retry: 3,
  import: 2,
  evolution: 2,
  maintenance: 1
});

export interface ShadowQueueCandidate {
  queue: "main" | "embedding_retry";
  id: string;
  lane: QueueLane;
  enqueueSeq: number;
  basePriority: number;
}

export interface ShadowQueueSelection {
  selected: readonly ShadowQueueCandidate[];
  nextCursor: number;
  algorithm: "wrr_runnable_fifo";
  weights: Readonly<Record<QueueLane, number>>;
}

/**
 * Read-only simulation: candidates must already have passed readiness checks.
 * No claims, status writes, timers, provider calls, or execution callbacks live
 * here. Cursor changes affect the next shadow preview, never the legacy worker.
 */
export class ShadowQueueSelector {
  private readonly schedule: readonly QueueLane[];
  private readonly weights: Readonly<Record<QueueLane, number>>;
  private cursor = 0;

  constructor(weights: Readonly<Record<QueueLane, number>> = DEFAULT_LANE_WEIGHTS) {
    const schedule: QueueLane[] = [];
    for (const lane of QUEUE_LANES) {
      const weight = weights[lane];
      if (!Number.isSafeInteger(weight) || weight < 1 || weight > 1_024) {
        throw new RangeError(`Invalid shadow lane weight for ${lane}: ${weight}`);
      }
      schedule.push(...Array<QueueLane>(weight).fill(lane));
    }
    this.weights = Object.freeze({ ...weights });
    this.schedule = Object.freeze(schedule);
  }

  getCursor(): number {
    return this.cursor;
  }

  select(candidates: readonly ShadowQueueCandidate[], limit: number): ShadowQueueSelection {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`Invalid shadow selection limit: ${limit}`);
    const buckets = new Map<QueueLane, ShadowQueueCandidate[]>(QUEUE_LANES.map((lane) => [lane, []]));
    const identities = new Set<string>();
    for (const candidate of candidates) {
      const bucket = buckets.get(candidate.lane);
      if (!bucket) throw new Error(`Unknown shadow candidate lane: ${candidate.lane}`);
      if (!Number.isSafeInteger(candidate.enqueueSeq) || candidate.enqueueSeq < 1) {
        throw new RangeError(`Invalid enqueue sequence for shadow candidate: ${candidate.id}`);
      }
      const identity = `${candidate.queue}:${candidate.id}`;
      if (identities.has(identity)) throw new Error(`Duplicate shadow candidate: ${identity}`);
      identities.add(identity);
      bucket.push(candidate);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.enqueueSeq - b.enqueueSeq ||
        a.queue.localeCompare(b.queue) || a.id.localeCompare(b.id));
    }

    const offsets = new Map<QueueLane, number>();
    const selected: ShadowQueueCandidate[] = [];
    while (selected.length < Math.min(limit, candidates.length)) {
      let found = false;
      // Empty/blocked lanes never consume execution capacity. A full schedule
      // traversal without a candidate means the available input is exhausted.
      for (let scanned = 0; scanned < this.schedule.length; scanned += 1) {
        const lane = this.schedule[this.cursor]!;
        this.cursor = (this.cursor + 1) % this.schedule.length;
        const offset = offsets.get(lane) ?? 0;
        const candidate = buckets.get(lane)![offset];
        if (!candidate) continue;
        selected.push(candidate);
        offsets.set(lane, offset + 1);
        found = true;
        break;
      }
      if (!found) break;
    }
    return Object.freeze({
      selected: Object.freeze(selected), nextCursor: this.cursor,
      algorithm: "wrr_runnable_fifo", weights: this.weights
    });
  }
}
