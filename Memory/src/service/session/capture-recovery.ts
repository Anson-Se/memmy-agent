import { AsyncLocalStorage } from "node:async_hooks";
import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import { MemoryServiceError } from "../../utils/error.js";
import { newId, stableHash } from "../../utils/id.js";

export interface CaptureCommand {
  operation: "completeTurn" | "completeSourceTurn" | "observeTool" | "compactSession" | "subagentStart" | "subagentComplete" | "useSkill";
  args: unknown[];
  userId: string;
  sessionId?: string;
}
interface CaptureContext { command: CaptureCommand; job?: EvolutionJobRecord; committed?: boolean; replay?: boolean; }

/** The request is journaled before the first external selection call. Normal
 * writes and completion of that journal entry commit in the same transaction. */
export class CaptureRecovery {
  readonly activeForegroundJobs = new Set<string>();
  private readonly context = new AsyncLocalStorage<CaptureContext>();
  constructor(private readonly repos: Repositories, private readonly onPending: () => void = () => {}) {}

  async run<T>(command: CaptureCommand, operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const context: CaptureContext = { command };
    return this.context.run(context, async () => {
      try { return await operation(); }
      catch (error) {
        if (context.job && !context.committed && this.owns(context.job)) {
          // Foreground attempts do not consume the worker's retry budget.
          const at = new Date().toISOString();
          this.repos.runtime.deferProcessingJob(context.job.id, at, at, false);
          this.onPending();
        }
        throw error;
      } finally {
        if (context.job) this.activeForegroundJobs.delete(context.job.id);
      }
    });
  }

  async replay(job: EvolutionJobRecord, execute: (command: CaptureCommand) => Promise<unknown>): Promise<void> {
    const command = job.payload.command as CaptureCommand;
    if (!command?.operation || !Array.isArray(command.args)) throw new Error("invalid capture recovery command");
    await this.context.run({ command, job, replay: true }, () => execute(command));
  }

  /** True while the worker re-runs a journaled request. */
  replaying(): boolean {
    return this.context.getStore()?.replay === true;
  }

  beforeModel(): void {
    const context = this.context.getStore();
    // Judgment workers already have durable RawTurns and their own retry job.
    if (!context || context.job) return;
    const at = new Date().toISOString();
    const key = `capture_replay:${stableHash(context.command)}`;
    context.job = this.repos.runtime.reserveCaptureReplay({
      id: newId("job"), jobType: "capture_replay", status: "leased", dedupeKey: key,
      userId: context.command.userId, sessionId: context.command.sessionId,
      payload: { command: context.command }, attempts: 0, maxAttempts: 3,
      leasedUntil: new Date(Date.now() + 10 * 60_000).toISOString(), createdAt: at, updatedAt: at
    });
    if (!context.job) throw new MemoryServiceError("conflict", "capture is already pending; its saved request will be retried");
    this.activeForegroundJobs.add(context.job.id);
    this.onPending();
  }

  commit<T>(operation: () => T): T {
    const context = this.context.getStore();
    const result = this.repos.transaction(() => {
      if (context?.job && !context.committed && !this.owns(context.job)) {
        throw new MemoryServiceError("conflict", "capture lease changed; the saved request will be retried");
      }
      const captured = operation();
      if (context?.job && !context.committed) {
        this.repos.runtime.completeCaptureReplay(context.job.id);
      }
      return captured;
    });
    // Only mark the in-memory request committed after SQLite commits too.
    if (context?.job) context.committed = true;
    return result;
  }

  private owns(job: EvolutionJobRecord): boolean {
    const current = this.repos.runtime.getJob(job.id);
    return current?.status === "leased" && current.leasedUntil === job.leasedUntil;
  }
}
