/** Thrown by a job handler to put its leased job back in the queue until `runAfter`, without counting a failure. */
export class JobDeferredError extends Error {
  override readonly name = "JobDeferredError";

  constructor(readonly runAfter: string, reason: string) {
    super(reason);
  }
}
