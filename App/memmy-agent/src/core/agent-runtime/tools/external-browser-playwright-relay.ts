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
type Operation = { bridge: PlaywrightCommandBridge; leaseId: string; origin: string; signal?: AbortSignal };
type CdpMessage = { id: number; method: string; params?: Record<string, any>; sessionId?: string };

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
  readonly mainSessionId = 'memmy-page';
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
      if (request.socket.remoteAddress !== '127.0.0.1' || request.url !== this.path || this.socket) {
        socket.destroy(); return;
      }
      this.sockets.handleUpgrade(request, socket, head, ws => {
        this.socket = ws;
        ws.on('message', raw => {
          let input: CdpMessage;
          try { input = JSON.parse(String(raw)); } catch { ws.close(1003); return; }
          void this.handle(input).then(result => this.emit({ id: input.id, sessionId: input.sessionId, result }),
            error => this.emit({ id: input.id, sessionId: input.sessionId,
              error: { code: -32000, message: String(error?.message || error) } }));
        });
        ws.on('close', () => { if (this.socket === ws) this.socket = null; });
      });
    });
  }
  setFramePolicy(policy: (url: string) => boolean): void { this.allowFrame = policy; }

  async start(): Promise<string> {
    if (this.endpoint) return this.endpoint;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Browser executor relay unavailable');
    this.endpoint = `ws://127.0.0.1:${address.port}${this.path}`;
    return this.endpoint;
  }

  async begin(bridge: PlaywrightCommandBridge, origin: string, input: boolean,
    fresh: boolean, signal?: AbortSignal, uploadPaths?: string[]): Promise<{ documentEpoch: number; cdpEpoch: number; frameVersion: string }> {
    this.inputState = 'none';
    this.assertClaim(bridge, origin, signal);
    const leaseId = randomBytes(16).toString('hex');
    this.operation = { bridge, origin, leaseId, signal };
    this.lastOperation = this.operation;
    this.unsubscribe = bridge.subscribePlaywright(this.identity, event => this.onEvent(event));
    try {
      const state = await bridge.command(this.identity, 'playwrightStart',
        { leaseId, approvedOrigin: origin, input, fresh, ...(uploadPaths ? { uploadPaths } : {}) }, signal) as Record<string, any>;
      this.targetInfo = { ...state.targetInfo, browserContextId: 'memmy-selected-context', type: 'page', attached: true };
      this.frameUrls.clear();
      this.readFrameTree(state.frameTree);
      this.versionFrames = [...this.frameUrls.entries()];
      this.childDescriptions.clear();
      for (const child of state.childTargets ?? []) this.childDescriptions.set(child.targetId, child.url);
      this.assertActive();
      return { documentEpoch: Number(state.documentEpoch), cdpEpoch: Number(state.cdpEpoch),
        frameVersion: this.frameVersion() };
    } catch (error) { await this.end(); throw error; }
  }

  async end(detach = false): Promise<void> {
    const operation = this.operation ?? (detach ? this.lastOperation : null);
    this.operation = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (operation) await operation.bridge.command(this.identity, 'playwrightEnd',
      { leaseId: operation.leaseId, approvedOrigin: operation.origin, ...(detach ? { detach: true } : {}) }).catch(() => undefined);
    if (detach) this.lastOperation = null;
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
    if (event.method === 'Memmy.executorRevoked') { this.socket?.close(1000, 'Browser action revoked'); return; }
    try { this.assertActive(); } catch { this.socket?.close(1000, 'Browser action revoked'); return; }
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
      result = await operation.bridge.command(this.identity, 'playwrightCdp', {
        leaseId: operation.leaseId, approvedOrigin: operation.origin, method, params: commandParams,
        ...(sessionId !== this.mainSessionId ? { sessionId } : {}),
      }, operation.signal) as Record<string, any>;
      if (mutation) this.inputState = 'confirmed';
    } catch (error) {
      if (mutation && (error as Error).message === 'USER_ACTIVE_ON_TARGET_TAB') this.inputState = previousState;
      throw error;
    }
    this.assertActive();
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

  async close(): Promise<void> {
    await this.end(true);
    this.socket?.terminate(); this.socket = null;
    this.sockets.close();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.endpoint = '';
  }
}
