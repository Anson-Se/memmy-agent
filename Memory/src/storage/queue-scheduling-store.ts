import type Database from "better-sqlite3";
import {
  jobPolicyRegistry, JOB_POLICY_VERSION, QUEUE_LANES,
  type QueueLane, UnknownJobPolicyError
} from "../service/worker/job-policy-registry.js";
import { mainQueueEligibility, retryQueueEligibility, type QueueEligibilityOptions } from "./queue-eligibility.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { JobLeaseLostError } from "./job-lease-context.js";

const logger = createMemoryLogger("worker");

export interface SchedulingCandidate {
  queue: "main" | "embedding_retry";
  id: string;
  jobType: string;
  lane: QueueLane;
  enqueueSeq: number;
  basePriority: number;
}
export interface SchedulingMetadata {
  queueLane?: string | null;
  resourceClass?: string | null;
  enqueueSeq?: number | null;
  firstQueuedAt?: string | null;
  basePriority?: number | null;
  policyVersion?: number | null;
}
interface PolicyRow {
  id: string; job_type: string; payload_json: string; agent_id: string | null;
  memory_layer: string | null; tags_json: string | null; plugin_algorithm: string | null;
}
export interface PolicyRefreshResult { refreshed: number; unknown: Array<{ id: string; jobType: string }> }

/** A metadata projection and read-only candidate adapter; never claims or completes jobs. */
export class QueueSchedulingStore {
  constructor(private readonly db: Database.Database) {}

  readSnapshot<T>(read: () => T): T {
    return this.db.transaction(read)();
  }

  refreshPolicies(limit = 500): PolicyRefreshResult {
    const result: PolicyRefreshResult = { refreshed: 0, unknown: [] };
    if (this.db.readonly) return result;
    return this.db.transaction(() => {
      for (const queue of ["main", "embedding_retry"] as const) {
        const table = queue === "main" ? "evolution_jobs" : "embedding_retry_queue";
        const target = queue === "main" ? "q.target_memory_id" : "q.target_id";
        const rows = this.db.prepare(`SELECT q.id,
          ${queue === "main" ? "q.job_type, q.payload_json" : "'embedding_retry' AS job_type, '{}' AS payload_json"},
          m.agent_id, m.memory_layer, m.tags_json,
          json_extract(m.properties_json, '$.internal_info.plugin_algorithm') AS plugin_algorithm
          FROM ${table} q LEFT JOIN memories m ON m.id = ${target}
          WHERE q.policy_version IS NULL OR q.policy_version != ? ORDER BY q.enqueue_seq LIMIT ?`)
          .all(JOB_POLICY_VERSION, Math.max(0, limit - result.refreshed)) as PolicyRow[];
        for (const row of rows) {
          this.writePolicy(table, row, result);
        }
      }
      return result;
    })();
  }

  refreshOne(queue: SchedulingCandidate["queue"], id: string): PolicyRefreshResult {
    const result: PolicyRefreshResult = { refreshed: 0, unknown: [] };
    try {
      const table = queue === "main" ? "evolution_jobs" : "embedding_retry_queue";
      const target = queue === "main" ? "q.target_memory_id" : "q.target_id";
      const row = this.db.prepare(`SELECT q.id,
        ${queue === "main" ? "q.job_type, q.payload_json" : "'embedding_retry' AS job_type, '{}' AS payload_json"},
        m.agent_id, m.memory_layer, m.tags_json,
        json_extract(m.properties_json, '$.internal_info.plugin_algorithm') AS plugin_algorithm
        FROM ${table} q LEFT JOIN memories m ON m.id = ${target} WHERE q.id = ?`).get(id) as PolicyRow | undefined;
      if (row) this.writePolicy(table, row, result);
    } catch (error) {
      if (error instanceof JobLeaseLostError) throw error;
      // A projection error must not turn a successful real enqueue into a
      // failed one. Insert/update triggers leave it dirty for a later retry.
      logger.warn("scheduler.policy_refresh_failed", { queue, jobId: id, ...memoryErrorFields(error) });
    }
    return result;
  }

  private writePolicy(table: string, row: PolicyRow, result: PolicyRefreshResult): void {
    let policy: { queueLane: string; resourceClass: string; basePriority: number; policyVersion: number };
    try {
      policy = jobPolicyRegistry.resolve({ jobType: row.job_type, payload: JSON.parse(row.payload_json), target: {
        agentId: row.agent_id ?? undefined, memoryLayer: row.memory_layer ?? undefined,
        tags: row.tags_json ? JSON.parse(row.tags_json) : [], pluginAlgorithm: row.plugin_algorithm ?? undefined
      } });
    } catch (error) {
      if (!(error instanceof UnknownJobPolicyError)) throw error;
      // Explicit quarantine in the projection. Legacy execution remains responsible
      // for its existing unsupported-type handling, never silently use a default lane.
      result.unknown.push({ id: row.id, jobType: row.job_type });
      logger.warn("scheduler.unregistered_job", { jobId: row.id, jobType: row.job_type });
      policy = { queueLane: "unregistered", resourceClass: "unregistered",
        basePriority: 0, policyVersion: JOB_POLICY_VERSION };
    }
    this.db.prepare(`UPDATE ${table} SET queue_lane = ?, resource_class = ?, base_priority = ?, policy_version = ? WHERE id = ?`)
      .run(policy.queueLane, policy.resourceClass, policy.basePriority, policy.policyVersion, row.id);
    result.refreshed++;
  }

  pendingPolicyCount(): number {
    return Number((this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM evolution_jobs WHERE policy_version IS NULL OR policy_version != ?) +
      (SELECT COUNT(*) FROM embedding_retry_queue WHERE policy_version IS NULL OR policy_version != ?) AS n`)
      .get(JOB_POLICY_VERSION, JOB_POLICY_VERSION) as { n: number }).n);
  }

  unregisteredPolicyCount(): number {
    return Number((this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM evolution_jobs WHERE queue_lane = 'unregistered') +
      (SELECT COUNT(*) FROM embedding_retry_queue WHERE queue_lane = 'unregistered') AS n`)
      .get() as { n: number }).n);
  }

  /** Fetch bounded candidates per lane/table. Type filters apply to main jobs,
   * matching legacy semantics; includeRetries separately gates the retry table. */
  candidates(input: QueueEligibilityOptions & { at: string; limit: number; includeRetries?: boolean }): SchedulingCandidate[] {
    const result: SchedulingCandidate[] = [];
    if (input.limit <= 0) return result;
    const main = mainQueueEligibility(input.at, input);
    const retry = retryQueueEligibility(Date.parse(input.at), input.targetMemoryIds);
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
    for (const lane of QUEUE_LANES) {
      const rows = this.db.prepare(`SELECT id, job_type, queue_lane, enqueue_seq, base_priority FROM evolution_jobs
        WHERE ${main.sql} AND queue_lane = ? AND policy_version = ?
        ORDER BY enqueue_seq LIMIT ?`).all(...main.params, lane, JOB_POLICY_VERSION, limit) as Array<{
          id: string; job_type: string; queue_lane: QueueLane; enqueue_seq: number; base_priority: number
        }>;
      result.push(...rows.map((row) => ({ queue: "main" as const, id: row.id, jobType: row.job_type,
        lane: row.queue_lane, enqueueSeq: row.enqueue_seq, basePriority: row.base_priority })));
      if (input.includeRetries === false) continue;
      const retries = this.db.prepare(`SELECT q.id, q.queue_lane, q.enqueue_seq, q.base_priority FROM embedding_retry_queue q
        WHERE ${retry.sql} AND q.queue_lane = ? AND q.policy_version = ?
        ORDER BY q.enqueue_seq LIMIT ?`).all(...retry.params, lane, JOB_POLICY_VERSION, limit) as Array<{
          id: string; queue_lane: QueueLane; enqueue_seq: number; base_priority: number
        }>;
      result.push(...retries.map((row) => ({ queue: "embedding_retry" as const, id: row.id, jobType: "embedding_retry",
        lane: row.queue_lane, enqueueSeq: row.enqueue_seq, basePriority: row.base_priority })));
    }
    return result;
  }
}
