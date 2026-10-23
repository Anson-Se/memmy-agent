import { QUEUE_LANES, type QueueLane } from "./job-policy-registry.js";
import { DEFAULT_LANE_WEIGHTS, LaneQueueSelector, validateLaneWeights, type LaneQueueCandidate } from "./lane-queue-selector.js";

export interface LaneQueueTurns {
  version: 1;
  lanes: ReadonlyArray<{ lane: QueueLane; remaining: number }>;
}

/**
 * WRR turns survive admission refusals. Only an exhausted successful lane moves
 * to the tail: unrelated fast work cannot reset an older blocked lane's turn.
 * There is one bounded turn per lane, never a credit per rejected job.
 */
export class AdmissionLaneQueueSelector {
  private readonly weights: Readonly<Record<QueueLane, number>>;
  private turns: Array<{ lane: QueueLane; remaining: number }>;
  private cursor: number;
  private empty = new Set<QueueLane>();

  constructor(weights = DEFAULT_LANE_WEIGHTS, initialCursor = 0, savedTurns?: unknown) {
    this.weights = validateLaneWeights(weights);
    this.cursor = new LaneQueueSelector(this.weights, initialCursor).getCursor();
    let offset = this.cursor, first = 0;
    while (offset >= this.weights[QUEUE_LANES[first]!]) {
      offset -= this.weights[QUEUE_LANES[first]!]!;
      first++;
    }
    this.turns = QUEUE_LANES.map((_, i) => {
      const lane = QUEUE_LANES[(first + i) % QUEUE_LANES.length]!;
      return { lane, remaining: this.weights[lane] - (i === 0 ? offset : 0) };
    });
    // The extension is optional under the existing KV key. Old releases and
    // malformed/unknown versions safely resume from the compatible cursor.
    if (savedTurns === null || typeof savedTurns !== "object" || Array.isArray(savedTurns)) return;
    const saved = savedTurns as { version?: unknown; lanes?: unknown };
    if (saved.version !== 1 || !Array.isArray(saved.lanes) || saved.lanes.length !== QUEUE_LANES.length) return;
    const restored: typeof this.turns = [], seen = new Set<string>();
    for (const value of saved.lanes) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const { lane, remaining } = value as { lane?: unknown; remaining?: unknown };
      if (typeof lane !== "string" || !(QUEUE_LANES as readonly string[]).includes(lane) || seen.has(lane) ||
        typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining < 1 || remaining > this.weights[lane as QueueLane]) return;
      seen.add(lane); restored.push({ lane: lane as QueueLane, remaining });
    }
    this.turns = restored;
  }

  getCursor(): number { return this.cursor; }

  snapshot(): LaneQueueTurns {
    return { version: 1, lanes: this.turns.map(turn => ({ ...turn })) };
  }

  /** Only lanes proven to have no eligible row, not resource-denied lanes. */
  dropEmpty(empty: ReadonlySet<QueueLane>): void {
    // Skipping an empty lane is tentative until some other lane really claims
    // a job. A later slice may receive new interactive work before any CAS wins.
    this.empty = new Set(empty);
  }

  choose<T extends LaneQueueCandidate>(candidates: readonly T[]): T | undefined {
    const heads = new Map<QueueLane, T>(), seen = new Set<string>();
    for (const candidate of candidates) {
      if (!(QUEUE_LANES as readonly string[]).includes(candidate.lane)) throw new Error(`Unknown queue candidate lane: ${candidate.lane}`);
      if (!Number.isSafeInteger(candidate.enqueueSeq) || candidate.enqueueSeq < 1) throw new RangeError(`Invalid enqueue sequence for queue candidate: ${candidate.id}`);
      const key = `${candidate.queue}:${candidate.id}`;
      if (seen.has(key)) throw new Error(`Duplicate queue candidate: ${key}`);
      seen.add(key);
      const head = heads.get(candidate.lane);
      if (!head || candidate.enqueueSeq < head.enqueueSeq || (candidate.enqueueSeq === head.enqueueSeq &&
        (candidate.queue.localeCompare(head.queue) || candidate.id.localeCompare(head.id)) < 0)) heads.set(candidate.lane, candidate);
    }
    for (const turn of this.turns) {
      const head = heads.get(turn.lane);
      if (head) return head;
    }
    return undefined;
  }

  /** Call only after a successful lease CAS; a rejection/rollback consumes nothing. */
  commit(lane: QueueLane): void {
    const index = this.turns.findIndex(turn => turn.lane === lane);
    if (index < 0) throw new Error(`Unknown queue lane: ${lane}`);
    const skipped = this.turns.slice(0, index).filter(turn => this.empty.has(turn.lane));
    this.turns = [...this.turns.filter(turn => !skipped.includes(turn)),
      ...skipped.map(turn => ({ lane: turn.lane, remaining: this.weights[turn.lane] }))];
    const turn = this.turns.find(item => item.lane === lane)!;
    const start = QUEUE_LANES.slice(0, QUEUE_LANES.indexOf(lane)).reduce((sum, item) => sum + this.weights[item], 0);
    const size = QUEUE_LANES.reduce((sum, item) => sum + this.weights[item], 0);
    turn.remaining--;
    this.cursor = (start + this.weights[lane] - turn.remaining) % size;
    if (turn.remaining === 0) {
      this.turns.splice(this.turns.indexOf(turn), 1);
      this.turns.push({ lane, remaining: this.weights[lane] });
    }
  }
}
