import { describe, expect, it } from "vitest";
import { AdmissionLaneQueueSelector } from "../../../src/service/worker/admission-lane-queue-selector.js";
import { DEFAULT_LANE_WEIGHTS, type LaneQueueCandidate } from "../../../src/service/worker/lane-queue-selector.js";
import { QUEUE_LANES, type QueueLane } from "../../../src/service/worker/job-policy-registry.js";

function candidate(lane: QueueLane, enqueueSeq = 1): LaneQueueCandidate {
  return { queue: "main", id: `${lane}-${enqueueSeq}`, lane, enqueueSeq, basePriority: 0 };
}
function claim(selector: AdmissionLaneQueueSelector, available: QueueLane[], blocked: QueueLane[] = []): QueueLane | undefined {
  const pool = available.map((lane, i) => candidate(lane, i + 1));
  selector.dropEmpty(new Set(QUEUE_LANES.filter(lane => !available.includes(lane))));
  while (pool.length) {
    const item = selector.choose(pool)!;
    pool.splice(pool.indexOf(item), 1);
    if (blocked.includes(item.lane)) continue;
    selector.commit(item.lane);
    return item.lane;
  }
  return undefined;
}

describe("admission-aware weighted lane turns", () => {
  it("keeps the original weighted sequence without resource contention", () => {
    const selector = new AdmissionLaneQueueSelector();
    const sequence = Array.from({ length: 24 }, () => claim(selector, [...QUEUE_LANES]));
    const round = QUEUE_LANES.flatMap(lane => Array<QueueLane>(DEFAULT_LANE_WEIGHTS[lane]).fill(lane));
    expect(sequence).toEqual([...round, ...round]);
    expect(selector.getCursor()).toBe(0);
  });

  it.each([false, true])("preserves model opportunities across fast DB work with another permanently blocked Provider: %s", hasBlockedProvider => {
    const selector = new AdmissionLaneQueueSelector();
    const available: QueueLane[] = [...(hasBlockedProvider ? ["interactive"] as const : []), "import", "evolution", "maintenance"];
    const permanentlyBlocked: QueueLane[] = hasBlockedProvider ? ["interactive"] : [];
    const sequence: QueueLane[] = [];
    for (let done = 0; done < 100; done++) {
      const served = claim(selector, available, permanentlyBlocked)!;
      if (served !== "maintenance") sequence.push(served);
      for (let tick = 0; tick < 10; tick++) expect(claim(selector, available,
        [...permanentlyBlocked, "import", "evolution"])).toBe("maintenance");
    }
    expect(sequence).toHaveLength(100);
    expect(sequence.filter(lane => lane === "import")).toHaveLength(50);
    expect(sequence.filter(lane => lane === "evolution")).toHaveLength(50);
  });

  it("restores remaining turns and consumes no opportunity for preview or a failed CAS", () => {
    const selector = new AdmissionLaneQueueSelector();
    claim(selector, [...QUEUE_LANES]);
    const saved = selector.snapshot();
    const restored = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, selector.getCursor(), saved);
    const before = restored.snapshot();
    expect(restored.choose([candidate("interactive")])?.lane).toBe("interactive");
    expect(restored.snapshot()).toEqual(before);
    expect(Array.from({ length: 4 }, () => claim(restored, [...QUEUE_LANES]))).toEqual([
      "interactive", "interactive", "interactive", "repair_retry"
    ]);
    expect(saved.lanes[0]?.remaining).toBe(3);
  });

  it("gives a previously empty interactive lane a bounded turn without accumulating historical debt", () => {
    const selector = new AdmissionLaneQueueSelector();
    for (let i = 0; i < 1000; i++) claim(selector, ["import", "evolution", "maintenance"]);
    const sequence = Array.from({ length: 24 }, () => claim(selector, [...QUEUE_LANES]));
    expect(sequence.slice(0, 12)).toContain("interactive");
    expect(sequence.filter(lane => lane === "interactive")).toHaveLength(8);
    expect(selector.snapshot().lanes.every(turn => turn.remaining <= DEFAULT_LANE_WEIGHTS[turn.lane])).toBe(true);
  });

  it("keeps an empty lane skip tentative until a successful claim confirms it", () => {
    const selector = new AdmissionLaneQueueSelector();
    const before = selector.snapshot();
    selector.dropEmpty(new Set(["interactive", "repair_retry"]));
    expect(selector.choose([candidate("import")])?.lane).toBe("import");
    expect(selector.snapshot()).toEqual(before);
    selector.dropEmpty(new Set(["repair_retry"]));
    expect(selector.choose([candidate("interactive"), candidate("import")])?.lane).toBe("interactive");
    selector.commit("interactive");
    expect(selector.getCursor()).toBe(1);
  });

  it("sanitizes old or malformed optional state using the old cursor", () => {
    for (const state of [undefined, null, {}, { version: 2, lanes: [] }, { version: 1, lanes: [] },
      { version: 1, lanes: QUEUE_LANES.map(lane => ({ lane, remaining: 0 })) },
      { version: 1, lanes: QUEUE_LANES.map(() => ({ lane: "import", remaining: 1 })) }]) {
      const selector = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, 8, state);
      expect(Array.from({ length: 3 }, () => claim(selector, [...QUEUE_LANES]))).toEqual(["import", "evolution", "evolution"]);
    }
  });

  it("keeps FIFO across backing tables, validates duplicates and leaves input untouched", () => {
    const selector = new AdmissionLaneQueueSelector();
    const old = Object.freeze({ ...candidate("repair_retry", 1), queue: "embedding_retry" as const });
    const newer = Object.freeze(candidate("repair_retry", 2));
    const input = Object.freeze([newer, old]);
    expect(selector.choose(input)).toBe(old);
    expect(input).toEqual([newer, old]);
    expect(() => selector.choose([old, old])).toThrow(/Duplicate/);
  });
});
