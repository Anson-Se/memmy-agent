import type { AgentSourceRepository } from "../infrastructure/agent-source-store/index.js";

interface WaitingScan { grant(): void }
interface SourcePermit { waiting: WaitingScan[] }

/** Process-local permits shared by services using the same repository instance. */
class SourceScanAdmission {
  private readonly sources = new Map<string, SourcePermit>();

  async run<T>(sourceId: string, signal: AbortSignal | undefined, scan: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const release = await this.acquire(sourceId, signal);
    try {
      // Cancellation can occur after a waiter is granted but before it resumes.
      signal?.throwIfAborted();
      return await scan();
    } finally {
      release();
    }
  }

  private acquire(sourceId: string, signal?: AbortSignal): Promise<() => void> {
    const active = this.sources.get(sourceId);
    if (!active) {
      const permit: SourcePermit = { waiting: [] };
      this.sources.set(sourceId, permit);
      return Promise.resolve(this.releaseFor(sourceId, permit));
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiting = true;
      const cancel = () => {
        if (!waiting) return;
        waiting = false;
        const index = active.waiting.indexOf(waiter);
        if (index >= 0) active.waiting.splice(index, 1);
        signal?.removeEventListener("abort", cancel);
        // Removing a waiter never releases the active holder's source permit.
        reject(signal?.reason);
      };
      const waiter: WaitingScan = { grant: () => {
        waiting = false;
        signal?.removeEventListener("abort", cancel);
        resolve(this.releaseFor(sourceId, active));
      } };
      active.waiting.push(waiter);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  private releaseFor(sourceId: string, permit: SourcePermit): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = permit.waiting.shift();
      if (next) next.grant();
      else this.sources.delete(sourceId);
    };
  }
}

const admissions = new WeakMap<AgentSourceRepository, SourceScanAdmission>();

/** One adapter scan per source; this is not a cross-process semaphore. */
export function withAgentSourceScanPermit<T>(
  repository: AgentSourceRepository, sourceId: string, signal: AbortSignal | undefined,
  scan: () => Promise<T>
): Promise<T> {
  let admission = admissions.get(repository);
  if (!admission) { admission = new SourceScanAdmission(); admissions.set(repository, admission); }
  return admission.run(sourceId, signal, scan);
}
