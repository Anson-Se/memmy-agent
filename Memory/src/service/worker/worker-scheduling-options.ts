import type { QueueLane } from "./job-policy-registry.js";
import { DEFAULT_LANE_WEIGHTS, validateLaneWeights } from "./lane-queue-selector.js";

export type WorkerSchedulingAlgorithm = "wrr" | "legacy";
export interface WorkerSchedulingOptions {
  algorithm?: WorkerSchedulingAlgorithm;
  laneWeights?: Readonly<Record<QueueLane, number>>;
}
export interface ResolvedWorkerSchedulingOptions {
  algorithm: WorkerSchedulingAlgorithm;
  laneWeights: Readonly<Record<QueueLane, number>>;
}
type SchedulingEnvironment = Partial<Pick<NodeJS.ProcessEnv,
  "MEMMY_WORKER_SCHEDULER_ALGORITHM" | "MEMMY_WORKER_LANE_WEIGHTS">>;

/** Explicit dependency settings win over environment settings, field by field. */
export function resolveWorkerSchedulingOptions(
  options: WorkerSchedulingOptions = {}, env: SchedulingEnvironment = process.env
): Readonly<ResolvedWorkerSchedulingOptions> {
  const algorithmValue: unknown = options.algorithm !== undefined ? options.algorithm
    : env.MEMMY_WORKER_SCHEDULER_ALGORITHM?.trim() || "wrr";
  const algorithm = typeof algorithmValue === "string" ? algorithmValue.trim().toLowerCase() : undefined;
  if (algorithm !== "wrr" && algorithm !== "legacy") {
    throw new RangeError("Worker scheduler algorithm must be wrr or legacy");
  }
  let weights: unknown = options.laneWeights;
  if (weights === undefined) {
    const encoded = env.MEMMY_WORKER_LANE_WEIGHTS?.trim();
    if (encoded) {
      try { weights = JSON.parse(encoded) as unknown; }
      catch { throw new TypeError("MEMMY_WORKER_LANE_WEIGHTS must contain a JSON object with all five lane weights"); }
    } else weights = DEFAULT_LANE_WEIGHTS;
  }
  return Object.freeze({ algorithm, laneWeights: validateLaneWeights(weights) });
}
