import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ExternalBrowserClaim, ExternalBrowserPlaywrightEvent } from './external-browser-bridge.js';

export type PlaywrightCommandBridge = {
  command(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>, name: string,
    args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  getClaim(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): ExternalBrowserClaim | null;
  subscribePlaywright(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    listener: (event: ExternalBrowserPlaywrightEvent) => void): () => void;
};
const ACTION_DEADLINE_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 2_000;
type Operation = { bridge: PlaywrightCommandBridge; leaseId: string; origin: string; signal: AbortSignal;
  controller: AbortController; parentSignal?: AbortSignal; parentAbort: () => void;
  timer?: ReturnType<typeof setTimeout>; startedAt: number; rejectInterruption: (error: Error) => void;
  endPromise?: Promise<void>; detachPromise?: Promise<void> };
type CdpMessage = { id: number; method: string; params?: Record<string, any>; sessionId?: string };
type FrameTreeReply = { promise: Promise<void>; resolve: () => void };

/** A deliberately single-page CDP transport, using only public Playwright APIs. */
export class ExternalBrowserPlaywrightRelay {
  private readonly path = `/${randomBytes(24).toString('hex')}`;
  private readonly server = http.createServer((_req, response) => response.writeHead(404).end());
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  private socket: WebSocket | null = null;
  private operation: Operation | null = null;
  private lastOperation: Operation | null = null;
  private unsubscribe: (() => void) | null = null;
  private targetInfo: Record<string, any> = {};
  private frameUrls = new Map<string, string>();
  private childUrls = new Map<string, string>();
  private childIds = new Map<string, string>();
  private childDescriptions = new Map<string, string>();
  private versionFrames: Array<[string, string]> = [];
  private contextUrls = new Map<string, string>();
  private contextFrames = new Map<string, string>();
  private objectUrls = new Map<string, string>();
  private autoAttached = false;
  private inputState: 'none' | 'confirmed' | 'unknown' = 'none';
  private consoleRecords: Array<{ frameUrl: string; type: string; text: string }> = [];
  private networkRecords: Array<{ frameUrl: string; method: string; url: string }> = [];
  private endpoint = '';
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private stage = 'idle';
  private failure: Error | null = null;
  private interruption: Promise<never> = new Promise(() => undefined);
  private readonly frameTreeReplies = new Map<string, Set<FrameTreeReply>>();
  readonly mainSessionId = 'memmy-page';
  setStage(stage: string): void { this.stage = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(stage) ? stage : 'action'; }
  get actionError(): Error | null { return this.failure; }
  get deadlineError(): Error | null { return (this.failure as any)?.code === 'BROWSER_ACTION_DEADLINE' ? this.failure : null; }
  waitForInterruption(): Promise<never> { return this.interruption; }
  hasBlockedFrames(): boolean { return [...this.frameUrls.values(), ...this.childUrls.values()].some(url => !this.permitted(url)); }
  dispatchState(): 'none' | 'confirmed' | 'unknown' { return this.inputState; }
  frameVersion(): string { return JSON.stringify({ frames: this.versionFrames,
    children: [...this.childDescriptions.entries()].sort(([a], [b]) => a.localeCompare(b)) }); }
  consoleMessages(): Array<{ type: string; text: string }> {
    return this.consoleRecords.filter(record => this.permitted(record.frameUrl)).map(({ frameUrl: _url, ...record }) => record);
  }
  networkRequests(): Array<{ method: string; url: string }> {
    return this.networkRecords.filter(record => this.permitted(record.frameUrl)).map(({ frameUrl: _url, ...record }) => record);
  }

  constructor(readonly identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    private allowFrame: (url: string) => boolean) {
    this.server.on('upgrade', (request, socket, head) => {
      if (this.closed || request.socket.remoteAddress !== '127.0.0.1' || request.url !== this.path || this.socket) {
        socket.destroy(); return;
      }
      this.sockets.handleUpgrade(request, socket, head, ws => {
        this.socket = ws;
        ws.on('message', raw => {
          let input: CdpMessage;
          try { input = JSON.parse(String(raw)); } catch { ws.close(1003); return; }
          // Playwright installs world/context listeners after the frame-tree reply.
          // Record this synchronously, before another incoming Runtime.enable can run.
          const sessionId = input.sessionId || this.mainSessionId;
          const frameTreeReply = input.method === 'Page.getFrameTree' ? this.beginFrameTreeReply(sessionId) : null;
          void this.handle(input).then(result => {
            try {
              if (this.socket === ws) this.emit({ id: input.id, sessionId: input.sessionId, result });
            } finally { if (frameTreeReply) this.finishFrameTreeReply(sessionId, frameTreeReply); }
          }, error => {
            try {
              if (this.socket === ws) this.emit({ id: input.id, sessionId: input.sessionId,
                error: { code: -32000, message: String(error?.message || error) } });
            } finally { if (frameTreeReply) this.finishFrameTreeReply(sessionId, frameTreeReply); }
          });
        });
        ws.on('close', () => {
          if (this.socket !== ws) return;
          this.socket = null;
          if (this.operation) this.interrupt(this.operation,
            Object.assign(new Error('Browser executor transport disconnected'), { code: 'BROWSER_TRANSPORT_CLOSED' }));
          void this.close();
        });
      });
    });
  }
  setFramePolicy(policy: (url: string) => boolean): void { this.allowFrame = policy; }

  private beginFrameTreeReply(sessionId: string): FrameTreeReply {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    const reply = { promise, resolve };
    const pending = this.frameTreeReplies.get(sessionId) ?? new Set<FrameTreeReply>();
    pending.add(reply); this.frameTreeReplies.set(sessionId, pending);
    return reply;
  }

  private finishFrameTreeReply(sessionId: string, reply: FrameTreeReply): void {
    const pending = this.frameTreeReplies.get(sessionId);
    pending?.delete(reply);
    if (!pending?.size) this.frameTreeReplies.delete(sessionId);
    reply.resolve();
  }

  async start(): Promise<string> {
    if (this.closed) throw this.failure ?? new Error('Browser executor relay closed');
    if (this.endpoint) return this.endpoint;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    if (this.closed) { this.server.close(); throw this.failure ?? new Error('Browser executor relay closed'); }
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Browser executor relay unavailable');
    this.endpoint = `ws://127.0.0.1:${address.port}${this.path}`;
    return this.endpoint;
  }

  async begin(bridge: PlaywrightCommandBridge, origin: string, input: boolean,
    fresh: boolean, signal?: AbortSignal, uploadPaths?: string[]): Promise<{ documentEpoch: number; cdpEpoch: number; frameVersion: string }> {
    if (this.closed) throw this.failure ?? new Error('Browser executor relay closed');
    if (this.operation) throw new Error('Browser executor action is already active');
    this.inputState = 'none';
    this.failure = null;
    this.stage = 'lease-start';
    this.assertClaim(bridge, origin, signal);
    const leaseId = randomBytes(16).toString('hex');
    const controller = new AbortController();
    let rejectInterruption!: (error: Error) => void;
    this.interruption = new Promise<never>((_resolve, reject) => { rejectInterruption = reject; });
    // A caller can subscribe after begin; a synchronous revocation must still be handled.
    void this.interruption.catch(() => undefined);
    const operation: Operation = { bridge, origin, leaseId, controller, signal: controller.signal,
      parentSignal: signal, startedAt: Date.now(), rejectInterruption,
      parentAbort: () => { this.interrupt(operation, this.cancelledError()); void this.close(); } };
    this.operation = operation;
    this.lastOperation = operation;
    operation.timer = setTimeout(() => {
      const error = Object.assign(new Error('Browser action exceeded its 30 second deadline'), {
        code: 'BROWSER_ACTION_DEADLINE', stage: this.stage,
        elapsedMs: Math.max(0, Date.now() - operation.startedAt), tabId: this.identity.tabId,
      });
      this.interrupt(operation, error);
      void this.close();
    }, ACTION_DEADLINE_MS);
    signal?.addEventListener('abort', operation.parentAbort, { once: true });
    try {
      this.unsubscribe = bridge.subscribePlaywright(this.identity, event => this.onEvent(event));
      const state = await Promise.race([bridge.command(this.identity, 'playwrightStart',
        { leaseId, approvedOrigin: origin, input, fresh, ...(uploadPaths ? { uploadPaths } : {}) }, operation.signal),
      this.interruption]) as Record<string, any>;
      if (this.assertActive() !== operation) throw new Error('Browser executor action changed');
      this.targetInfo = { ...state.targetInfo, browserContextId: 'memmy-selected-context', type: 'page', attached: true };
      this.frameUrls.clear();
      this.readFrameTree(state.frameTree);
      this.versionFrames = [...this.frameUrls.entries()];
      this.childDescriptions.clear();
      for (const child of state.childTargets ?? []) this.childDescriptions.set(child.targetId, child.url);
      this.assertActive();
      return { documentEpoch: Number(state.documentEpoch), cdpEpoch: Number(state.cdpEpoch),
        frameVersion: this.frameVersion() };
    } catch (error) { await this.end(); throw this.failure ?? error; }
  }

  async end(detach = false): Promise<void> {
    const operation = this.operation ?? (detach ? this.lastOperation : null);
    if (this.operation === operation && operation) this.release(operation);
    if (detach && this.lastOperation === operation) this.lastOperation = null;
    if (operation) await this.cleanup(operation, detach);
  }

  private cancelledError(): Error {
    return Object.assign(new Error('Browser executor cancelled'), { name: 'AbortError', code: 'BROWSER_ACTION_CANCELLED' });
  }

  private release(operation: Operation): void {
    if (this.operation !== operation) return;
    this.operation = null;
    clearTimeout(operation.timer);
    operation.parentSignal?.removeEventListener('abort', operation.parentAbort);
    this.unsubscribe?.(); this.unsubscribe = null;
    operation.controller.abort(this.failure ?? this.cancelledError());
    for (const pending of this.frameTreeReplies.values()) for (const reply of pending) reply.resolve();
    this.frameTreeReplies.clear();
  }

  private interrupt(operation: Operation, error: Error): void {
    if (this.operation !== operation) return;
    this.failure = error;
    // Revoke before disconnecting so no queued CDP input can acquire the old lease.
    operation.rejectInterruption(error);
    this.release(operation);
    this.disconnect();
  }

  private disconnect(): void {
    const socket = this.socket; this.socket = null;
    socket?.terminate();
    for (const client of this.sockets.clients) client.terminate();
  }

  private cleanup(operation: Operation, detach: boolean): Promise<void> {
    const key = detach ? 'detachPromise' : 'endPromise';
    if (operation[key]) return operation[key]!;
    operation[key] = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(); }, CLEANUP_TIMEOUT_MS);
      });
      try {
        // Cleanup uses the captured lease, never a later task's current lease.
        await Promise.race([operation.bridge.command(this.identity, 'playwrightEnd',
          { leaseId: operation.leaseId, approvedOrigin: operation.origin, ...(detach ? { detach: true } : {}) },
          controller.signal).then(() => undefined, () => undefined), deadline]);
      } catch { /* Cleanup failure cannot prevent local disconnection or release. */ }
      finally { clearTimeout(timer); controller.abort(); }
    })();
    return operation[key]!;
  }

  private assertClaim(bridge: PlaywrightCommandBridge, origin: string, signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Browser executor cancelled');
    const claim = bridge.getClaim(this.identity);
    if (!claim || new URL(claim.url).origin !== origin) throw new Error('Browser executor tab changed');
  }

  private assertActive(): Operation {
    const operation = this.operation;
    if (!operation) throw new Error('Browser executor has no active action');
    this.assertClaim(operation.bridge, operation.origin, operation.signal);
    return operation;
  }

  private permitted(url: string | undefined): boolean {
    if (!url) return false;
    if (url === 'about:blank' || url === 'about:srcdoc') return true;
    try { return ['http:', 'https:'].includes(new URL(url).protocol) && this.allowFrame(url); }
    catch { return false; }
  }

  private readFrameTree(tree: any): void {
    if (!tree?.frame?.id) return;
    this.frameUrls.set(tree.frame.id, String(tree.frame.url || ''));
    for (const child of tree.childFrames ?? []) this.readFrameTree(child);
  }

  private pruneFrameTree(tree: any): any {
    if (!tree?.frame || !this.permitted(tree.frame.url)) return undefined;
    return { ...tree, childFrames: (tree.childFrames ?? []).map((child: any) => this.pruneFrameTree(child)).filter(Boolean) };
  }

  private emit(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onEvent(event: ExternalBrowserPlaywrightEvent): void {
    const operation = this.operation;
    if (!operation || event.leaseId !== operation.leaseId || operation.signal?.aborted) return;
    if (event.method === 'Memmy.executorRevoked') {
      this.interrupt(operation, new Error('Browser action revoked')); void this.close(); return;
    }
    try { this.assertActive(); } catch (error) {
      this.interrupt(operation, error as Error); void this.close(); return;
    }
    const params = event.params as Record<string, any>;
    if (event.method === 'Target.attachedToTarget') {
      const url = String(params.targetInfo?.url || '');
      if (params.targetInfo?.type !== 'iframe') return;
      this.childUrls.set(params.sessionId, url);
      this.childIds.set(params.sessionId, params.targetInfo.targetId);
      this.childDescriptions.set(params.targetInfo.targetId, url);
      if (!this.permitted(url)) return;
    }
    if (event.method === 'Target.targetInfoChanged' && this.childDescriptions.has(params.targetInfo?.targetId)) {
      this.childDescriptions.set(params.targetInfo.targetId, params.targetInfo.url);
      for (const [sessionId, targetId] of this.childIds) if (targetId === params.targetInfo.targetId) {
        this.childUrls.set(sessionId, params.targetInfo.url);
      }
    }
    if (event.sessionId && !this.permitted(this.childUrls.get(event.sessionId))) return;
    if (event.method === 'Page.frameNavigated') {
      this.objectUrls.clear();
      for (const [key, frameId] of this.contextFrames) if (frameId === params.frame?.id) {
        this.contextFrames.delete(key); this.contextUrls.delete(key);
      }
      this.frameUrls.set(params.frame?.id, String(params.frame?.url || ''));
      if (!this.permitted(params.frame?.url)) return;
    }
    if (event.method === 'Runtime.executionContextCreated') {
      const context = params.context;
      const url = this.frameUrls.get(context?.auxData?.frameId) || context?.origin;
      const key = `${event.sessionId || this.mainSessionId}:${context?.id}`;
      this.contextUrls.set(key, url);
      this.contextFrames.set(key, context?.auxData?.frameId);
      if (!this.permitted(url)) return;
    }
    if (event.method === 'Runtime.executionContextsCleared') {
      const prefix = `${event.sessionId || this.mainSessionId}:`;
      for (const key of this.contextUrls.keys()) if (key.startsWith(prefix)) {
        this.contextUrls.delete(key); this.contextFrames.delete(key);
      }
      this.objectUrls.clear();
    }
    if (event.method === 'Runtime.executionContextDestroyed') {
      const key = `${event.sessionId || this.mainSessionId}:${params.executionContextId}`;
      this.contextUrls.delete(key); this.contextFrames.delete(key); this.objectUrls.clear();
    }
    if (params.frameId && !this.permitted(this.frameUrls.get(params.frameId))) return;
    if (event.method === 'Runtime.consoleAPICalled') {
      const url = this.contextUrls.get(`${event.sessionId || this.mainSessionId}:${params.executionContextId}`);
      if (!this.permitted(url)) return;
      {
        this.consoleRecords.push({ frameUrl: url!, type: String(params.type || 'log'), text: (params.args ?? [])
          .map((value: any) => String(value.value ?? value.description ?? '')).join(' ').slice(0, 3000) });
        if (this.consoleRecords.length > 200) this.consoleRecords.shift();
      }
    }
    if (event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.bindingCalled') {
      const id = params.executionContextId ?? params.exceptionDetails?.executionContextId;
      if (!this.permitted(this.contextUrls.get(`${event.sessionId || this.mainSessionId}:${id}`))) return;
    }
    if (event.method === 'Log.entryAdded') return;
    if (event.method === 'Network.requestWillBeSent') {
      const url = this.frameUrls.get(params.frameId);
      if (this.permitted(url)) {
        this.networkRecords.push({ frameUrl: url!, method: String(params.request?.method || ''), url: String(params.request?.url || '').slice(0, 4096) });
        if (this.networkRecords.length > 200) this.networkRecords.shift();
      }
    }
    this.emit({ sessionId: event.sessionId || this.mainSessionId, method: event.method, params });
    if (event.method === 'Target.detachedFromTarget') {
      this.childDescriptions.delete(this.childIds.get(params.sessionId) || '');
      this.childIds.delete(params.sessionId); this.childUrls.delete(params.sessionId);
    }
  }

  async send(method: string, params: Record<string, any> = {}, sessionId = this.mainSessionId): Promise<any> {
    const operation = this.assertActive();
    if (method === 'Runtime.enable') {
      const replies = [...(this.frameTreeReplies.get(sessionId) ?? [])];
      if (replies.length) await Promise.race([Promise.all(replies.map(reply => reply.promise)), this.interruption]);
      if (this.assertActive() !== operation) throw new Error('Browser executor action changed');
    }
    if (sessionId !== this.mainSessionId && !this.permitted(this.childUrls.get(sessionId))) {
      throw new Error('Browser executor frame is unavailable or blocked');
    }
    const contextId = params.contextId ?? params.executionContextId;
    const frameUrl = params.frameId ? this.frameUrls.get(params.frameId)
      : contextId !== undefined ? this.contextUrls.get(`${sessionId}:${contextId}`)
        : params.objectId ? this.objectUrls.get(params.objectId) : undefined;
    if ((params.frameId || contextId !== undefined || params.objectId) && !this.permitted(frameUrl)) {
      throw new Error('Browser executor frame identity is unavailable or blocked');
    }
    if ((params.arguments ?? []).some((argument: any) => argument.objectId && !this.permitted(this.objectUrls.get(argument.objectId)))) {
      throw new Error('Browser executor argument belongs to an unavailable or blocked frame');
    }
    if (method === 'DOM.getDocument' && this.hasBlockedFrames() && (params.pierce || params.depth === -1)) {
      throw new Error('Browser executor cannot traverse blocked frame documents');
    }
    const resolvedUrl = frameUrl ?? (sessionId === this.mainSessionId ? operation.origin : this.childUrls.get(sessionId));
    const commandParams = method === 'Target.setAutoAttach' ? { ...params, waitForDebuggerOnStart: false,
      filter: [{ type: 'iframe', exclude: false }] } : params;
    const mutation = method === 'Input.insertText' || method === 'DOM.setFileInputFiles'
      || (method === 'Input.dispatchMouseEvent' && ['mousePressed', 'mouseWheel'].includes(params.type))
      || (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown')
      || (method === 'Runtime.callFunctionOn'
        && /\.(?:selectOptions|fill|focusNode|setInputFiles|setChecked)\(/.test(String(params.functionDeclaration || '')));
    const previousState = this.inputState;
    if (mutation && this.inputState !== 'confirmed') this.inputState = 'unknown';
    let result: Record<string, any>;
    try {
      result = await Promise.race([operation.bridge.command(this.identity, 'playwrightCdp', {
        leaseId: operation.leaseId, approvedOrigin: operation.origin, method, params: commandParams,
        ...(sessionId !== this.mainSessionId ? { sessionId } : {}),
      }, operation.signal), this.interruption]) as Record<string, any>;
      if (mutation) this.inputState = 'confirmed';
    } catch (error) {
      if (mutation && (error as Error).message === 'USER_ACTIVE_ON_TARGET_TAB') this.inputState = previousState;
      throw error;
    }
    if (this.assertActive() !== operation) throw new Error('Browser executor action changed');
    if (resolvedUrl) {
      for (const value of [result?.result, result?.object, ...(Array.isArray(result?.result)
        ? result.result.flatMap((property: any) => [property.value, property.get, property.set]) : [])]) {
        if (value?.objectId) this.objectUrls.set(value.objectId, resolvedUrl);
      }
    }
    if (method === 'DOM.describeNode' && result.node?.frameId && !this.permitted(this.frameUrls.get(result.node.frameId))) {
      throw new Error('Browser executor frame is blocked');
    }
    if (method === 'Page.getFrameTree') {
      this.readFrameTree(result.frameTree);
      return { ...result, frameTree: this.pruneFrameTree(result.frameTree) };
    }
    return result;
  }

  private async handle(message: CdpMessage): Promise<unknown> {
    if (!Number.isInteger(message.id) || typeof message.method !== 'string') throw new Error('Invalid executor CDP command');
    this.assertActive();
    if (!message.sessionId) {
      switch (message.method) {
        case 'Browser.getVersion': return { protocolVersion: '1.3', product: 'Chrome/150.0.0.0',
          revision: 'memmy', userAgent: `MemmyBrowserRelay (${process.platform === 'darwin' ? 'Macintosh'
            : process.platform === 'win32' ? 'Windows NT 10.0' : 'Linux'})`, jsVersion: '1' };
        case 'Target.setAutoAttach':
          if (!this.autoAttached) {
            this.autoAttached = true;
            this.emit({ method: 'Target.attachedToTarget', params: { sessionId: this.mainSessionId,
              targetInfo: this.targetInfo, waitingForDebugger: false } });
          }
          return {};
        case 'Target.getTargetInfo': return { targetInfo: this.targetInfo };
        case 'Target.attachToTarget':
          if (message.params?.targetId !== this.targetInfo.targetId) throw new Error('Browser executor cannot attach another tab');
          return { sessionId: this.mainSessionId };
        case 'Target.detachFromTarget': return {};
        case 'Browser.close': this.socket?.close(); return {};
        default: throw new Error(`Browser-wide CDP is unavailable: ${message.method}`);
      }
    }
    return this.send(message.method, message.params, message.sessionId);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.operation) this.interrupt(this.operation, this.cancelledError());
    // Local disconnection must not await an unresponsive extension or desktop.
    this.disconnect();
    this.sockets.close();
    if (this.server.listening) this.server.close();
    this.endpoint = '';
    this.closePromise = this.end(true);
    return this.closePromise;
  }
}
