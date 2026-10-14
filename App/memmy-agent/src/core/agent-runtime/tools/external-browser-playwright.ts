import { randomBytes } from 'node:crypto';
import type { Browser, Frame, Locator, Page } from 'playwright';
import type { BrowserScope } from './browser.js';
import type { ExternalBrowserClaim } from './external-browser-bridge.js';
import { ExternalBrowserPlaywrightRelay, type PlaywrightCommandBridge } from './external-browser-playwright-relay.js';

type NodeInfo = { ref: string; role: string; name: string; value: string; state?: Record<string, unknown> };
export const EXTERNAL_BROWSER_SNAPSHOT_BUDGET = { nodes: 800, characters: 60_000, frames: 32 } as const;
type Reference = NodeInfo & { framePath: number[]; url: string; timeOrigin: number };
type Session = {
  key: string; scopeKey: string; relay: ExternalBrowserPlaywrightRelay; browser: Browser | null;
  page: Page | null; epoch: string; refs: Map<string, Reference>; idleTimer?: NodeJS.Timeout;
};
const sessions = new Map<string, Session>();
const queues = new Map<string, Promise<unknown>>();
const scopeKey = (scope: BrowserScope) => JSON.stringify([scope.sessionKey, scope.channel, scope.chatId]);
const sessionKey = (scope: BrowserScope, claim: ExternalBrowserClaim) => `${scopeKey(scope)}:${claim.connectionId}:${claim.tabId}`;
const INPUT_ACTIONS = new Set(['click', 'type', 'selectOption', 'pressKey', 'scroll', 'upload']);

// This standards-based DOM view assigns refs to real Elements (including the
// parents of visible text nodes). Playwright's public locators execute actions.
function snapshotExpression(nonce: string, query?: { text?: string; regex?: string }): string {
  return `(() => {
    const nonce=${JSON.stringify(nonce)}, query=${JSON.stringify(query ?? {})}, nodes=[], seen=new Set();
    let characters=0,scanned=0,truncated=false;
    const raw=query.regex||'', match=/^\\/(.*)\\/([imsu]*)$/.exec(raw);
    const pattern=raw?(match?new RegExp(match[1],match[2]):new RegExp(raw)):null;
    const matches=value => pattern?pattern.test(value):!query.text||value.toLowerCase().includes(query.text.toLowerCase());
    const visible=el => !!el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
    const clean=value => String(value||'').replace(/\\s+/g,' ').trim().slice(0,1000);
    const role=el => el.getAttribute('role') || ({BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',A:el.hasAttribute('href')?'link':'',SUMMARY:'button',DIALOG:'dialog'}[el.tagName]) || (el.tagName==='INPUT' ? ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',range:'slider'}[el.type]||'textbox') : /^H[1-6]$/.test(el.tagName)?'heading':'');
    const name=el => clean(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby')||'').split(/\\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim() || Array.from(el.labels||[]).map(label=>label.innerText).join(' ') || el.getAttribute('alt') || (['INPUT','TEXTAREA'].includes(el.tagName)?el.getAttribute('placeholder'):el.innerText) || el.getAttribute('title'));
    const add=(el,r,n) => {
      if(seen.has(el)||!visible(el)||el.closest('[aria-hidden="true"]'))return;
      seen.add(el); const ref='pw-'+nonce+'-'+nodes.length;
      const state={};
      for(const [attribute,key] of [['aria-checked','checked'],['aria-expanded','expanded'],['aria-selected','selected'],['aria-disabled','disabled']]) {
        if(el.hasAttribute(attribute))state[key]=el.getAttribute(attribute)==='true'?true:el.getAttribute(attribute)==='false'?false:el.getAttribute(attribute);
      }
      if(['checkbox','radio'].includes(el.type))state.checked=el.checked;
      if('disabled' in el)state.disabled=el.disabled;
      if('readOnly' in el)state.readOnly=el.readOnly;
      if(el.tagName==='SELECT') {
        const options=Array.from(el.options), filtered=options.filter(option=>matches(clean(option.text)+' '+option.value));
        state.options=filtered.slice(0,25).map(option=>({label:clean(option.text).slice(0,200),value:String(option.value).slice(0,200),selected:option.selected,disabled:option.disabled}));
        if(filtered.length>25)state.optionsTruncated=true;
      }
      const node={ref,role:r||'text',name:clean(n),value:el.tagName==='INPUT'&&el.type==='password'?'':clean(el.value),...(Object.keys(state).length?{state}:{})};
      if(!matches(node.role+' '+node.name+' '+node.value+' '+JSON.stringify(state)))return;
      const size=JSON.stringify(node).length;
      if(nodes.length>=600||characters+size>40000){truncated=true;return;}
      characters+=size;el.setAttribute('data-memmy-playwright-ref',ref);nodes.push(node);
    };
    const controls=root => {
      for(const el of root.querySelectorAll('button,a[href],input,select,textarea,summary,[role]')) {
        if(++scanned>15000){truncated=true;break;}
        const r=role(el);if(/^(button|link|textbox|combobox|checkbox|radio|switch|slider|spinbutton|tab|menuitem|menuitemcheckbox|menuitemradio)$/.test(r))add(el,r,name(el));
      }
    };
    const walk=(root,scan=false) => {
      if(scan)controls(root);
      for(const child of root.childNodes) {
        if(++scanned>15000||nodes.length>=600){truncated=true;break;}
        if(child.nodeType===1) {
          if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','IFRAME'].includes(child.tagName))continue;
          const r=role(child); if(r)add(child,r,name(child));
          if(child.shadowRoot)walk(child.shadowRoot,true);
          walk(child);
        } else if(child.nodeType===3&&clean(child.textContent)) {
          const parent=child.parentElement,el=parent?.tagName==='LABEL'&&parent.control?parent.control:parent;
          if(el)add(el,role(el)||'text',role(el)?name(el):el.innerText||child.textContent);
        }
      }
    };
    walk(document.body||document.documentElement,true);
    return {nodes,timeOrigin:performance.timeOrigin,url:location.href,truncated};
  })()`;
}

function frameAt(page: Page, path: number[]): Frame | null {
  let frame: Frame | undefined = page.mainFrame();
  for (const index of path) frame = frame?.childFrames()[index];
  return frame ?? null;
}

async function capture(session: Session, allowFrame: (url: string) => boolean,
  query?: { text?: string; regex?: string }): Promise<{ nodes: NodeInfo[]; truncated: boolean }> {
  const nonce = randomBytes(8).toString('hex');
  const refs = new Map<string, Reference>();
  const nodes: NodeInfo[] = [];
  let visitedFrames = 0, characters = 0, truncated = false;
  const visit = async (frame: Frame, framePath: number[]) => {
    if (++visitedFrames > EXTERNAL_BROWSER_SNAPSHOT_BUDGET.frames) { truncated = true; return; }
    // Existing OOPIFs can initially have an empty public Frame.url() after
    // CDP attachment. Read only location first, then check policy before DOM.
    const url = await frame.evaluate('location.href') as string;
    if (url !== 'about:blank' && url !== 'about:srcdoc' && !allowFrame(url)) return;
    const captured = await frame.evaluate(snapshotExpression(`${nonce}${framePath.join('a') || 'b'}`, query)) as {
      nodes: NodeInfo[]; timeOrigin: number; url: string; truncated: boolean };
    truncated ||= captured.truncated;
    if (url !== captured.url) throw new Error('Browser frame changed during observation');
    for (const node of captured.nodes) {
      const size = JSON.stringify(node).length;
      if (nodes.length >= EXTERNAL_BROWSER_SNAPSHOT_BUDGET.nodes
        || characters + size > EXTERNAL_BROWSER_SNAPSHOT_BUDGET.characters) { truncated = true; continue; }
      characters += size;
      refs.set(node.ref, { ...node, framePath, url: captured.url, timeOrigin: captured.timeOrigin });
      nodes.push(node);
    }
    for (const [index, child] of frame.childFrames().entries()) await visit(child, [...framePath, index]);
  };
  await visit(session.page!.mainFrame(), []);
  session.refs = refs;
  return { nodes, truncated };
}

async function target(session: Session, value: unknown, allowFrame: (url: string) => boolean): Promise<Locator> {
  const raw = String(value || '').trim();
  const text = /^\[(pw-[a-f0-9]+-\d+)\]$/.exec(raw)?.[1] ?? raw;
  if (!text || text.length > 2000) throw new Error('A page element reference or selector is required');
  if (!text.startsWith('pw-')) {
    if (/^ax-\d+$/.test(text)) throw new Error('This element reference is stale. Read browser_snapshot again.');
    return session.page!.locator(text);
  }
  const reference = session.refs.get(text);
  if (!reference) throw new Error('This element reference is stale. Read browser_snapshot again.');
  const frame = frameAt(session.page!, reference.framePath);
  if (!frame || !allowFrame(reference.url)) {
    throw new Error('This element frame changed or is blocked. Read browser_snapshot again.');
  }
  const current = await frame.evaluate('({url:location.href,timeOrigin:performance.timeOrigin})') as { url: string; timeOrigin: number };
  if (current.url !== reference.url || current.timeOrigin !== reference.timeOrigin) {
    throw new Error('This element document changed. Read browser_snapshot again.');
  }
  const locator = frame.locator(`[data-memmy-playwright-ref=${JSON.stringify(text)}]`);
  if (await locator.count()) return locator;
  // A framework may replace a node within the same document. Re-resolve a
  // unique semantic target; Playwright's strict matching rejects ambiguity.
  if (reference.name && ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'heading'].includes(reference.role)) {
    return frame.getByRole(reference.role as Parameters<Frame['getByRole']>[0], { name: reference.name, exact: true });
  }
  if (reference.name) return frame.getByText(reference.name, { exact: true });
  throw new Error('This element was removed. Read browser_snapshot again.');
}

async function dispose(session: Session): Promise<void> {
  clearTimeout(session.idleTimer);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  // Closing the relay disconnects Playwright without closing the user's tab.
  await session.relay.close();
  session.browser = null; session.page = null;
}

export async function closeExternalBrowserPlaywrightScope(scope: BrowserScope): Promise<void> {
  const key = scopeKey(scope);
  await Promise.allSettled([...sessions.values()].filter(session => session.scopeKey === key).map(dispose));
}

export async function closeAllExternalBrowserPlaywright(): Promise<void> {
  await Promise.allSettled([...sessions.values()].map(dispose));
}

/** Ordinary browser actions only; this does not accept model CDP or JavaScript. */
export async function executeExternalBrowserPlaywright(bridge: PlaywrightCommandBridge,
  claim: ExternalBrowserClaim, scope: BrowserScope, action: string, args: Record<string, any>,
  allowFrame: (url: string) => boolean, signal?: AbortSignal): Promise<Record<string, any>> {
  const key = sessionKey(scope, claim);
  const tabKey = `${claim.connectionId}:${claim.tabId}`;
  const previous = queues.get(tabKey) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(async () => {
    if (signal?.aborted) throw new Error('Browser executor cancelled');
    let session = sessions.get(key);
    if (!session) {
      session = { key, scopeKey: scopeKey(scope), relay: new ExternalBrowserPlaywrightRelay(claim, allowFrame),
        browser: null, page: null, epoch: '', refs: new Map() };
      sessions.set(key, session);
    }
    clearTimeout(session.idleTimer);
    session.relay.setFramePolicy(allowFrame);
    const origin = new URL(claim.url).origin;
    const abort = () => { void dispose(session!); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (claim.browser === 'memmy' && action === 'screenshot') throw new Error('Screenshots are not supported for Memmy in-app browser tabs');
      const uploadPaths = action === 'upload' ? args.paths as string[] : undefined;
      let state = await session.relay.begin(bridge, origin, INPUT_ACTIONS.has(action), !session.browser, signal, uploadPaths);
      const epoch = `${state.documentEpoch}:${state.cdpEpoch}:${state.frameVersion}`;
      if (session.browser && session.epoch !== epoch) {
        const refs = session.refs;
        await dispose(session);
        session = { key, scopeKey: scopeKey(scope), relay: new ExternalBrowserPlaywrightRelay(claim, allowFrame),
          browser: null, page: null, epoch: '', refs };
        sessions.set(key, session);
        state = await session.relay.begin(bridge, origin, INPUT_ACTIONS.has(action), true, signal, uploadPaths);
      }
      if (!session.browser) {
        const { chromium } = await import('playwright');
        const endpoint = await session.relay.start();
        session.browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true, timeout: 15_000 });
        const pages = session.browser.contexts().flatMap(context => context.pages());
        if (pages.length !== 1) throw new Error('Browser executor did not receive exactly the selected tab');
        session.page = pages[0];
        session.page.setDefaultTimeout(8_000);
      }
      session.epoch = `${state.documentEpoch}:${state.cdpEpoch}:${session.relay.frameVersion()}`;
      const page = session.page!;
      const observed = async (result: Record<string, unknown>) => ({ ...result,
        observation: await capture(session!, allowFrame) });
      switch (action) {
        case 'consoleMessages': return { messages: session.relay.consoleMessages() };
        case 'networkRequests': return { requests: session.relay.networkRequests() };
        case 'snapshot': return await capture(session, allowFrame);
        case 'find': {
          return await capture(session, allowFrame, { text: String(args.text || ''),
            regex: args.regex ? String(args.regex).slice(0, 250) : undefined });
        }
        case 'click': {
          if (Number.isFinite(args.x) && Number.isFinite(args.y)) await page.mouse.click(args.x, args.y,
            { button: args.button || 'left', clickCount: args.doubleClick ? 2 : 1 });
          else {
            const locator = await target(session, args.target || args.ref, allowFrame);
            const options = { button: args.button || 'left', modifiers: args.modifiers };
            if (args.doubleClick) await locator.dblclick(options); else await locator.click(options);
          }
          return await observed({ ok: true, inputDispatched: true });
        }
        case 'type': {
          const locator = await target(session, args.target || args.ref, allowFrame);
          const text = String(args.text || '');
          if (text.length > 100_000) throw new Error('Text is too long');
          if (args.slowly) { await locator.fill(''); await locator.pressSequentially(text); }
          else await locator.fill(text);
          if (args.submit) await locator.press('Enter');
          return await observed({ ok: true, inputDispatched: true, ...(args.submit ? { submitted: true } : {}) });
        }
        case 'selectOption': {
          const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value || '')];
          const selected = await (await target(session, args.target || args.ref, allowFrame)).selectOption(values);
          return await observed({ value: selected.length === 1 ? selected[0] : selected, values: selected });
        }
        case 'pressKey': {
          const key = String(args.key || '').replace(/\bCtrl\b/g, 'Control').replace(/\bCommand\b/g, 'Meta');
          if (!key || key.length > 50) throw new Error('Invalid key');
          await page.keyboard.press(key); return await observed({ ok: true, inputDispatched: true });
        }
        case 'scroll': await page.mouse.wheel(Number(args.deltaX) || 0, Number(args.deltaY) || 0); return await observed({ ok: true });
        case 'upload': {
          if (!Array.isArray(uploadPaths) || !uploadPaths.length || uploadPaths.length > 20
            || uploadPaths.some(file => typeof file !== 'string' || !file)) throw new Error('Approved upload paths are required');
          await (await target(session, args.target || args.ref, allowFrame)).setInputFiles(uploadPaths);
          return await observed({ ok: true, uploaded: uploadPaths.length });
        }
        case 'waitFor': {
          const timeout = Math.min(25_000, Math.max(0, Number(args.time || 0) * 1000)) || 5_000;
          const deadline = Date.now() + timeout;
          if (!args.text && !args.textGone) {
            if (args.time) await page.waitForTimeout(timeout);
          } else while (true) {
            const result = await capture(session, allowFrame);
            const text = result.nodes.map(node => `${node.name} ${node.value}`).join('\n');
            if ((!args.text || text.includes(String(args.text))) && (!args.textGone || !text.includes(String(args.textGone)))) break;
            if (Date.now() >= deadline) throw new Error('Wait condition was not met');
            await page.waitForTimeout(150);
          }
          return { ok: true };
        }
        case 'screenshot': {
          const assertScreenshotAllowed = () => {
            if (session!.relay.hasBlockedFrames() || page.frames().some(frame => !['about:blank', 'about:srcdoc'].includes(frame.url()) && !allowFrame(frame.url()))) {
              throw new Error('Screenshot includes a frame blocked by site policy');
            }
          };
          assertScreenshotAllowed();
          const type = args.type === 'jpeg' ? 'jpeg' : 'png';
          if (args.fullPage && (args.target || args.ref)) throw new Error('Choose fullPage or an element screenshot');
          const locator = args.target || args.ref ? await target(session, args.target || args.ref, allowFrame) : null;
          const data = locator ? await locator.screenshot({ type }) : await page.screenshot({ type, fullPage: args.fullPage === true });
          assertScreenshotAllowed();
          return { format: type, data: data.toString('base64') };
        }
        default: throw new Error('Unsupported Playwright browser action');
      }
    } catch (error) {
      const dispatchState = session.relay.dispatchState();
      await dispose(session);
      const message = signal?.aborted ? 'Browser executor cancelled' : String((error as Error)?.message || error);
      if (!signal?.aborted && message !== 'USER_ACTIVE_ON_TARGET_TAB' && dispatchState !== 'none') {
        return { ok: false, dispatchState, inputDispatched: dispatchState === 'confirmed',
          noActionDispatched: false, freshObservationRequired: true, error: message };
      }
      const failure = error instanceof Error && !signal?.aborted ? error : new Error(message);
      Object.assign(failure, { dispatchState, noActionDispatched: dispatchState === 'none', freshObservationRequired: true });
      if (message !== 'USER_ACTIVE_ON_TARGET_TAB') failure.message += dispatchState === 'none'
        ? ' No input was dispatched; take a fresh observation before acting.'
        : ' Input may already have been dispatched; take a fresh observation before acting.';
      throw failure;
    } finally {
      signal?.removeEventListener('abort', abort);
      await session.relay.end();
      if (sessions.get(key) === session) {
        session.idleTimer = setTimeout(() => void dispose(session!), 15_000);
        session.idleTimer.unref?.();
      }
    }
  });
  queues.set(tabKey, work);
  void work.finally(() => { if (queues.get(tabKey) === work) queues.delete(tabKey); }).catch(() => undefined);
  return work;
}
