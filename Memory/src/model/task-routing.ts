import { AsyncLocalStorage } from "node:async_hooks";
import type { MemmyConfig } from "../config/index.js";
import { providerDescriptor, type WorkerConcurrencyController } from "../service/worker/worker-concurrency.js";
import type {
  Embedder,
  LlmClient,
  LlmCompletionOptions,
  LlmMessage,
  ModelStatus
} from "./types.js";

export type MemoryModelRole = "summary" | "evolution";

export interface MemoryModelTaskContext {
  config: MemmyConfig;
  summary: LlmClient;
  evolution: LlmClient;
  embedding: Embedder;
}

export class MemoryModelTaskRouter {
  private readonly storage = new AsyncLocalStorage<MemoryModelTaskContext>();
  private readonly lifecycle = new AsyncLocalStorage<object>();
  private readonly activeTasks = new Set<object>();
  private closing = false;
  private stopped?: Promise<void>;
  private resolveStopped?: () => void;

  constructor(
    private readonly resolveContext: () => MemoryModelTaskContext,
    private readonly concurrency?: WorkerConcurrencyController
  ) {}

  client(role: MemoryModelRole): LlmClient {
    return new TaskRoutedLlmClient(role, this);
  }

  embedder(): Embedder {
    return new TaskRoutedEmbedder(this);
  }

  currentOrResolve(): MemoryModelTaskContext {
    return this.storage.getStore() ?? this.resolveContext();
  }

  /** Resolve once before admission; execution must use precisely these delegates. */
  snapshot(): MemoryModelTaskContext {
    return Object.freeze({ ...this.resolveContext() });
  }

  runWith<T>(context: MemoryModelTaskContext, operation: () => T): T {
    // A worker may already own a claim while its execution microtask is queued.
    if (this.closing && !this.concurrency?.hasActiveWorkerPermit()) throw new Error("Model task router is closing");
    return this.track(() => this.storage.run(context, operation));
  }

  request<T>(config: LlmClient["config"] | Embedder["config"], operation: () => Promise<T>, embedding = false): Promise<T> {
    return this.concurrency
      ? this.concurrency.runRequest(providerDescriptor(config, this.concurrency.limits), operation, embedding)
      : operation();
  }

  run<T>(operation: () => T): T {
    if (this.storage.getStore() && this.isActiveTask()) return operation();
    if (this.closing) throw new Error("Model task router is closing");
    return this.track(() => this.storage.run(this.resolveContext(), operation));
  }

  assertCanStop(): void {
    // An admitted worker's reentry is checked by WorkerRunner first. A foreground
    // task must not await its own completion through service.stop either.
    if (this.isActiveTask() && !this.concurrency?.hasActiveWorkerPermit()) {
      throw new Error("Cannot stop Memory service from an active foreground model task");
    }
  }

  stop(): Promise<void> {
    this.assertCanStop();
    if (this.stopped) return this.stopped;
    this.closing = true;
    this.stopped = new Promise<void>(resolve => { this.resolveStopped = resolve; });
    if (this.activeTasks.size === 0) this.resolveStopped?.();
    return this.stopped;
  }

  private track<T>(operation: () => T): T {
    const token = {};
    this.activeTasks.add(token);
    const finish = () => {
      this.activeTasks.delete(token);
      if (this.closing && this.activeTasks.size === 0) this.resolveStopped?.();
    };
    try {
      const result = this.lifecycle.run(token, operation);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).then(finish, finish);
      } else finish();
      return result;
    } catch (error) { finish(); throw error; }
  }

  private isActiveTask(): boolean {
    const token = this.lifecycle.getStore();
    return token !== undefined && this.activeTasks.has(token);
  }
}

class TaskRoutedEmbedder implements Embedder {
  constructor(private readonly router: MemoryModelTaskRouter) {}

  get config() {
    return this.delegate().config;
  }

  isRemote(): boolean {
    return this.delegate().isRemote();
  }

  embed(texts: string[], role?: "query" | "document"): Promise<number[][]> {
    return this.router.run(() => {
      const delegate = this.delegate();
      return this.router.request(delegate.config, () => delegate.embed(texts, role), true);
    });
  }

  embedOne(text: string, role?: "query" | "document"): Promise<number[]> {
    return this.router.run(() => {
      const delegate = this.delegate();
      return this.router.request(delegate.config, () => delegate.embedOne(text, role), true);
    });
  }

  status(): ModelStatus {
    return this.delegate().status();
  }

  private delegate(): Embedder {
    return this.router.currentOrResolve().embedding;
  }
}

class TaskRoutedLlmClient implements LlmClient {
  constructor(
    private readonly role: MemoryModelRole,
    private readonly router: MemoryModelTaskRouter
  ) {}

  get config() {
    return this.delegate().config;
  }

  isConfigured(): boolean {
    return this.delegate().isConfigured();
  }

  complete(
    messages: LlmMessage[],
    options: LlmCompletionOptions
  ): Promise<string> {
    return this.router.run(() => {
      const delegate = this.delegate();
      return this.router.request(delegate.config, () => delegate.complete(messages, options));
    });
  }

  completeJson<T extends Record<string, unknown>>(
    messages: LlmMessage[],
    options: LlmCompletionOptions
  ): Promise<T> {
    return this.router.run(() => {
      const delegate = this.delegate();
      return this.router.request(delegate.config, () => delegate.completeJson<T>(messages, options));
    });
  }

  status(): ModelStatus {
    return this.delegate().status();
  }

  private delegate(): LlmClient {
    return this.router.currentOrResolve()[this.role];
  }
}
