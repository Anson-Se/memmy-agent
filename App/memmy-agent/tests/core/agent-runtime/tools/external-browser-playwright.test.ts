import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeExternalBrowserPlaywright, closeAllExternalBrowserPlaywright, EXTERNAL_BROWSER_SNAPSHOT_BUDGET } from '../../../../src/core/agent-runtime/tools/external-browser-playwright.js';
import { ExternalBrowserPlaywrightRelay, type PlaywrightCommandBridge } from '../../../../src/core/agent-runtime/tools/external-browser-playwright-relay.js';
import type { ExternalBrowserClaim, ExternalBrowserPlaywrightEvent } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { BROWSER_PLAYWRIGHT_CDP_METHODS } from '@memmy/local-api-contracts';
import { emitExternalBrowserFrame } from '../../../../src/core/agent-runtime/tools/external-browser-tools.js';

const executable = process.env.MEMMY_BROWSER_TEST_EXECUTABLE || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const scope = { sessionKey: 'fixture', channel: 'test', chatId: 'fixture' };
const FIXTURE = `<body><button id="replace">Replace</button><button id="action"><span>Continue</span></button>
 <label>Name<input id="name"></label><label><input id="check" type="checkbox">Agree</label>
 <select id="select" aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
 <input id="file" type="file" aria-label="Attachment"><div id="result"></div>
 <script>document.querySelector('#action').onclick=()=>document.querySelector('#result').textContent='Done';
 document.querySelector('#replace').onclick=()=>{const el=document.querySelector('#action');const copy=el.cloneNode(true);copy.onclick=el.onclick;el.replaceWith(copy);};</script>`;

class FixtureBridge implements PlaywrightCommandBridge {
  claim: ExternalBrowserClaim;
  leaseId = '';
  documentEpoch = 0;
  private nextId = 0;
  private root: WebSocket;
  private sessionId = '';
  private children = new Set<string>();
  private childTargets = new Map<string, any>();
  private listeners = new Set<(event: ExternalBrowserPlaywrightEvent) => void>();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private stopped = false;
  private input = false;
  private uploadPaths?: string[];
  readonly methods: string[] = [];
  rejectObservation = false;

  private constructor(root: WebSocket, url: string) {
    this.root = root;
    this.claim = { connectionId: 'fixture', tabId: 1, browser: 'chrome', title: 'fixture', url, claimedAt: Date.now() };
    root.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.id) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message)); else pending?.resolve(message.result);
        return;
      }
      if (message.sessionId !== this.sessionId && !this.children.has(message.sessionId)) return;
      if (message.method === 'Target.attachedToTarget') {
        this.children.add(message.params.sessionId);
        this.childTargets.set(message.params.sessionId, message.params.targetInfo);
      }
      if (message.method === 'Target.detachedFromTarget') {
        this.children.delete(message.params.sessionId); this.childTargets.delete(message.params.sessionId);
      }
      if (message.method === 'Page.frameNavigated' && message.sessionId === this.sessionId && !message.params.frame.parentId) {
        this.claim.url = message.params.frame.url; this.documentEpoch++;
      }
      if (this.leaseId) for (const listener of this.listeners) listener({ leaseId: this.leaseId,
        method: message.method, params: message.params,
        ...(message.sessionId !== this.sessionId ? { sessionId: message.sessionId } : {}) });
    });
  }
  static async create(port: number, page: Page): Promise<FixtureBridge> {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const root = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { root.once('open', resolve); root.once('error', reject); });
    const bridge = new FixtureBridge(root, page.url());
    const targets = await bridge.send('Target.getTargets');
    const target = targets.targetInfos.find((info: any) => info.url === page.url());
    const attached = await bridge.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    bridge.sessionId = attached.sessionId;
    await bridge.send('Page.enable', {}, bridge.sessionId);
    return bridge;
  }
  getClaim = () => this.stopped ? null : this.claim;
  subscribePlaywright = (_identity: any, listener: (event: ExternalBrowserPlaywrightEvent) => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };
  command = async (_identity: any, name: string, args: Record<string, any> = {}, signal?: AbortSignal): Promise<unknown> => {
    if (name === 'playwrightEnd') { if (this.leaseId === args.leaseId) this.leaseId = ''; return {}; }
    if (signal?.aborted || this.stopped) throw new Error('Browser executor cancelled');
    if (name === 'playwrightStart') {
      this.leaseId = args.leaseId; this.input = args.input; this.uploadPaths = args.uploadPaths;
      if (args.fresh) {
        await this.send('Runtime.disable', {}, this.sessionId);
        await this.send('Target.setAutoAttach', { autoAttach: false, flatten: true, waitForDebuggerOnStart: false }, this.sessionId);
      }
      const info = await this.send('Target.getTargetInfo', {}, this.sessionId);
      const tree = await this.send('Page.getFrameTree', {}, this.sessionId);
      return { ...info, ...tree, childTargets: [...this.childTargets.values()].map(child => ({ targetId: child.targetId, url: child.url })),
        documentEpoch: this.documentEpoch, cdpEpoch: 0 };
    }
    if (name !== 'playwrightCdp' || args.leaseId !== this.leaseId) throw new Error('Invalid action lease');
    if (this.rejectObservation && JSON.stringify(args.params).includes('const nonce=')) throw new Error('Fixture observation failed');
    if (args.method !== 'DOM.setFileInputFiles' && !(BROWSER_PLAYWRIGHT_CDP_METHODS as readonly string[]).includes(args.method)) {
      throw new Error(`The production executor does not permit ${args.method}`);
    }
    if (args.method.startsWith('Input.') && !this.input) throw new Error('Observation cannot send input');
    if (args.method === 'DOM.setFileInputFiles' && JSON.stringify(args.params.files) !== JSON.stringify(this.uploadPaths)) {
      throw new Error('Upload paths are not approved');
    }
    this.methods.push(args.method);
    return this.send(args.method, args.params, args.sessionId || this.sessionId);
  };
  private send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.root.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return result;
  }
  stop(): void { this.stopped = true; }
  close(): void { this.root.terminate(); }
}

describe.skipIf(!fs.existsSync(executable))('external Playwright executor with an isolated headless Chromium fixture', () => {
  let browser: Browser;
  let page: Page;
  let bridge: FixtureBridge;
  let server: http.Server;
  let origin: string;
  beforeEach(async () => {
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(request.url?.startsWith('/frame') ? '<label>Frame name<input id="inside"></label><button>Frame action</button>'
        : request.url?.startsWith('/blocked') ? '<div>PRIVATE BLOCKED CONTENT</div><input id="private">' : FIXTURE);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const portServer = net.createServer();
    await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = (portServer.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    browser = await chromium.launch({ executablePath: executable, headless: true,
      args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
    page = await browser.newPage(); await page.goto(origin);
    bridge = await FixtureBridge.create(port, page);
  }, 30_000);
  afterEach(async () => {
    await closeAllExternalBrowserPlaywright(); bridge?.close();
    await browser?.close();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const run = (action: string, args: Record<string, any> = {}, allow = (_url: string) => true, signal?: AbortSignal) =>
    executeExternalBrowserPlaywright(bridge, bridge.claim, scope, action, args, allow, signal);

  it('resolves visible text refs, text selectors, dynamic nodes and observed form states', async () => {
    const cold = performance.now();
    const snapshot = await run('snapshot');
    const coldMs = performance.now() - cold;
    const reference = snapshot.nodes.find((node: any) => node.name === 'Continue' && node.role === 'text');
    expect(reference).toBeTruthy();
    await page.evaluate("document.querySelector('#action').replaceWith(document.querySelector('#action').cloneNode(true))");
    await page.evaluate("document.querySelector('#action').onclick=()=>document.querySelector('#result').textContent='Done'");
    const warm = performance.now();
    const clicked = await run('click', { target: `[${reference.ref}]` });
    const warmMs = performance.now() - warm;
    expect(clicked.observation.nodes.some((node: any) => node.name === 'Done')).toBe(true);
    const typed = await run('type', { target: '#name', text: 'Ada' });
    expect(typed.observation.nodes.find((node: any) => node.name === 'Name').value).toBe('Ada');
    const checked = await run('click', { target: 'text=Agree' });
    expect(checked.observation.nodes.find((node: any) => node.role === 'checkbox').state.checked).toBe(true);
    const selected = await run('selectOption', { target: '#select', values: ['b'] });
    expect(selected.observation.nodes.find((node: any) => node.role === 'combobox').state.options[1].selected).toBe(true);
    expect(bridge.methods.some(method => method.startsWith('Storage.') || method === 'Network.getCookies')).toBe(false);
    process.stdout.write(`External browser fixture timing: cold snapshot ${Math.round(coldMs)}ms; warm click+observation ${Math.round(warmMs)}ms\n`);
  });

  it('waits for an overlay to clear and handles cross-origin iframe refs', async () => {
    await page.evaluate("const overlay=document.createElement('div');overlay.id='overlay';overlay.style='position:fixed;inset:0;z-index:1000;background:white';document.body.append(overlay);setTimeout(()=>overlay.remove(),350)");
    await run('click', { target: '#action' });
    expect(await page.locator('#result').textContent()).toBe('Done');
    const frameUrl = origin.replace('127.0.0.1', 'localhost') + '/frame';
    await page.evaluate(`const iframe=document.createElement('iframe');iframe.src=${JSON.stringify(frameUrl)};document.body.append(iframe)`);
    await page.locator('iframe').contentFrame().locator('#inside').waitFor();
    const snapshot = await run('snapshot');
    const input = snapshot.nodes.find((node: any) => node.name === 'Frame name');
    expect(input).toBeTruthy();
    await run('type', { target: input.ref, text: 'Inside frame' });
    expect(await page.locator('iframe').contentFrame().locator('#inside').inputValue()).toBe('Inside frame');
  });

  it('does not return blocked iframe content or screenshots, and rejects blocked selectors', async () => {
    await page.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin + '/blocked')};document.body.append(frame)`);
    await page.locator('iframe').contentFrame().locator('#private').waitFor();
    const allow = (url: string) => !url.includes('/blocked');
    const snapshot = await run('snapshot', {}, allow);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE BLOCKED CONTENT');
    await expect(run('screenshot', {}, allow)).rejects.toThrow(/blocked/);
    const captureCount = bridge.methods.filter(method => method === 'Page.captureScreenshot').length;
    await emitExternalBrowserFrame({ command: bridge.command, getClaim: bridge.getClaim,
      subscribePlaywright: bridge.subscribePlaywright, isFrameAllowed: allow }, bridge.claim, scope);
    expect(bridge.methods.filter(method => method === 'Page.captureScreenshot')).toHaveLength(captureCount);
    await expect(run('type', { target: 'iframe >> internal:control=enter-frame >> #private', text: 'No' }, allow)).rejects.toThrow();
    expect(await page.locator('iframe').contentFrame().locator('#private').inputValue()).toBe('');
  });

  it('cancels waiting input, revokes user-stopped claims and accepts approved uploads by ref', async () => {
    const controller = new AbortController();
    const pending = run('click', { target: '#missing' }, undefined, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(/cancelled/);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-upload-fixture-'));
    const file = path.join(temporary, 'fixture.txt'); fs.writeFileSync(file, 'fixture upload');
    try {
      const snapshot = await run('snapshot');
      const reference = snapshot.nodes.find((node: any) => node.name === 'Attachment');
      const uploaded = await run('upload', { target: reference.ref, paths: [file] });
      expect(uploaded.uploaded).toBe(1);
      expect(await page.locator('#file').evaluate((el: any) => el.files[0].name)).toBe('fixture.txt');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    bridge.stop();
    await expect(run('click', { target: '#action' })).rejects.toThrow(/changed|cancelled/);
  });

  it('denies browser-wide CDP and other targets even during an active action', async () => {
    const relay = new ExternalBrowserPlaywrightRelay(bridge.claim, () => true);
    await relay.begin(bridge, origin, false, true);
    const endpoint = await relay.start();
    const socket = new WebSocket(endpoint);
    await new Promise<void>(resolve => socket.once('open', resolve));
    const send = (method: string, params = {}) => new Promise<any>(resolve => {
      socket.once('message', raw => resolve(JSON.parse(String(raw)))); socket.send(JSON.stringify({ id: 1, method, params }));
    });
    expect((await send('Storage.getCookies')).error.message).toMatch(/Browser-wide/);
    expect((await send('Target.attachToTarget', { targetId: 'other-tab' })).error.message).toMatch(/another tab/);
    await expect(relay.send('Runtime.evaluate', { expression: 'document.body.innerText', contextId: 987654321 })).rejects.toThrow(/identity.*blocked/);
    socket.terminate(); await relay.close();
  });

  it('uses the same executor for Memmy tabs and reports input sent when the post-action observation fails', async () => {
    bridge.claim.browser = 'memmy';
    const snapshot = await run('snapshot');
    expect(snapshot.nodes.some((node: any) => node.name === 'Continue')).toBe(true);
    await expect(run('screenshot')).rejects.toThrow(/not supported/);
    await run('snapshot');
    bridge.rejectObservation = true;
    const failedObservation = await run('click', { target: '#action' });
    expect(failedObservation).toMatchObject({ ok: false, dispatchState: 'confirmed',
      inputDispatched: true, noActionDispatched: false, freshObservationRequired: true });
    expect(await page.locator('#result').textContent()).toBe('Done');
  });

  it('rejects references from a reloaded document and supports unique :has-text selectors', async () => {
    const snapshot = await run('snapshot');
    const reference = snapshot.nodes.find((node: any) => node.role === 'button' && node.name === 'Continue');
    await page.reload();
    await expect(run('click', { target: reference.ref })).rejects.toThrow(/document changed/);
    expect(await page.locator('#result').textContent()).toBe('');
    const current = await run('click', { target: 'button:has-text("Continue")' });
    expect(current.observation.nodes.some((node: any) => node.name === 'Done')).toBe(true);
  });

  it('bounds large tables and many frames across the whole observation, while a narrow find reaches a deep control', async () => {
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const table = doc.createElement('div');
      table.innerHTML = Array.from({ length: 2200 }, (_, index) => `<span>Row ${index} ${'x'.repeat(100)}</span>`).join('');
      doc.body.prepend(table);
      const deep = doc.createElement('button'); deep.textContent = 'Deep unique action'; doc.body.append(deep);
      for (let index = 0; index < 35; index++) {
        const frame = doc.createElement('iframe'); frame.srcdoc = `<button>Nested ${index}</button>`; doc.body.append(frame);
      }
    });
    await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('iframe').length === 35);
    const snapshot = await run('snapshot');
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes.length).toBeLessThanOrEqual(EXTERNAL_BROWSER_SNAPSHOT_BUDGET.nodes);
    expect(JSON.stringify(snapshot.nodes).length).toBeLessThan(EXTERNAL_BROWSER_SNAPSHOT_BUDGET.characters + 1000);
    const found = await run('find', { text: 'Deep unique action' });
    expect(found.nodes.some((node: any) => node.name === 'Deep unique action')).toBe(true);
    expect(found.truncated).toBe(true);
  });

  it('discards screenshot bytes when a frame navigates to a blocked site during capture', async () => {
    await page.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin + '/frame')};document.body.append(frame)`);
    await page.locator('iframe').contentFrame().locator('#inside').waitFor();
    const command = bridge.command;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await command(...args);
      if (args[1] === 'playwrightCdp' && args[2]?.method === 'Page.captureScreenshot') {
        await page.locator('iframe').evaluate((el: any, url: string) => { el.src = url; }, origin + '/blocked');
        await page.locator('iframe').contentFrame().locator('#private').waitFor();
      }
      return result;
    };
    await expect(run('screenshot', {}, url => !url.includes('/blocked'))).rejects.toThrow(/blocked/);
  });

  it('blocks untargeted click, keyboard and wheel before input when an iframe is denied, while allowed DOM targets still work', async () => {
    await page.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin + '/blocked')};document.body.append(frame)`);
    const privateInput = page.locator('iframe').contentFrame().locator('#private');
    await privateInput.waitFor(); await privateInput.focus();
    const allow = (url: string) => !url.includes('/blocked');
    for (const [action, args] of [
      ['click', { x: 20, y: 180 }], ['pressKey', { key: 'A' }], ['scroll', { deltaY: 300 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const inputCount = bridge.methods.filter(method => method.startsWith('Input.')).length;
      await expect(run(action, args, allow)).rejects.toThrow(/Untargeted input.*blocked/);
      expect(bridge.methods.filter(method => method.startsWith('Input.'))).toHaveLength(inputCount);
    }
    expect(await privateInput.inputValue()).toBe('');
    const allowed = await run('click', { target: '#action' }, allow);
    expect(allowed.ok).toBe(true);
    expect(await page.locator('#result').textContent()).toBe('Done');
  });
});
