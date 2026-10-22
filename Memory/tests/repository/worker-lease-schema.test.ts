import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";

describe("worker lease schema migration", () => {
  it("keeps ordinary dedupe enqueues blocked but lets an explicit manual retry resume the original job", () => {
    usingDatabase((runtime) => {
      const at = new Date().toISOString();
      const original = {
        id: "original-summary", jobType: "trace_summary" as const, status: "queued" as const,
        dedupeKey: "summary:same-target", userId: "user", attempts: 0, maxAttempts: 3,
        payload: { source: "automatic" }, createdAt: at, updatedAt: at
      };
      runtime.enqueueJob(original);
      const [claimed] = runtime.leaseQueuedJobs(1);
      runtime.failJob(claimed!.id, "needs configuration", undefined, false, claimed, {
        blockedReason: "configuration", availableAt: new Date(Date.now() + 60_000).toISOString()
      });
      runtime.enqueueJob({ ...original, id: "ordinary-duplicate" });
      expect(runtime.getJob(original.id)).toMatchObject({ status: "failed", blockedReason: "configuration", failureCount: 1 });
      const resumed = runtime.enqueueJob({ ...original, id: "manual-duplicate", payload: { source: "memory.processing.manual_retry" } });
      expect(resumed).toMatchObject({ id: original.id, status: "queued", blockedReason: null,
        availableAt: null, attempts: 0, failureCount: 0, leaseCount: 1 });
    });
  });

  it("keeps an unchanged retry claim and preserves the pending retry deadline on duplicate enqueue", () => {
    usingDatabase((runtime) => {
      const now = Date.now();
      const retry = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "same", vectorField: "vec_summary", sourceText: "unchanged", now });
      const [claim] = runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 60_000 });
      runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "same", vectorField: "vec_summary", sourceText: "unchanged", now: now + 100 });
      expect(runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "in_progress", claimedBy: "A", leaseUntil: now + 60_000 });
      expect(runtime.isEmbeddingRetryClaimHeld(retry.id, { workerId: "A", leaseUntil: claim!.leaseUntil! }, now + 100)).toBe(true);
      runtime.markEmbeddingRetryRetryClaimed(retry.id, {
        workerId: "A", leaseUntil: now + 60_000, attempts: 1, nextAttemptAt: now + 5_000,
        error: "temporary", now: now + 100
      });
      runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "same", vectorField: "vec_summary", sourceText: "unchanged", now: now + 200 });
      expect(runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: now + 5_000 });
      expect(runtime.claimDueEmbeddingRetries({ now: now + 200, workerId: "B", leaseUntil: now + 60_000 })).toEqual([]);
    });
  });

  it("invalidates an active retry claim when its input changes instead of leaving it orphaned in progress", () => {
    usingDatabase((runtime) => {
      const now = Date.now();
      const retry = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "changed", vectorField: "vec_summary", sourceText: "old", now });
      runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 60_000 });
      runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "changed", vectorField: "vec_summary", sourceText: "new", now: now + 100 });
      expect(runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "pending", claimedBy: null, leaseUntil: null, sourceText: "new" });
      expect(runtime.markEmbeddingRetrySucceededClaimed(retry.id, { workerId: "A", leaseUntil: now + 60_000, now: now + 100 })).toBeUndefined();
      expect(runtime.claimDueEmbeddingRetries({ now: now + 100, workerId: "B", leaseUntil: now + 60_100 })).toHaveLength(1);
    });
  });

  it("resumes configuration-blocked retries without reviving permanent failures or consuming attempts", () => {
    usingDatabase((runtime) => {
      const now = Date.now();
      const configurable = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "configurable", vectorField: "vec_summary", sourceText: "configurable", now });
      const terminal = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "terminal", vectorField: "vec_summary", sourceText: "terminal", now });
      runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 60_000 });
      runtime.markEmbeddingRetryConfigurationBlockedClaimed(configurable.id, { workerId: "A", leaseUntil: now + 60_000, now: now + 100, error: "credentials missing" });
      runtime.markEmbeddingRetryFailedClaimed(terminal.id, { workerId: "A", leaseUntil: now + 60_000, now: now + 100, error: "invalid input", attempts: 1 });
      expect(runtime.getEmbeddingRetry(configurable.id)).toMatchObject({ status: "failed", blockedReason: "configuration", attempts: 0 });
      expect(runtime.requeueEmbeddingRetriesAfterRestart(now + 100)).toEqual([]);
      const resumed = runtime.resumeConfigurationBlockedEmbeddingRetries(now + 100);
      expect(resumed.map(({ after }) => after.id)).toEqual([configurable.id]);
      expect(runtime.getEmbeddingRetry(configurable.id)).toMatchObject({ status: "pending", blockedReason: null, attempts: 0 });
      expect(runtime.getEmbeddingRetry(terminal.id)).toMatchObject({ status: "failed", attempts: 1 });
    });
  });

  it("upgrades v9 without losing jobs, separates historic counters, and keeps a pre-migration backup", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-worker-lease-migration-"));
    const path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    let backup: Database.Database | undefined;
    try {
      db = new MemoryDb({ path });
      // Restore the prior v9 task-table shape to exercise an actual old file.
      db.db.exec("DROP INDEX idx_evolution_jobs_available");
      for (const column of ["lease_owner", "lease_token", "available_at", "blocked_reason",
        "failure_count", "lease_count", "lease_recovery_count"]) {
        db.db.exec(`ALTER TABLE evolution_jobs DROP COLUMN ${column}`);
      }
      db.db.exec("ALTER TABLE embedding_retry_queue DROP COLUMN blocked_reason");
      db.db.exec("DELETE FROM schema_migrations");
      const at = "2026-10-22T00:00:00.000Z";
      db.db.prepare("INSERT INTO schema_migrations VALUES ('009_token_usage_outbox', 9, ?, 'legacy')").run(at);
      const insert = db.db.prepare(`INSERT INTO evolution_jobs
        (id, job_type, status, user_id, attempts, max_attempts, leased_until, created_at, updated_at)
        VALUES (?, 'reflection', ?, 'migration-user', ?, 3, ?, ?, ?)`);
      for (const [status, attempts] of [["queued", 2], ["failed", 2], ["leased", 3],
        ["succeeded", 3], ["dead_letter", 3]] as const) {
        insert.run(status, status, attempts, status === "leased" ? "2099-01-01T00:00:00.000Z" : null, at, at);
      }
      db.close();
      db = new MemoryDb({ path });
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      const runtime = new Repositories(db.db).runtime;
      expect(runtime.getJob("queued")).toMatchObject({ attempts: 2, failureCount: 2, leaseCount: 2, leaseRecoveryCount: 0 });
      expect(runtime.getJob("failed")).toMatchObject({ failureCount: 2, leaseCount: 2 });
      expect(runtime.getJob("leased")).toMatchObject({ failureCount: 2, leaseCount: 3, leaseToken: null });
      expect(runtime.getJob("succeeded")).toMatchObject({ failureCount: 2, leaseCount: 3 });
      expect(runtime.getJob("dead_letter")).toMatchObject({ failureCount: 3, leaseCount: 3 });
      // An old lease in the future is retained until it expires.
      expect(runtime.requeueLeasedJobsAfterRestart(at)).toEqual([]);
      const backupPath = `${path}.pre-v${SCHEMA_VERSION}.bak`;
      expect(existsSync(backupPath)).toBe(true);
      backup = new Database(backupPath, { readonly: true });
      expect(backup.prepare("SELECT COUNT(*) AS n FROM evolution_jobs").get()).toEqual({ n: 5 });
      const backupColumns = backup.prepare("PRAGMA table_info(evolution_jobs)").all() as Array<{ name: string }>;
      expect(backupColumns.map((column) => column.name)).not.toContain("failure_count");
    } finally {
      backup?.close();
      if (db?.db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reopens v10 idempotently without recalculating counters or clearing current lease metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-worker-lease-idempotent-"));
    const path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      db = new MemoryDb({ path });
      db.db.prepare(`INSERT INTO evolution_jobs
        (id, job_type, status, user_id, attempts, max_attempts, lease_owner, lease_token,
         leased_until, failure_count, lease_count, lease_recovery_count, available_at, blocked_reason, created_at, updated_at)
        VALUES ('retained', 'reflection', 'leased', 'user', 2, 3, 'owner', 'token',
          '2099-01-01T00:00:00.000Z', 1, 7, 5, NULL, NULL, '2026-01-01', '2026-01-01')`).run();
      db.close();
      db = new MemoryDb({ path });
      expect(new Repositories(db.db).runtime.getJob("retained")).toMatchObject({
        status: "leased", leaseOwner: "owner", leaseToken: "token", attempts: 2,
        failureCount: 1, leaseCount: 7, leaseRecoveryCount: 5
      });
    } finally {
      if (db?.db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function usingDatabase(run: (runtime: Repositories["runtime"]) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-lease-storage-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try { run(new Repositories(db.db).runtime); }
  finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
