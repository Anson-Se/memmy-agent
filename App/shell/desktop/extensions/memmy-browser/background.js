/* global chrome */
"use strict";

// After installation the extension connects to Memmy and operates ordinary
// http(s) pages. Internal browser pages stay out of reach. Keep BRIDGE_PORTS
// aligned with EXTERNAL_BROWSER_BRIDGE_PORTS in external-browser-bridge.ts.
const BRIDGE_PORTS = [47321, 47322, 47323];
// Memmy updates replace these files in place, but Chrome keeps running the worker script it
// registered at install, even across browser restarts, until the extension reloads.
// Must equal "version" in manifest.json.
const EXTENSION_VERSION = "1.0.4";
// Chrome stops an idle MV3 worker about 30 seconds after Memmy goes away, which ends
// the setTimeout retries. The alarm wakes the worker so it reconnects once Memmy is back.
const RECONNECT_ALARM = "memmy-reconnect";
const RECONNECT_ALARM_MINUTES = 0.5;
// Quick retries cover a gateway restart. After them only the alarm retries, because
// Chrome delays this worker's WebSocket attempts further as failures accumulate.
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];
// Chrome may hold a throttled attempt for up to 5 seconds before connecting. Closing it
// sooner counts as another failure and keeps every later attempt throttled.
const CONNECT_TIMEOUT_MS = 6_000;
const READY_TIMEOUT_MS = 800;
// Chrome and Edge show a "started debugging this browser" bar while any tab is
// attached, so a page is attached only while Memmy is operating it.
const DEBUGGER_IDLE_DETACH_MS = 15_000;
// Closing that bar detaches every attached tab with canceled_by_user. Memmy's own
// rescans wait this long before offering those pages again; the popup resumes at once.
const USER_CANCEL_COOLDOWN_MS = 10_000;
const USER_CANCELLED_REASON = "你关闭了浏览器顶部的“Memmy 已开始调试此浏览器”提示，Memmy 已停止操作这个网页。需要继续时，在 Memmy 里重新发起请求，或点击浏览器工具栏中的 Memmy 图标选择“重新连接”。";
const COMMANDS_WITHOUT_DEBUGGER = new Set(["allowOrigin", "tabState", "open", "activate"]);
// Reported in the handshake so Memmy can tell an outdated installed copy from a slow one.
const EXTENSION_CAPABILITIES = ["openTab"];
const OPEN_TAB_READY_MS = 10_000;
// Chrome's openerTabId names the tab that was active, not a background tab whose
// link opened the new tab. A Page.windowOpen is paired with a tab created within
// this window whose URL matches or is not known yet (link tabs start without one).
const OPEN_MATCH_WINDOW_MS = 3_000;
const pageOpens = [];
const createdTabs = new Map();
const sourceTabs = new Map();
const claims = new Map();
const pausedTabs = new Map();
const tabStatuses = new Map();
const debuggerTasks = new Map();
const idleDetachTimers = new Map();
const tabCommandCounts = new Map();
let discoverScanTask = null;
let connectTask = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let reloadCheckTask = null;
let sessionLive = false;
const runningCommands = new Set();
const cancelledCommands = new Set();
const protectedCredentialTabs = new Set();
const protectedCredentialOrigins = new Map();
const authWindows = new Map();
let credentialProtectionLoad = null;
let credentialProtectionWrite = Promise.resolve();
let socket = null;
let ready = null;
let historyFocusSequence = 0;
let historyFocusEpoch = 0;
const HISTORY_FOCUS_REFRESH_MS = 2_000;

function pageOrigin(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("This page cannot be connected");
  return parsed.origin;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function invalidateHistoryFocus() {
  historyFocusEpoch++;
  send({ type: "history_focus", browser: browserName(), sequence: ++historyFocusSequence,
    observedAt: Date.now(), focused: false, mode: "unknown" });
}

// Read only browser-owned focus/tab metadata. No debugger, page DOM, screenshot,
// or history content is read here. The actual observation time survives service
// file refreshes, and a focus/navigation event invalidates pending async reads.
async function refreshHistoryFocus() {
  invalidateHistoryFocus();
  const epoch = historyFocusEpoch;
  const observedAt = Date.now();
  if (!chrome.windows?.getLastFocused || !chrome.tabs?.query) return;
  try {
    const window = await chrome.windows.getLastFocused();
    if (epoch !== historyFocusEpoch || window.focused !== true || !Number.isSafeInteger(window.id)) return;
    const tabs = await chrome.tabs.query({ active: true, windowId: window.id });
    if (epoch !== historyFocusEpoch || tabs.length !== 1) return;
    const tab = tabs[0];
    if (!Number.isSafeInteger(tab.id) || tab.windowId !== window.id || tab.active !== true) return;
    const [currentWindow, currentTab] = await Promise.all([
      chrome.windows.get(window.id), chrome.tabs.get(tab.id),
    ]);
    if (epoch !== historyFocusEpoch || currentWindow.focused !== true || currentTab.active !== true
      || currentTab.windowId !== window.id || currentTab.url !== tab.url
      || currentTab.pendingUrl || currentTab.status === "loading") return;
    const privateWindow = currentWindow.incognito === true || currentTab.incognito === true;
    const protectedPage = protectedCredentialTabs.has(tab.id) || claims.get(tab.id)?.credentialProtected;
    let mode = privateWindow ? "private" : "unknown";
    if (!privateWindow && !protectedPage && currentWindow.incognito === false && currentTab.incognito === false) {
      try { pageOrigin(currentTab.url || ""); mode = "normal"; } catch { /* Internal/unknown page. */ }
    }
    send({ type: "history_focus", browser: browserName(), sequence: ++historyFocusSequence,
      observedAt, focused: true, mode, tabId: currentTab.id, windowId: window.id,
      title: "",
      url: mode === "normal" ? currentTab.url : "" });
  } catch { /* An unavailable API leaves the already-published unknown state. */ }
}

async function loadCredentialProtection() {
  if (!chrome.storage?.session) return;
  if (!credentialProtectionLoad) {
    credentialProtectionLoad = chrome.storage.session.get(['protectedCredentialTabs', 'protectedCredentialOrigins']).then(value => {
      for (const tabId of value.protectedCredentialTabs || []) {
        if (Number.isSafeInteger(tabId) && tabId > 0) protectedCredentialTabs.add(tabId);
      }
      for (const [id, site] of Object.entries(value.protectedCredentialOrigins || {})) {
        const tabId = Number(id);
        try { if (protectedCredentialTabs.has(tabId) && pageOrigin(site) === site)
          protectedCredentialOrigins.set(tabId, site); }
        catch { /* Ignore corrupt stored origins. */ }
      }
    });
  }
  return credentialProtectionLoad;
}

async function persistCredentialProtection() {
  if (!chrome.storage?.session) throw new Error('Browser credential protection storage is unavailable');
  const tabIds = [...protectedCredentialTabs];
  const origins = Object.fromEntries(protectedCredentialOrigins);
  credentialProtectionWrite = credentialProtectionWrite.catch(() => undefined)
    .then(() => chrome.storage.session.set({ protectedCredentialTabs: tabIds,
      protectedCredentialOrigins: origins }));
  await credentialProtectionWrite;
}

async function protectCredentialTab(tabId, site) {
  invalidateHistoryFocus();
  await loadCredentialProtection();
  protectedCredentialTabs.add(tabId);
  protectedCredentialOrigins.set(tabId, pageOrigin(site));
  const claim = claims.get(tabId);
  if (!claim) throw new Error('Browser tab is no longer connected');
  claim.credentialProtected = true;
  claim.credentialRecoveryOrigin = pageOrigin(site);
  claim.cdpEvents = []; claim.console = []; claim.requests = [];
  wakeCdpWaiters(claim);
  // Do not fill the password when protection cannot survive MV3 worker suspension.
  await persistCredentialProtection();
  await publishClaim(tabId, await chrome.tabs.get(tabId));
  await refreshHistoryFocus();
}

function browserName() {
  return /Edg\//.test(navigator.userAgent) ? "edge" : "chrome";
}

function scheduleReconnect() {
  if (reconnectTimer || typeof chrome.tabs?.query !== "function") return;
  const delay = RECONNECT_DELAYS_MS[reconnectAttempt];
  if (delay === undefined) return;
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect().catch(() => scheduleReconnect());
  }, delay);
}

async function connect() {
  if (ready && (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING)) return ready;
  if (connectTask) return connectTask;
  connectTask = (async () => {
    let lastError = new Error("Cannot connect to Memmy");
    for (const port of BRIDGE_PORTS) {
      try {
        await connectPort(port);
        void discoverOpenTabs().catch(() => undefined);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : lastError;
      }
    }
    throw lastError;
  })().finally(() => { connectTask = null; });
  return connectTask;
}

function connectPort(port) {
  if (socket) {
    const previous = socket;
    socket = null;
    ready = null;
    try { previous.close(); } catch { /* Starting another port. */ }
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  let socketKeepalive = null;
  let historyFocusRefresh = null;
  socket = ws;
  ready = new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const giveUp = () => { ws.close(); fail(new Error("Memmy did not respond")); };
    let timeout = setTimeout(giveUp, CONNECT_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      if (settled || socket !== ws) return;
      clearTimeout(timeout);
      timeout = setTimeout(giveUp, READY_TIMEOUT_MS);
      ws.send(JSON.stringify({ type: "hello", browser: browserName(), capabilities: EXTENSION_CAPABILITIES }));
    });
    ws.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "ready") {
        if (settled) return;
        settled = true;
        sessionLive = true;
        reconnectAttempt = 0;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        clearTimeout(timeout);
        socketKeepalive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 20000);
        void refreshHistoryFocus();
        historyFocusRefresh = setInterval(() => void refreshHistoryFocus(), HISTORY_FOCUS_REFRESH_MS);
        resolve();
      } else if (message.type === "command") {
        void handleCommand(message);
      } else if (message.type === "refresh_tabs" && typeof message.id === "string") {
        void discoverOpenTabs(true).then(() => send({ type: "response", id: message.id, ok: true }),
          () => send({ type: "response", id: message.id, ok: false, error: "无法刷新浏览器页面，请稍后重试。" }));
      } else if (message.type === "open_tab" && typeof message.id === "string") {
        void openTab(message.url, message.sourceTabId).then(result => send({ type: "response", id: message.id, ok: true, result }),
          error => send({ type: "response", id: message.id, ok: false, error: String(error?.message || error) }));
      } else if (message.type === "cancel" && typeof message.id === "string" && runningCommands.has(message.id)) {
        cancelledCommands.add(message.id);
      }
    });
    ws.addEventListener("error", () => fail(new Error("Cannot connect to Memmy")));
    ws.addEventListener("close", () => {
      clearInterval(socketKeepalive);
      clearInterval(historyFocusRefresh);
      if (socket === ws) {
        socket = null;
        ready = null;
        for (const tabId of [...claims.keys()]) void unclaim(tabId, false);
        if (sessionLive) {
          sessionLive = false;
          scheduleReconnect();
        }
      }
      fail(new Error("Cannot connect to Memmy"));
    });
  });
  return ready;
}

async function publishClaim(tabId, tab) {
  if (!claims.has(tabId)) return;
  let active = tab.active === true;
  if (active && chrome.windows?.get) {
    try { active = (await chrome.windows.get(tab.windowId)).focused === true; }
    catch { active = false; }
  }
  const protectedPage = protectedCredentialTabs.has(tabId) || claims.get(tabId).credentialProtected;
  send({ type: "claim", tabId, title: protectedPage ? "受保护页面" : tab.title || "",
    url: protectedPage ? claims.get(tabId).credentialRecoveryOrigin : tab.url, browser: browserName(), active: !protectedPage && active,
    ...(Number.isSafeInteger(sourceTabs.get(tabId) ?? tab.openerTabId)
      ? { openerTabId: sourceTabs.get(tabId) ?? tab.openerTabId } : {}) });
  publishTabStatus(tab, protectedPage ? "protected" : "ready",
    protectedPage ? "此页面正在保护登录信息，暂时不能读取或操作。" : "页面已就绪。", active);
}

function publishTabStatus(tab, status, reason, active = false) {
  if (!Number.isSafeInteger(tab?.id)) return;
  const hidden = tab.incognito === true || protectedCredentialTabs.has(tab.id) || claims.get(tab.id)?.credentialProtected;
  const unsupported = status === "unsupported";
  const url = hidden ? "" : unsupported
    ? (/^(?:chrome:|edge:|about:)/.test(tab.url || "") ? tab.url : "") : tab.url || "";
  const value = { type: "tab_status", browser: browserName(), tabId: tab.id,
    title: hidden ? "受保护页面" : unsupported ? "浏览器内部页面" : tab.title || "", url,
    active: !hidden && active, status: tab.incognito === true ? "unsupported" : hidden && status === "ready" ? "protected" : status,
    reason: tab.incognito === true ? "私密浏览窗口不会接入。" : reason,
    ...(tab.incognito === true ? { private: true } : {}),
    ...(hidden && tab.incognito !== true ? { protected: true } : {}) };
  tabStatuses.set(tab.id, value);
  send(value);
}

function attachFailureReason(error) {
  const value = String(error?.message || error);
  if (/cannot attach|cannot access|not allowed|permission|denied/i.test(value))
    return "浏览器不允许 Memmy 操作此页面，请换一个普通网页后重试。";
  return "Memmy 暂时未能接管此页面，请稍后重试。";
}

function allowPage(claim, url) {
  const origin = pageOrigin(url);
  claim.allowedOrigins.add(origin);
  return origin;
}

async function command(tabId, method, params = {}, sessionId) {
  return chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params);
}

function wakeCdpWaiters(claim) {
  for (const wake of claim.cdpWaiters || []) wake();
}

function matchOpenedTabs() {
  const now = Date.now();
  for (let index = pageOpens.length - 1; index >= 0; index--) {
    const open = pageOpens[index];
    if (now - open.at > OPEN_MATCH_WINDOW_MS) { pageOpens.splice(index, 1); continue; }
    const candidates = [...createdTabs].filter(([, created]) => Math.abs(created.at - open.at) <= OPEN_MATCH_WINDOW_MS);
    const match = candidates.find(([, created]) => created.url === open.url) ?? candidates.find(([, created]) => !created.url);
    if (!match) continue;
    const [tabId] = match;
    pageOpens.splice(index, 1); createdTabs.delete(tabId);
    sourceTabs.set(tabId, open.sourceTabId);
    if (claims.has(tabId)) void chrome.tabs.get(tabId).then(tab => publishClaim(tabId, tab)).catch(() => undefined);
  }
  for (const [tabId, created] of createdTabs) if (now - created.at > OPEN_MATCH_WINDOW_MS) createdTabs.delete(tabId);
}

function clearIdleDetach(tabId) {
  clearTimeout(idleDetachTimers.get(tabId));
  idleDetachTimers.delete(tabId);
}

function markDebuggerDetached(claim) {
  claim.attached = false;
  claim.cdpSessions?.clear();
  claim.cdpEpoch = (claim.cdpEpoch || 0) + 1;
  wakeCdpWaiters(claim);
}

async function unclaim(tabId, tellMemmy = true) {
  clearIdleDetach(tabId);
  if (!claims.has(tabId)) return;
  wakeCdpWaiters(claims.get(tabId));
  claims.delete(tabId);
  if (tellMemmy) send({ type: "unclaim", tabId });
  try { await chrome.debugger.detach({ tabId }); } catch { /* Already detached. */ }
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
}

async function pauseByUser(tabId) {
  pausedTabs.set(tabId, Date.now());
  await unclaim(tabId);
  publishTabStatus(await chrome.tabs.get(tabId), "user_detached", USER_CANCELLED_REASON);
}

function newClaim(tabId, origin) {
  return { origin, allowedOrigins: new Set([origin]), attached: false,
    console: [], requests: [], cdpOrigin: origin, cdpEvents: [], cdpSequence: 1, cdpEpoch: 0,
    cdpSessions: new Map(), cdpWaiters: new Set(), protectedActivity: 0,
    cdpReadDepth: 0, cdpWriteDepth: 0, credentialProtected: protectedCredentialTabs.has(tabId),
    credentialRecoveryOrigin: protectedCredentialOrigins.get(tabId) || origin,
    recoveryNavigationPending: false, documentEpoch: 0 };
}

async function discoverTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await loadCredentialProtection();
  if (tab.incognito === true) {
    await unclaim(tabId);
    publishTabStatus(tab, "unsupported", "私密浏览窗口不会接入。"); return;
  }
  let origin;
  try { origin = pageOrigin(tab.url || ""); }
  catch {
    await unclaim(tabId);
    publishTabStatus(tab, "unsupported", "浏览器内部页面不支持插件操作，请切换到普通网页。"); return;
  }
  if (pausedTabs.has(tabId)) {
    await unclaim(tabId);
    publishTabStatus(tab, "user_detached", USER_CANCELLED_REASON); return;
  }
  if (claims.has(tabId)) claims.get(tabId).allowedOrigins.add(origin);
  else claims.set(tabId, newClaim(tabId, origin));
  await publishClaim(tabId, tab);
}

async function discoverOpenTabs(resumeAfterCooldown = false) {
  if (typeof chrome.tabs?.query !== "function") return;
  await discoverScanTask?.catch(() => undefined);
  const work = (async () => {
    const tabs = await chrome.tabs.query({});
    const liveIds = new Set(tabs.map(tab => tab.id));
    for (const tabId of tabStatuses.keys()) if (!liveIds.has(tabId)) {
      tabStatuses.delete(tabId); send({ type: "tab_removed", tabId });
    }
    for (const tabId of claims.keys()) if (!liveIds.has(tabId)) void unclaim(tabId);
    for (const [tabId, pausedAt] of pausedTabs) {
      if (!liveIds.has(tabId) || (resumeAfterCooldown && Date.now() - pausedAt >= USER_CANCEL_COOLDOWN_MS)) {
        pausedTabs.delete(tabId);
      }
    }
    for (const tab of tabs) {
      if (Number.isSafeInteger(tab.id)) await discoverTab(tab.id).catch(() => undefined);
    }
  })();
  discoverScanTask = work;
  try { await work; } finally { if (discoverScanTask === work) discoverScanTask = null; }
}

function queueDebuggerTask(tabId, task) {
  const next = (debuggerTasks.get(tabId) || Promise.resolve()).then(task);
  const settled = next.catch(() => undefined);
  debuggerTasks.set(tabId, settled);
  void settled.then(() => { if (debuggerTasks.get(tabId) === settled) debuggerTasks.delete(tabId); });
  return next;
}

async function ensureAttached(tabId) {
  const current = claims.get(tabId);
  if (pausedTabs.has(tabId)) throw new Error(USER_CANCELLED_REASON);
  if (!current) throw new Error("Tab is not connected");
  if (current.attached && !debuggerTasks.has(tabId)) return;
  return queueDebuggerTask(tabId, async () => {
    if (current.attached) return;
    try { await chrome.debugger.attach({ tabId }, "1.3"); }
    catch (error) {
      // Chrome reports a session this extension already holds as "Another debugger is already attached".
      if (!/already attached/i.test(String(error?.message || error))) throw new Error(attachFailureReason(error));
    }
    try {
      await Promise.all([
        command(tabId, "Page.enable"),
        command(tabId, "Runtime.enable"),
        command(tabId, "Network.enable"),
      ]);
      try {
        await command(tabId, 'Target.setAutoAttach', { autoAttach: true, flatten: true,
          waitForDebuggerOnStart: false, filter: [{ type: 'iframe', exclude: false }] });
      } catch { /* Unsupported child targets remain unavailable. */ }
      if (claims.get(tabId) !== current || pausedTabs.has(tabId)) throw new Error("Page detached during attachment");
    } catch (error) {
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      throw pausedTabs.has(tabId) ? new Error(USER_CANCELLED_REASON) : error;
    }
    current.attached = true;
  });
}

function scheduleIdleDetach(tabId) {
  clearIdleDetach(tabId);
  idleDetachTimers.set(tabId, setTimeout(() => {
    idleDetachTimers.delete(tabId);
    void queueDebuggerTask(tabId, async () => {
      const current = claims.get(tabId);
      if (!current?.attached || tabCommandCounts.get(tabId)) return;
      markDebuggerDetached(current);
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
    });
  }, DEBUGGER_IDLE_DETACH_MS));
}

// A session left by a previous worker instance would keep the debugging bar open.
async function releaseLingeringDebuggers() {
  if (typeof chrome.debugger.getTargets !== "function") return;
  let targets = [];
  try { targets = await chrome.debugger.getTargets(); } catch { return; }
  for (const target of targets) {
    if (!target.attached || !Number.isSafeInteger(target.tabId)) continue;
    void queueDebuggerTask(target.tabId, async () => {
      if (!claims.get(target.tabId)?.attached) await chrome.debugger.detach({ tabId: target.tabId }).catch(() => undefined);
    });
  }
}

async function ensureReconnectAlarm() {
  if (typeof chrome.alarms?.create !== "function") return;
  try {
    const alarm = typeof chrome.alarms.get === "function" ? await chrome.alarms.get(RECONNECT_ALARM) : null;
    if (!alarm) await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_ALARM_MINUTES });
  } catch { /* A later worker wakeup will check the alarm again. */ }
}

function hasPendingBrowserActivity() {
  return runningCommands.size > 0 || [...claims.values()].some(claim =>
    claim.cdpReadDepth > 0 || claim.cdpWriteDepth > 0 || claim.protectedActivity > 0);
}

async function reloadIfUpdated() {
  if (typeof chrome.runtime?.reload !== "function" || typeof fetch !== "function" || !chrome.storage?.local) return;
  if (reloadCheckTask) return reloadCheckTask;
  reloadCheckTask = (async () => {
    try {
      const { version } = await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json();
      if (typeof version !== "string" || version === EXTENSION_VERSION || hasPendingBrowserActivity()) return;
      const { reloadedForVersion } = await chrome.storage.local.get("reloadedForVersion");
      if (reloadedForVersion === version || hasPendingBrowserActivity()) return;
      // One attempt per version prevents a failed reload from looping.
      await chrome.storage.local.set({ reloadedForVersion: version });
      if (hasPendingBrowserActivity()) {
        // Dispatched browser work may outlive its command timeout, or start
        // while the storage write is pending.
        await chrome.storage.local.set({ reloadedForVersion: reloadedForVersion ?? null });
        return;
      }
      chrome.runtime.reload();
    } catch { /* Retry the version check on the next alarm. */ }
  })().finally(() => { reloadCheckTask = null; });
  return reloadCheckTask;
}

function boot() {
  if (typeof chrome.tabs?.query !== "function") return;
  void reloadIfUpdated();
  void releaseLingeringDebuggers();
  void ensureReconnectAlarm();
  void connect().catch(() => scheduleReconnect());
}

chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm?.name !== RECONNECT_ALARM) return;
  void reloadIfUpdated();
  void connect().catch(() => scheduleReconnect());
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action === "status") {
    respond({ ok: true, connected: socket?.readyState === WebSocket.OPEN,
      controllableTabCount: [...tabStatuses.values()].filter(tab => tab.status === "ready").length,
      pausedTabCount: pausedTabs.size,
      tabStatuses: [...tabStatuses.values()] });
    return;
  }
  if (message?.action === "refresh" && sender.id === chrome.runtime.id) {
    pausedTabs.clear();
    void connect().then(() => discoverOpenTabs()).then(() => respond({ ok: true }),
      () => respond({ ok: false, error: "无法重新连接，请确认 Memmy 已打开。" }));
    return true;
  }
  if (typeof message?.action === 'string' && message.action.startsWith('auth:')) {
    if (sender.id !== chrome.runtime.id || typeof message.authId !== 'string') {
      respond({ ok: false }); return;
    }
    const pending = authWindows.get(message.authId);
    if (!pending || sender.tab?.windowId !== pending.windowId) {
      respond({ ok: false }); return;
    }
    if (message.action === 'auth:get') {
      respond({ ok: true, request: pending.request }); return;
    }
    if (message.action === 'auth:submit') {
      const values = message.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).some(key => !pending.request.fields.some(field => field.id === key)
          || typeof values[key] !== 'string' || values[key].length > 4096)) {
        respond({ ok: false }); return;
      }
      pending.resolve({ selected_option: message.selected_option, values });
      respond({ ok: true }); return;
    }
    if (message.action === 'auth:cancel') { pending.resolve(null); respond({ ok: true }); return; }
    respond({ ok: false }); return;
  }
  if (sender.id !== chrome.runtime.id || !Number.isSafeInteger(message?.tabId)) {
    respond({ ok: false, error: "Invalid tab" }); return;
  }
  const work = message.action === "unclaim"
    ? pauseByUser(message.tabId)
    : Promise.reject(new Error("Unknown action"));
  work.then(() => respond({ ok: true }), error => respond({ ok: false, error: String(error?.message || error) }));
  return true;
});

chrome.windows?.onRemoved?.addListener(windowId => {
  for (const pending of authWindows.values()) if (pending.windowId === windowId) pending.resolve(null);
});

function parseAuthRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['origin', 'frame', 'frames', 'fields', 'options', 'submit'].includes(key))) throw Error('Invalid auth request');
  const validId = item => typeof item === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(item);
  const validLabel = item => typeof item === 'string' && item.length > 0 && item.length <= 80 && !/[\r\n<>]/.test(item);
  const validSelector = item => typeof item === 'string' && item.length > 0 && item.length <= 300 && !/[\r\n\0]/.test(item);
  if (typeof value.origin !== 'string' || value.origin.length > 320 || pageOrigin(value.origin) !== value.origin
    || !Array.isArray(value.fields) || value.fields.length > 8) throw Error('Invalid auth request');
  if (value.frame !== undefined && !validSelector(value.frame)) throw Error('Invalid auth frame');
  if (value.frames !== undefined && (value.frame !== undefined || !Array.isArray(value.frames)
    || value.frames.length < 1 || value.frames.length > 3 || value.frames.some(item => !validSelector(item))))
    throw Error('Invalid auth frame chain');
  for (const field of value.fields) {
    if (!field || Object.keys(field).some(key => !['id', 'label', 'type', 'autocomplete', 'required', 'selector'].includes(key))
      || !validId(field.id) || field.id === 'selected_option' || !validLabel(field.label)
      || !validSelector(field.selector) || !['text', 'email', 'password', 'tel', 'number'].includes(field.type)
      || typeof field.required !== 'boolean'
      || (field.autocomplete !== undefined && (typeof field.autocomplete !== 'string' || field.autocomplete.length > 80))) throw Error('Invalid auth field');
  }
  if (new Set(value.fields.map(field => field.id)).size !== value.fields.length) throw Error('Duplicate auth field');
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 8) throw Error('Invalid auth options');
    for (const option of value.options) {
      if (!option || Object.keys(option).some(key => !['id', 'label', 'selector', 'field_ids'].includes(key))
        || !validId(option.id) || !validLabel(option.label)
        || (option.selector !== undefined && !validSelector(option.selector))
        || (option.field_ids !== undefined && (!Array.isArray(option.field_ids)
          || option.field_ids.some(id => !value.fields.some(field => field.id === id))))
        || (!option.selector && (!Array.isArray(option.field_ids) || !option.field_ids.length))) throw Error('Invalid auth option');
    }
    if (new Set(value.options.map(option => option.id)).size !== value.options.length) throw Error('Duplicate auth option');
  }
  if (value.submit !== undefined) {
    const submit = value.submit;
    if (!submit || Object.keys(submit).some(key => !['selector', 'action'].includes(key))
      || !validSelector(submit.selector) || !['click', 'press_enter'].includes(submit.action)
      || (submit.action === 'press_enter' && !value.fields.some(field => field.selector === submit.selector))
      || (submit.action === 'click' && value.fields.some(field => field.selector === submit.selector))) throw Error('Invalid auth submit');
  }
  if (!value.fields.length && !value.options) throw Error('No auth controls');
  return value;
}

async function collectAuth(request, commandId) {
  const authId = crypto.randomUUID();
  let resolveAnswer;
  const answer = new Promise(resolve => { resolveAnswer = resolve; });
  const window = await chrome.windows.create({ url: 'about:blank',
    type: 'popup', focused: true, width: 480, height: Math.min(690, 300 + request.fields.length * 76) });
  if (!Number.isSafeInteger(window?.id) || !Number.isSafeInteger(window.tabs?.[0]?.id))
    throw Error('Secure auth form is unavailable');
  const pending = { windowId: window.id, request, resolve: resolveAnswer };
  authWindows.set(authId, pending);
  const timer = setTimeout(() => resolveAnswer({ status: 'expired' }), 5 * 60_000);
  const cancelled = setInterval(() => {
    if (cancelledCommands.has(commandId) || !runningCommands.has(commandId)) resolveAnswer(null);
  }, 250);
  try {
    await chrome.tabs.update(window.tabs[0].id, { url: chrome.runtime.getURL(`auth.html?authId=${authId}`) });
    return await answer;
  }
  finally {
    clearTimeout(timer); clearInterval(cancelled); authWindows.delete(authId);
    await chrome.windows.remove(window.id).catch(() => undefined);
  }
}

async function authFrame(tabId, claim, selectors) {
  let documentExpression = 'document';
  let sessionId;
  let url = (await chrome.tabs.get(tabId)).url;
  let timeOrigin;
  const keys = [], children = [];
  for (const selector of selectors) {
    const expression = `(() => { const doc=${documentExpression};
      const found=doc?.querySelectorAll(${JSON.stringify(selector)});
      return found?.length===1 && found[0].tagName==='IFRAME' ? found[0] : null; })()`;
    const object = await command(tabId, 'Runtime.evaluate', { expression }, sessionId);
    if (!object.result?.objectId) throw Error('Auth frame is unavailable');
    const described = await command(tabId, 'DOM.describeNode',
      { objectId: object.result.objectId }, sessionId);
    const frameId = String(described.node?.frameId || '');
    if (described.node?.nodeName?.toLowerCase() !== 'iframe' || !frameId)
      throw Error('Auth target is not a frame');
    const child = [...claim.cdpSessions.entries()].find(([, info]) =>
      info.targetId === frameId && info.parentSessionId === sessionId);
    if (child) {
      const [childSessionId, info] = child;
      const live = await command(tabId, 'Target.getTargetInfo',
        { targetId: info.targetId }, sessionId);
      url = String(live.targetInfo?.url || '');
      if (live.targetInfo?.targetId !== info.targetId || pageOrigin(url) !== pageOrigin(info.url))
        throw Error('Auth frame site changed');
      children.push({ sessionId: childSessionId, info, revision: info.revision, url });
      sessionId = childSessionId;
      documentExpression = 'document';
    } else {
      documentExpression = `${documentExpression}.querySelector(${JSON.stringify(selector)}).contentDocument`;
    }
    const fingerprint = await command(tabId, 'Runtime.evaluate', {
      expression: `(() => { const doc=${documentExpression}; return doc ?
        {url:doc.URL,timeOrigin:doc.defaultView.performance.timeOrigin} : null; })()`,
      returnByValue: true,
    }, sessionId);
    const value = fingerprint.result?.value;
    if (!value || typeof value.url !== 'string' || !Number.isFinite(value.timeOrigin)
      || (child && value.url !== url)) throw Error('Auth frame changed');
    url = value.url; timeOrigin = value.timeOrigin;
    keys.push(`${frameId}:${sessionId || 'top'}:${url}:${timeOrigin}:${child?.[1].revision || ''}`);
  }
  return { key: keys.join('|') || 'top', documentExpression, url, timeOrigin, sessionId, children };
}

async function validateAuthControls(tabId, request, frame) {
  const controls = [
    ...request.fields.map(field => ({ key: field.id, selector: field.selector, type: field.type,
      autocomplete: field.autocomplete || null, kind: 'field' })),
    ...(request.options || []).filter(option => option.selector).map(option =>
      ({ key: option.id, selector: option.selector, type: null, autocomplete: null, kind: 'option' })),
    ...(request.submit ? [{ key: 'submit', selector: request.submit.selector, type: null,
      autocomplete: null, kind: request.submit.action === 'press_enter' ? 'field' : 'submit' }] : []),
  ];
  const expression = `(() => { const doc=${frame.documentExpression}; const view=doc?.defaultView;
    if(!doc||!view || doc.URL!==${JSON.stringify(frame.url)}
      || ${frame.timeOrigin !== undefined ? `view.performance.timeOrigin!==${JSON.stringify(frame.timeOrigin)}` : 'false'})
      throw Error('stale');
    const controls=${JSON.stringify(controls)};
    return controls.map(c => { try { const matches=doc.querySelectorAll(c.selector);
      if(matches.length!==1) return c.key; const el=matches[0];
      if(!el.isConnected || el.disabled || !el.getClientRects().length
        || view.getComputedStyle(el).visibility==='hidden') return c.key;
      if(c.kind==='field' && (!(el instanceof view.HTMLInputElement) || (c.type && el.type!==c.type)
        || (c.autocomplete && el.autocomplete!==c.autocomplete))) return c.key;
      return null; } catch { return c.key; } }).filter(Boolean); })()`;
  const result = await command(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, frame.sessionId);
  return result.exceptionDetails || !Array.isArray(result.result?.value) ? ['unknown'] : result.result.value;
}

async function requestAuth(tabId, raw, commandId) {
  const request = parseAuthRequest(raw);
  const claim = claims.get(tabId);
  if (!claim || claim.credentialProtected) return { status: 'unavailable' };
  const initial = await chrome.tabs.get(tabId);
  if (pageOrigin(initial.url || '') !== request.origin || !claim.allowedOrigins.has(request.origin))
    return { status: 'origin_changed' };
  const epoch = claim.documentEpoch;
  return withProtectedActivity(tabId, async () => {
    const frames = request.frame ? [request.frame] : request.frames || [];
    let initialFrame;
    try { initialFrame = await authFrame(tabId, claim, frames); }
    catch { return { status: 'locator_invalid' }; }
    const current = async () => {
      if (cancelledCommands.has(commandId) || !runningCommands.has(commandId) || claims.get(tabId) !== claim
        || claim.documentEpoch !== epoch) return false;
      const tab = await chrome.tabs.get(tabId);
      return tab.url === initial.url && pageOrigin(tab.url || '') === request.origin;
    };
    if (!await current()) return { status: 'page_changed' };
    const invalid = await validateAuthControls(tabId, request, initialFrame);
    if (invalid.length) return { status: 'locator_invalid', locator_error: { field_id: invalid[0], reason: 'not_user_visible' } };
    const answer = await collectAuth(request, commandId);
    if (!answer) return { status: 'declined' };
    if (answer.status === 'expired') return answer;
    if (!await current()) return { status: 'page_changed' };
    const selected = request.options?.find(option => option.id === answer.selected_option);
    if (request.options && !selected) return { status: 'cancelled' };
    const fields = selected?.field_ids ? request.fields.filter(field => selected.field_ids.includes(field.id))
      : selected?.selector ? [] : request.fields;
    const values = fields.map(field => {
      const value = answer.values[field.id];
      if (typeof value !== 'string' || value.length > 4096 || (field.required && !value)) throw Error('Invalid secure auth input');
      return { selector: field.selector, value };
    });
    let frame;
    try { frame = await authFrame(tabId, claim, frames); }
    catch { return { status: 'page_changed' }; }
    if (frame.key !== initialFrame.key) return { status: 'page_changed' };
    const revalidated = await validateAuthControls(tabId, request, frame);
    if (revalidated.length) return { status: 'locator_invalid', locator_error: { field_id: revalidated[0], reason: 'not_user_visible' } };
    if (!await current()) return { status: 'page_changed' };
    await protectCredentialTab(tabId, request.origin);
    const expression = `(() => { const doc=${frame.documentExpression}; const view=doc?.defaultView;
      if(!doc||!view || doc.URL!==${JSON.stringify(frame.url)}
        || ${frame.timeOrigin !== undefined ? `view.performance.timeOrigin!==${JSON.stringify(frame.timeOrigin)}` : 'false'})
        throw Error('stale');
      const values=${JSON.stringify(values)};
      const option=${JSON.stringify(selected?.selector || null)};
      const submit=${JSON.stringify(selected?.selector ? null : request.submit || null)};
      const get=s=>{ const found=doc.querySelectorAll(s); if(found.length!==1) throw Error('stale');
        const el=found[0]; if(!el.isConnected||el.disabled||!el.getClientRects().length) throw Error('stale'); return el; };
      if(option){ get(option).click(); return true; }
      for(const field of values){ const el=get(field.selector); if(!(el instanceof view.HTMLInputElement)) throw Error('stale');
        const setter=Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype,'value').set;
        setter.call(el,field.value); el.dispatchEvent(new view.Event('input',{bubbles:true}));
        el.dispatchEvent(new view.Event('change',{bubbles:true})); }
      if(submit){ const el=get(submit.selector); if(submit.action==='click') el.click();
        else { el.focus(); el.dispatchEvent(new view.KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
          if(el.form) el.form.requestSubmit(); } }
      return true; })()`;
    try {
      if (!await current() || frame.children.some(child => claim.cdpSessions.get(child.sessionId) !== child.info
        || child.info.revision !== child.revision || child.info.url !== child.url))
        return { status: 'page_changed' };
      const result = await command(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, frame.sessionId);
      if (result.exceptionDetails || result.result?.value !== true) return { status: 'submission_failed' };
      return { status: 'submitted', ...(selected ? { selected_option: selected.id } : {}) };
    } catch { return { status: 'submission_failed' }; }
  });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!Number.isSafeInteger(source.tabId)) return;
  if (claims.has(source.tabId)) markDebuggerDetached(claims.get(source.tabId));
  if (reason === "canceled_by_user") void pauseByUser(source.tabId).catch(() => undefined);
});
chrome.tabs.onCreated?.addListener?.(tab => {
  if (!Number.isSafeInteger(tab.id)) return;
  createdTabs.set(tab.id, { url: tab.pendingUrl || tab.url || "", at: Date.now() });
  matchOpenedTabs();
});
chrome.tabs.onRemoved.addListener(tabId => {
  invalidateHistoryFocus();
  void refreshHistoryFocus();
  pausedTabs.delete(tabId); tabStatuses.delete(tabId); sourceTabs.delete(tabId); createdTabs.delete(tabId);
  send({ type: "tab_removed", tabId });
  void unclaim(tabId);
  void loadCredentialProtection().then(() => {
    protectedCredentialTabs.delete(tabId);
    protectedCredentialOrigins.delete(tabId);
    return persistCredentialProtection();
  }).catch(() => undefined);
});
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.url || changes.status || changes.title) void refreshHistoryFocus();
  let origin = "";
  try { origin = pageOrigin(tab.url || changes.url || ""); }
  catch {
    if (changes.url || tab.url) void discoverTab(tabId).catch(() => undefined);
    return;
  }
  if (tab.incognito === true) { void discoverTab(tabId).catch(() => undefined); return; }
  if (!claims.has(tabId)) {
    if (changes.url || changes.status === "complete") void discoverTab(tabId).catch(() => undefined);
    return;
  }
  try {
    if (changes.url) {
      const current = claims.get(tabId);
      current.allowedOrigins.add(origin);
      resetCdpOrigin(current, origin);
      current.origin = origin;
    }
    if (!claims.get(tabId).credentialProtected && (changes.url || changes.title)) void publishClaim(tabId, tab);
  } catch { if (!claims.get(tabId)?.credentialProtected) void unclaim(tabId); }
});
chrome.tabs.onActivated?.addListener?.(info => {
  void refreshHistoryFocus();
  if (!claims.has(info.tabId)) { void discoverTab(info.tabId).catch(() => undefined); return; }
  void chrome.tabs.get(info.tabId).then(tab => publishClaim(info.tabId, tab)).catch(() => undefined);
});

chrome.windows?.onFocusChanged?.addListener?.(() => {
  // Clear the prior window before asynchronous tabs/windows calls finish.
  void refreshHistoryFocus();
});

chrome.debugger.onEvent.addListener((source, method, data) => {
  const claim = claims.get(source.tabId);
  if (!claim) return;
  if (method === 'Page.windowOpen' && !source.sessionId && typeof data?.url === 'string') {
    pageOpens.push({ sourceTabId: source.tabId, url: data.url, at: Date.now() });
    matchOpenedTabs();
  }
  if (method === 'Page.frameNavigated' && !source.sessionId
    && data?.frame?.id && !data.frame.parentId) {
    claim.documentEpoch = (claim.documentEpoch || 0) + 1;
    let recovered = false;
    try { recovered = claim.recoveryNavigationPending
      && pageOrigin(String(data.frame.url || '')) === claim.credentialRecoveryOrigin; }
    catch { /* Redirect remains protected. */ }
    claim.recoveryNavigationPending = false;
    if (claim.credentialProtected && recovered) {
      claim.credentialProtected = false;
      protectedCredentialTabs.delete(source.tabId);
      protectedCredentialOrigins.delete(source.tabId);
      claim.cdpEvents = []; claim.console = []; claim.requests = [];
      wakeCdpWaiters(claim);
      void persistCredentialProtection().then(() => chrome.tabs.get(source.tabId))
        .then(tab => publishClaim(source.tabId, tab)).catch(() => {
        claim.credentialProtected = true;
        protectedCredentialTabs.add(source.tabId);
        protectedCredentialOrigins.set(source.tabId, claim.credentialRecoveryOrigin);
      });
    }
  }
  try {
    const tabOrigin = claim.origin;
    if (method === 'Target.attachedToTarget' && typeof data?.sessionId === 'string'
      && data.targetInfo?.type === 'iframe' && typeof data.targetInfo.targetId === 'string') {
      const childUrl = String(data.targetInfo.url || '');
      claim.cdpSessions.set(data.sessionId,
        { targetId: data.targetInfo.targetId, url: childUrl, revision: 0,
          ...(source.sessionId ? { parentSessionId: source.sessionId } : {}) });
    } else if (method === 'Target.detachedFromTarget' && typeof data?.sessionId === 'string') {
      claim.cdpSessions.delete(data.sessionId);
    } else if (method === 'Page.frameNavigated' && source.sessionId && claim.cdpSessions.has(source.sessionId)) {
      claim.cdpSessions.get(source.sessionId).revision++;
    } else if (method === 'Target.targetInfoChanged' && typeof data?.targetInfo?.targetId === 'string') {
      for (const session of claim.cdpSessions.values()) {
        if (session.targetId === data.targetInfo.targetId) {
          const nextUrl = String(data.targetInfo.url || '');
          session.url = nextUrl; session.revision++;
        }
      }
    }
    const child = source.sessionId ? claim.cdpSessions.get(source.sessionId) : undefined;
    const eventTarget = data?.targetInfo?.type === 'iframe' ? data.targetInfo : null;
    const targetIsCurrent = !eventTarget || !!pageOrigin(String(eventTarget.url || ''));
    if (!claim.credentialProtected && !claim.protectedActivity
      && claim.cdpOrigin === tabOrigin && targetIsCurrent
      && (!source.sessionId || (child && !!pageOrigin(child.url)))
      && /^[A-Za-z]+\.[A-Za-z]+$/.test(method)) {
      let params;
      try { const encoded = JSON.stringify(data); if (encoded?.length <= 16000) params = JSON.parse(encoded); }
      catch { /* Omit oversized event parameters. */ }
      claim.cdpEvents.push({ sequence: claim.cdpSequence++, method,
        source: { tabId: source.tabId,
          ...(child ? { sessionId: source.sessionId, targetId: child.targetId } : {}) },
        ...(params ? { params } : {}) });
      if (claim.cdpEvents.length > 500) claim.cdpEvents.shift();
      wakeCdpWaiters(claim);
    }
  } catch { /* Debug events cannot interrupt tab actions. */ }
  if (claim.credentialProtected || claim.protectedActivity) return;
  if (method === "Runtime.consoleAPICalled") {
    claim.console.push({ type: data.type, text: (data.args || []).map(arg =>
      String(arg.value ?? arg.description ?? "")).join(" ").slice(0, 1000) });
    if (claim.console.length > 100) claim.console.shift();
  } else if (method === "Network.requestWillBeSent") {
    claim.requests.push({ method: data.request?.method, url: data.request?.url });
    if (claim.requests.length > 100) claim.requests.shift();
  }
});

function resetCdpOrigin(claim, nextOrigin) {
  if (claim.cdpOrigin !== nextOrigin) {
    claim.cdpEvents = []; claim.cdpSessions.clear(); claim.cdpOrigin = nextOrigin;
    claim.cdpEpoch = (claim.cdpEpoch || 0) + 1; wakeCdpWaiters(claim);
  }
}

function cdpTarget(target) {
  if (target === undefined) return null;
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).length !== 1) throw new Error('Invalid CDP target');
  const [key] = Object.keys(target);
  if (!['sessionId', 'targetId'].includes(key) || typeof target[key] !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(target[key])) throw new Error('Invalid CDP target');
  return target;
}

async function withCdpTimeout(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Browser CDP command timed out')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function resolveCdpTarget(tabId, claim, target) {
  if (!target) return undefined;
  const found = [...claim.cdpSessions.entries()].find(([sessionId, info]) =>
    target.sessionId ? sessionId === target.sessionId : info.targetId === target.targetId);
  if (!found) throw new Error('CDP child target is not attached to this tab');
  const [sessionId, info] = found;
  const live = await command(tabId, 'Target.getTargetInfo', { targetId: info.targetId });
  if (claim.cdpSessions.get(sessionId) !== info || live?.targetInfo?.targetId !== info.targetId
    || live.targetInfo.type !== 'iframe' || !String(live.targetInfo.url || '')) {
    throw new Error('CDP child target site changed');
  }
  const childOrigin = pageOrigin(String(live.targetInfo.url));
  info.url = String(live.targetInfo.url);
  return { sessionId, info, revision: info.revision, origin: childOrigin };
}

function normalizeCdpRead(method, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || JSON.stringify(params).length > 24000) throw new Error('Invalid CDP parameters');
  const keys = Object.keys(params);
  if (method === 'Accessibility.getFullAXTree' || method === 'Page.getLayoutMetrics') {
    if (keys.length) throw new Error('CDP parameters are unavailable');
    return {};
  }
  if (method === 'DOM.getDocument') {
    if (keys.some(key => key !== 'depth') || (params.depth !== undefined
      && (!Number.isInteger(params.depth) || params.depth < 0 || params.depth > 3))) {
      throw new Error('CDP DOM depth is unavailable');
    }
    return { depth: params.depth ?? 1, pierce: false };
  }
  if (method === 'Page.captureScreenshot') {
    if (keys.some(key => key !== 'format') || (params.format !== undefined
      && params.format !== 'png' && params.format !== 'jpeg')) throw new Error('CDP screenshot parameters are unavailable');
    return { format: params.format ?? 'png', captureBeyondViewport: false };
  }
  if (method === 'Runtime.evaluate') {
    if (keys.some(key => key !== 'expression') || typeof params.expression !== 'string'
      || !params.expression || params.expression.length > 20000) throw new Error('CDP expression is unavailable');
    return { expression: params.expression, throwOnSideEffect: true,
      returnByValue: true, awaitPromise: false, userGesture: false };
  }
  throw new Error('CDP method is unavailable');
}

function normalizeCdpWrite(method, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || JSON.stringify(params).length > 24000) throw new Error('Invalid CDP write parameters');
  const domain = method.split('.')[0];
  const allowed = new Set(['Accessibility', 'Audits', 'Console', 'CSS', 'Debugger', 'DOM',
    'DOMDebugger', 'DOMSnapshot', 'Emulation', 'Fetch', 'IO', 'Input', 'Inspector', 'Log',
    'Network', 'Overlay', 'Page', 'Performance', 'Profiler', 'Runtime', 'Tracing', 'WebAudio']);
  const denied = new Set(['DOM.getFileInfo', 'DOM.setFileInputFiles', 'Input.dispatchKeyEvent',
    'Input.setInterceptDrags', 'Network.clearBrowserCookies', 'Network.deleteDeviceBoundSession',
    'Network.enableDeviceBoundSessions', 'Network.getAllCookies', 'Network.getResponseBodyForInterception',
    'Network.setCookieControls', 'Network.setExtraHTTPHeaders', 'Network.setRequestInterception',
    'Network.takeResponseBodyForInterceptionAsStream', 'Page.addScriptToEvaluateOnLoad',
    'Page.addScriptToEvaluateOnNewDocument', 'Page.crash', 'Page.disable',
    'Page.getNavigationHistory', 'Page.resetNavigationHistory', 'Page.setAdBlockingEnabled',
    'Page.setBypassCSP', 'Page.setDownloadBehavior', 'Page.setInterceptFileChooserDialog',
    'Page.setRPHRegistrationMode', 'Page.setSPCTransactionMode', 'Tracing.requestMemoryDump',
    'Fetch.disable', 'Input.dispatchDragEvent', 'Network.continueInterceptedRequest',
    'Network.getCertificate', 'Network.loadNetworkResource', 'Network.replayXHR',
    'Page.navigate', 'Page.navigateToHistoryEntry']);
  if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(method) || !allowed.has(domain) || denied.has(method)) {
    throw new Error('CDP write method is unavailable');
  }
  if ((method === 'Fetch.continueResponse' || method === 'Fetch.fulfillRequest')
    && params.binaryResponseHeaders != null
    || method === 'Network.configureDurableMessages' && params.maxTotalBufferSize != null
    || method === 'Network.enable' && params.enableDurableMessages === true
    || method === 'Page.createIsolatedWorld' && params.grantUniveralAccess === true
    || method === 'Page.reload' && params.scriptToEvaluateOnLoad != null) {
    throw new Error('CDP write parameters are unavailable');
  }
  if (method === 'Tracing.start') {
    const options = typeof params.options === 'string' ? params.options.split(',').map(value => value.trim()) : [];
    const trace = params.traceConfig && typeof params.traceConfig === 'object' ? params.traceConfig : {};
    if (params.perfettoConfig != null || params.tracingBackend === 'system'
      || options.includes('enable-systrace') || trace.enableSystrace === true
      || trace.memoryDumpConfig != null) throw new Error('CDP tracing parameters are unavailable');
  }
  if (method === 'Fetch.enable' && (!Array.isArray(params.patterns) || params.patterns.length > 50
    || params.patterns.some(pattern => !pattern || typeof pattern !== 'object'
      || Array.isArray(pattern) || typeof pattern.resourceType !== 'string'
      || pattern.resourceType === 'Document'))) throw new Error('CDP Fetch patterns are unavailable');
  return params;
}

function cdpTargetUrls(method, params) {
  const field = (value, name, required = false) => {
    const url = value[name];
    if (url === undefined && !required) return [];
    if (typeof url !== 'string' || !url || url.length > 4096) throw new Error('CDP destination URL is unavailable');
    return [url];
  };
  const cookie = value => {
    if (['domain', 'sourcePort', 'sourceScheme'].some(name => Object.hasOwn(value, name))) {
      throw new Error('CDP cookie command requires an explicit URL');
    }
    const result = field(value, 'url', true);
    if (value.partitionKey !== undefined) {
      if (!value.partitionKey || typeof value.partitionKey !== 'object'
        || Array.isArray(value.partitionKey)) throw new Error('Invalid CDP partition key');
      result.push(...field(value.partitionKey, 'topLevelSite'));
    }
    return result;
  };
  if (method === 'Fetch.continueRequest') return field(params, 'url');
  if (method === 'Fetch.continueResponse' || method === 'Fetch.fulfillRequest') {
    if (params.responseHeaders === undefined) return [];
    if (!Array.isArray(params.responseHeaders) || params.responseHeaders.length > 100) {
      throw new Error('Invalid CDP response headers');
    }
    return params.responseHeaders.flatMap(header => {
      if (!header || typeof header !== 'object' || Array.isArray(header)
        || typeof header.name !== 'string' || typeof header.value !== 'string') {
        throw new Error('Invalid CDP response header');
      }
      return header.name.trim().toLowerCase() === 'location' ? [header.value] : [];
    });
  }
  if (method === 'Network.deleteCookies' || method === 'Network.setCookie') return cookie(params);
  if (method === 'Network.setCookies') {
    if (params.cookies === undefined) return [];
    if (!Array.isArray(params.cookies) || params.cookies.length > 20) throw new Error('Invalid CDP cookies');
    return params.cookies.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CDP cookie');
      return cookie(value);
    });
  }
  if (method === 'Network.getCookies') {
    if (!Array.isArray(params.urls) || !params.urls.length || params.urls.length > 20
      || params.urls.some(url => typeof url !== 'string' || !url || url.length > 4096)) {
      throw new Error('CDP cookie URLs are unavailable');
    }
    return params.urls;
  }
  if (method === 'Page.deleteCookie') return field(params, 'url', true);
  return [];
}

async function cdpRead(tabId, name, args, commandId) {
  const approvedOrigin = pageOrigin(String(args.approvedOrigin || ''));
  const check = async () => {
    if (!claims.has(tabId) || cancelledCommands.has(commandId)) throw new Error('CDP operation cancelled');
    if (claims.get(tabId).credentialProtected || claims.get(tabId).protectedActivity) {
      throw new Error('Raw CDP is unavailable during browser credential protection or autofill');
    }
    const tab = await chrome.tabs.get(tabId);
    const liveOrigin = pageOrigin(tab.url || '');
    resetCdpOrigin(claims.get(tabId), liveOrigin);
    if (liveOrigin !== approvedOrigin || !claims.get(tabId).allowedOrigins.has(liveOrigin)) {
      throw new Error('CDP site changed');
    }
    return claims.get(tabId);
  };
  const claim = await check();
  const approvedEpoch = claim.cdpEpoch;
  const target = cdpTarget(args.target);
  const timeoutMs = args.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000)) {
    throw new Error('Invalid CDP timeout');
  }
  if (name === 'cdpCall' || name === 'cdpWrite') {
    const method = String(args.method || '');
    const params = name === 'cdpWrite'
      ? normalizeCdpWrite(method, args.params || {}) : normalizeCdpRead(method, args.params || {});
    if (name === 'cdpWrite') {
      if (Object.keys(args).some(key => !['method', 'params', 'approvedOrigin', 'target', 'timeoutMs'].includes(key))) {
        throw new Error('CDP write options are unavailable');
      }
      await assertUserIsNotUsingTab(tabId);
      const targets = cdpTargetUrls(method, params);
      if (targets.length > 20 || targets.some(url => !claim.allowedOrigins.has(pageOrigin(url)))) {
        throw new Error('CDP destination site is not approved');
      }
      if (claim.protectedActivity) throw new Error('Raw CDP is unavailable during browser autofill or upload');
      claim.cdpWriteDepth = (claim.cdpWriteDepth || 0) + 1;
    } else claim.cdpReadDepth = (claim.cdpReadDepth || 0) + 1;
    const ongoing = (async () => {
    const child = await resolveCdpTarget(tabId, claim, target);
    const sessionId = child?.sessionId;
    if (await check() !== claim || claim.cdpEpoch !== approvedEpoch) throw new Error('CDP claim changed');
    if (child && (claim.cdpSessions.get(sessionId) !== child.info
      || child.info.revision !== child.revision || pageOrigin(child.info.url) !== child.origin)) {
      throw new Error('CDP child target changed');
    }
    const result = await command(tabId, method, params, sessionId);
    if (child) {
      const live = await command(tabId, 'Target.getTargetInfo', { targetId: child.info.targetId });
      if (claim.cdpSessions.get(sessionId) !== child.info || child.info.revision !== child.revision
        || live?.targetInfo?.targetId !== child.info.targetId
        || pageOrigin(String(live.targetInfo.url || '')) !== child.origin) {
        throw new Error('CDP child target site changed');
      }
    }
    if (await check() !== claim || claim.cdpEpoch !== approvedEpoch
      || (child && (claim.cdpSessions.get(sessionId) !== child.info
        || child.info.revision !== child.revision))) throw new Error('CDP claim changed');
    return result;
    })().finally(() => {
      if (name === 'cdpWrite') claim.cdpWriteDepth--;
      else claim.cdpReadDepth--;
    });
    return withCdpTimeout(ongoing, timeoutMs ?? 3000);
  }
  const { afterSequence, limit = 100, methods } = args;
  if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
    || !Number.isInteger(limit) || limit < 1 || limit > 1000
    || (methods !== undefined && (!Array.isArray(methods) || !methods.length || methods.length > 20
      || methods.some(method => typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method))))) {
    throw new Error('Invalid CDP event query');
  }
  const start = afterSequence ?? claim.cdpSequence - 1;
  const deadline = Date.now() + (timeoutMs ?? 0);
  let first, eligible, events;
  do {
    if (await check() !== claim || claim.cdpEpoch !== approvedEpoch) throw new Error('CDP claim changed');
    first = claim.cdpEvents[0]?.sequence ?? claim.cdpSequence;
    eligible = claim.cdpEvents.filter(event => event.sequence > start
      && (!methods || methods.includes(event.method))
      && (!target || (target.sessionId ? event.source.sessionId === target.sessionId
        : event.source.targetId === target.targetId)));
    events = eligible.slice(0, limit);
    if (events.length || start < first - 1 || Date.now() >= deadline) break;
    await new Promise(resolve => {
      const wake = () => { clearTimeout(timer); claim.cdpWaiters.delete(wake); resolve(); };
      claim.cdpWaiters.add(wake);
      const timer = setTimeout(wake, Math.min(deadline - Date.now(), 250));
    });
  } while (true);
  const latest = claim.cdpSequence - 1;
  if (await check() !== claim || claim.cdpEpoch !== approvedEpoch) throw new Error('CDP claim changed');
  return { cursor: events.at(-1)?.sequence ?? Math.max(start, latest), events,
    hasMore: eligible.length > events.length, truncated: start < first - 1 };
}

async function snapshot(tabId) {
  const { nodes = [] } = await command(tabId, "Accessibility.getFullAXTree");
  return nodes.filter(node => !node.ignored).map(node => {
    const role = String(node.role?.value || "generic");
    const name = String(node.name?.value || "").slice(0, 300);
    const value = node.value?.value == null ? "" : String(node.value.value).slice(0, 300);
    const ref = node.backendDOMNodeId ? `ax-${node.backendDOMNodeId}` : "";
    return { ref, role, name, value };
  }).filter(node => node.ref || node.name || node.value).slice(0, 3000);
}

async function targetObject(tabId, ref) {
  const target = String(ref || "");
  if (target.length > 500) throw new Error("Element target is too long");
  const match = /^ax-(\d+)$/.exec(target);
  let object;
  if (match) {
    ({ object } = await command(tabId, "DOM.resolveNode", { backendNodeId: Number(match[1]) }));
  } else {
    const expression = `(() => { const matches = document.querySelectorAll(${JSON.stringify(target)}); return matches.length === 1 ? matches[0] : null; })()`;
    ({ result: object } = await command(tabId, "Runtime.evaluate", { expression }));
  }
  if (!object?.objectId) throw new Error("Element is no longer available; take a new snapshot");
  return object.objectId;
}

async function click(tabId, args) {
  let x = Number(args.x), y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const objectId = await targetObject(tabId, args.target || args.ref);
    const { result } = await command(tabId, "Runtime.callFunctionOn", { objectId,
      functionDeclaration: "function(){ this.scrollIntoView({block:'center'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; }",
      returnByValue: true });
    x = result?.value?.x; y = result?.value?.y;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Element has no visible click point");
  const button = ["left", "right", "middle"].includes(args.button) ? args.button : "left";
  const modifierBits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const modifiers = Array.isArray(args.modifiers) ? args.modifiers.reduce(
    (bits, name) => bits | (modifierBits[name] || 0), 0) : 0;
  for (let count = 1; count <= (args.doubleClick ? 2 : 1); count++) {
    await command(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, modifiers, clickCount: count });
    await command(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, modifiers, clickCount: count });
  }
  return { x, y };
}

async function navigate(tabId, url) {
  const target = new URL(String(url));
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Only HTTP and HTTPS pages are supported");
  allowPage(claims.get(tabId), target.href);
  if (claims.get(tabId).credentialProtected) claims.get(tabId).recoveryNavigationPending = true;
  try { await command(tabId, "Page.navigate", { url: target.href }); }
  catch (error) { claims.get(tabId).recoveryNavigationPending = false; throw error; }
  return { url: target.href };
}

// The tab opens in the background beside its source page, so the user's current tab stays in front.
async function openTab(url, sourceTabId) {
  const target = new URL(String(url));
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Only HTTP and HTTPS pages are supported");
  const source = Number.isSafeInteger(sourceTabId) && claims.has(sourceTabId)
    ? await chrome.tabs.get(sourceTabId).catch(() => null) : null;
  let tab;
  try {
    tab = await chrome.tabs.create({ url: target.href, active: false,
      ...(source ? { windowId: source.windowId, openerTabId: source.id } : {}),
      ...(Number.isSafeInteger(source?.index) ? { index: source.index + 1 } : {}) });
  } catch (error) {
    if (source) throw error;
    tab = (await chrome.windows.create({ url: target.href, focused: false })).tabs?.[0];
  }
  if (!Number.isSafeInteger(tab?.id)) throw new Error("The browser did not open the tab");
  createdTabs.delete(tab.id);
  if (source) sourceTabs.set(tab.id, source.id);
  const deadline = Date.now() + OPEN_TAB_READY_MS;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id);
    if (/^https?:/.test(current.url || "")) { await discoverTab(tab.id); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { tabId: tab.id };
}

async function history(tabId, direction) {
  const state = await command(tabId, "Page.getNavigationHistory");
  const index = state.currentIndex + direction;
  const entry = state.entries?.[index];
  if (!entry) return { url: (await chrome.tabs.get(tabId)).url };
  allowPage(claims.get(tabId), entry.url);
  await command(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
  return { url: entry.url };
}

async function assertUserIsNotUsingTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const window = await chrome.windows.get(tab.windowId);
  if (tab.active && window.focused) {
    throw new Error("USER_ACTIVE_ON_TARGET_TAB");
  }
}

async function fillAutofill(tabId, kind, values) {
  return withProtectedActivity(tabId, async () => {
  const tab = await chrome.tabs.get(tabId);
  if (!values || pageOrigin(tab.url || "") !== values.origin) throw new Error("Autofill site changed");
  const claim = claims.get(tabId);
  const documentEpoch = claim.documentEpoch || 0;
  if (kind === 'fillCredential') await protectCredentialTab(tabId, values.origin);
  const current = await chrome.tabs.get(tabId);
  if (claims.get(tabId) !== claim || (claim.documentEpoch || 0) !== documentEpoch
    || pageOrigin(current.url || '') !== values.origin) throw new Error('Autofill page changed');
  const fields = kind === "fillCredential"
    ? [
      ["input[autocomplete=username], input[type=email], input[name*=user i], input[name*=email i]", values.username],
      ["input[type=password]", values.password],
    ]
    : [
      ["input[autocomplete=name]", values.name],
      ["input[autocomplete=email], input[type=email]", values.email],
      ["input[autocomplete=tel], input[type=tel]", values.phone],
      ["input[autocomplete=street-address]", values.address],
    ];
  const expression = `(() => { const fields = ${JSON.stringify(fields)}; let count=0; for(const [selector,value] of fields){ if(!value)continue; const input=[...document.querySelectorAll(selector)].find(el=>el.getClientRects().length); if(!input)continue; const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set; if(!setter)continue; setter.call(input,String(value)); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); count++; } return count; })()`;
  const response = await command(tabId, "Runtime.evaluate", { expression, returnByValue: true });
  if (response.exceptionDetails) throw new Error("Autofill failed");
  return { fieldsFilled: Number(response.result?.value || 0) };
  });
}

async function withProtectedActivity(tabId, work) {
  const claim = claims.get(tabId);
  if (!claim || claim.cdpReadDepth || claim.cdpWriteDepth || claim.protectedActivity) {
    throw new Error('Browser operation is unavailable during raw CDP');
  }
  claim.protectedActivity = (claim.protectedActivity || 0) + 1;
  try { return await work(); }
  finally { claim.protectedActivity--; }
}

async function upload(tabId, args, commandId) {
  const paths = args.paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 20
    || paths.some(file => typeof file !== "string" || file.length > 4096
      || !(/^(?:\/[^\0]+|[A-Za-z]:\\[^\0]+)$/.test(file)))) {
    throw new Error("Invalid approved upload files");
  }
  const approvedOrigin = pageOrigin(String(args.approvedOrigin || ""));
  const assertCurrent = async () => {
    if (cancelledCommands.has(commandId) || !claims.has(tabId)) throw new Error("Upload cancelled");
    const tab = await chrome.tabs.get(tabId);
    if (pageOrigin(tab.url || "") !== approvedOrigin
      || !claims.get(tabId).allowedOrigins.has(approvedOrigin)) {
      throw new Error("Upload site changed after approval");
    }
  };
  await assertUserIsNotUsingTab(tabId);
  await assertCurrent();
  const objectId = await targetObject(tabId, args.target || args.ref);
  try {
    const checked = await command(tabId, "Runtime.callFunctionOn", { objectId,
      functionDeclaration: "function(){ return this instanceof HTMLInputElement && this.type === 'file'; }",
      returnByValue: true });
    if (checked.exceptionDetails || checked.result?.value !== true) throw new Error("Target is not a file input");
    await assertCurrent();
    await command(tabId, "DOM.setFileInputFiles", { objectId, files: paths });
    return { uploaded: paths.length };
  } finally {
    await command(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

async function screenshot(tabId, args) {
  if (args.fullPage && (args.target || args.ref)) {
    throw new Error("fullPage cannot be used with an element screenshot");
  }
  const format = args.type === "jpeg" ? "jpeg" : "png";
  const options = { format, captureBeyondViewport: args.fullPage === true };
  const ratioResult = await command(tabId, "Runtime.evaluate", {
    expression: "window.devicePixelRatio", returnByValue: true,
  });
  const ratio = Number(ratioResult.result?.value) || 1;
  // CDP renders each CSS pixel at the device ratio before applying clip.scale.
  const scale = args.scale === "device" ? 1 : 1 / ratio;
  if (args.target || args.ref) {
    const objectId = await targetObject(tabId, args.target || args.ref);
    const { result, exceptionDetails } = await command(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){ const r=this.getBoundingClientRect(); return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height}; }",
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error("Cannot capture this element");
    const rect = result?.value;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0) throw new Error("Element is not visible");
    options.captureBeyondViewport = true;
    options.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      scale };
  } else {
    const metrics = await command(tabId, "Page.getLayoutMetrics");
    const size = args.fullPage ? metrics.cssContentSize : metrics.cssVisualViewport;
    const width = size?.width ?? size?.clientWidth;
    const height = size?.height ?? size?.clientHeight;
    if (!(width > 0 && height > 0)) throw new Error("Page size is unavailable");
    options.clip = { x: size.pageX ?? size.x ?? 0, y: size.pageY ?? size.y ?? 0,
      width, height, scale };
  }
  const { data } = await command(tabId, "Page.captureScreenshot", options);
  return { format, data };
}

function keyboardEvent(key, modifiers) {
  const named = {
    Enter: ["Enter", 13, "\r"], Tab: ["Tab", 9, ""], Escape: ["Escape", 27, ""],
    Backspace: ["Backspace", 8, ""], Delete: ["Delete", 46, ""],
    ArrowLeft: ["ArrowLeft", 37, ""], ArrowUp: ["ArrowUp", 38, ""],
    ArrowRight: ["ArrowRight", 39, ""], ArrowDown: ["ArrowDown", 40, ""],
    Home: ["Home", 36, ""], End: ["End", 35, ""], PageUp: ["PageUp", 33, ""],
    PageDown: ["PageDown", 34, ""], Space: ["Space", 32, " "],
  };
  const alias = { Return: "Enter", Esc: "Escape", Del: "Delete", Left: "ArrowLeft",
    Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", " ": "Space" };
  const normalized = alias[key] || key;
  let code, virtualKeyCode, text = "";
  if (named[normalized]) [code, virtualKeyCode, text] = named[normalized];
  else if (/^[a-z]$/i.test(normalized)) {
    code = `Key${normalized.toUpperCase()}`;
    virtualKeyCode = normalized.toUpperCase().charCodeAt(0);
    text = modifiers & 8 ? normalized.toUpperCase() : normalized.toLowerCase();
  } else if (/^[0-9]$/.test(normalized)) {
    code = `Digit${normalized}`;
    virtualKeyCode = normalized.charCodeAt(0);
    text = normalized;
  } else if (/^F([1-9]|1[0-2])$/.test(normalized)) {
    code = normalized;
    virtualKeyCode = 111 + Number(normalized.slice(1));
  } else if (normalized.length === 1) {
    code = normalized;
    virtualKeyCode = normalized.toUpperCase().charCodeAt(0);
    text = normalized;
  } else throw new Error("Unsupported key");
  if (modifiers & (1 | 2 | 4)) text = "";
  return { key: normalized === "Space" ? " " : normalized, code,
    windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
    modifiers, text, unmodifiedText: text };
}

async function run(tabId, name, args, commandId) {
  if (!claims.has(tabId)) throw new Error("Tab is not connected");
  if (claims.get(tabId).credentialProtected) {
    let sameOrigin = false;
    try { sameOrigin = name === 'navigate'
      && pageOrigin(String(args.url || '')) === claims.get(tabId).credentialRecoveryOrigin; }
    catch { /* Invalid navigation target. */ }
    if (!sameOrigin) throw new Error('credential protection permits only explicit navigation to the current site');
  }
  if (claims.get(tabId).protectedActivity && name !== 'navigate') {
    throw new Error('Browser page control is unavailable during a protected browser operation');
  }
  if ((claims.get(tabId).credentialProtected || claims.get(tabId).protectedActivity)
    && ['snapshot', 'find', 'screenshot', 'consoleMessages', 'networkRequests',
      'cdpCall', 'cdpEvents', 'cdpWrite'].includes(name)) {
    throw new Error('Browser page observation is unavailable during credential protection or autofill');
  }
  if (["navigate", "back", "forward", "reload", "click", "type", "selectOption",
    "pressKey", "scroll", "resize", "fillCredential", "fillContact", "cdpWrite"].includes(name)) await assertUserIsNotUsingTab(tabId);
  switch (name) {
    case "allowOrigin": {
      const origin = pageOrigin(String(args.origin));
      claims.get(tabId).allowedOrigins.add(origin);
      return { origin };
    }
    case "tabState": {
      const tab = await chrome.tabs.get(tabId);
      const origin = allowPage(claims.get(tabId), tab.url || "");
      return { title: tab.title || "", url: tab.url, origin };
    }
    case "cdpCall":
    case "cdpEvents":
    case "cdpWrite": return cdpRead(tabId, name, args, commandId);
    case "upload": return withProtectedActivity(tabId, () => upload(tabId, args, commandId));
    case "snapshot": return { nodes: await snapshot(tabId), tab: await chrome.tabs.get(tabId) };
    case "find": {
      const text = String(args.text || "").toLowerCase();
      const regex = args.regex ? String(args.regex).slice(0, 250) : "";
      let pattern = null;
      if (regex) {
        const match = /^\/(.*)\/([imsu]*)$/.exec(regex);
        pattern = match ? new RegExp(match[1], match[2]) : new RegExp(regex);
      }
      return { nodes: (await snapshot(tabId)).filter(node => {
        const line = `${node.role} ${node.name} ${node.value}`;
        return pattern ? pattern.test(line) : line.toLowerCase().includes(text);
      }) };
    }
    case "navigate": return navigate(tabId, args.url);
    case "back": return history(tabId, -1);
    case "forward": return history(tabId, 1);
    case "reload": await command(tabId, "Page.reload"); return { ok: true };
    case "click": return click(tabId, args);
    case "type": {
      await click(tabId, args);
      const text = String(args.text || "");
      if (text.length > 100000) throw new Error("Text is too long");
      const objectId = await targetObject(tabId, args.target || args.ref);
      await command(tabId, "Runtime.callFunctionOn", { objectId,
        functionDeclaration: "function(){ this.focus(); if(typeof this.select==='function'){this.select();return;} if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);const s=window.getSelection();s.removeAllRanges();s.addRange(r);return;} throw Error('Element is not editable'); }" });
      if (args.slowly) {
        for (const character of text) await command(tabId, "Input.insertText", { text: character });
      } else await command(tabId, "Input.insertText", { text });
      if (args.submit) await run(tabId, "pressKey", { key: "Enter" });
      return { ok: true };
    }
    case "selectOption": {
      const objectId = await targetObject(tabId, args.target || args.ref);
      const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value || "")];
      const { result } = await command(tabId, "Runtime.callFunctionOn", { objectId,
        functionDeclaration: "function(values){ if(this.tagName!=='SELECT') throw Error('Not a select'); for(const option of this.options) option.selected=values.includes(option.value); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return this.value; }",
        arguments: [{ value: values }], returnByValue: true, awaitPromise: true });
      return { value: result?.value };
    }
    case "pressKey": {
      const key = String(args.key || "");
      if (!key || key.length > 50) throw new Error("Invalid key");
      const parts = key.split("+");
      const actual = parts.pop();
      const modifierKeys = {
        Alt: { key: "Alt", code: "AltLeft", flag: 1, virtualKeyCode: 18 },
        Control: { key: "Control", code: "ControlLeft", flag: 2, virtualKeyCode: 17 },
        Meta: { key: "Meta", code: "MetaLeft", flag: 4, virtualKeyCode: 91 },
        Shift: { key: "Shift", code: "ShiftLeft", flag: 8, virtualKeyCode: 16 },
      };
      const aliases = { Ctrl: "Control", Command: "Meta",
        ControlOrMeta: /Mac/.test(navigator.platform) ? "Meta" : "Control" };
      const held = parts.map(part => modifierKeys[aliases[part] || part]);
      if (held.some(value => !value)) throw new Error("Unsupported modifier key");
      let modifiers = 0;
      for (const modifier of held) {
        modifiers |= modifier.flag;
        await command(tabId, "Input.dispatchKeyEvent", { type: "keyDown",
          key: modifier.key, code: modifier.code, modifiers,
          windowsVirtualKeyCode: modifier.virtualKeyCode,
          nativeVirtualKeyCode: modifier.virtualKeyCode });
      }
      const event = keyboardEvent(actual, modifiers);
      if ((modifiers & (2 | 4)) && event.code === "KeyA") event.commands = ["SelectAll"];
      await command(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...event });
      await command(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...event, text: "", unmodifiedText: "" });
      for (const modifier of held.reverse()) {
        modifiers &= ~modifier.flag;
        await command(tabId, "Input.dispatchKeyEvent", { type: "keyUp",
          key: modifier.key, code: modifier.code, modifiers,
          windowsVirtualKeyCode: modifier.virtualKeyCode,
          nativeVirtualKeyCode: modifier.virtualKeyCode });
      }
      return { ok: true };
    }
    case "scroll": {
      await command(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel",
        x: Number(args.x) || 300, y: Number(args.y) || 300,
        deltaX: Number(args.deltaX) || 0, deltaY: Number(args.deltaY) || 0 });
      return { ok: true };
    }
    case "waitFor": {
      const timeout = Math.max(0, Math.min(25000, (Number(args.time) || 0) * 1000));
      if (!args.text && !args.textGone) {
        if (timeout) await new Promise(resolve => setTimeout(resolve, timeout));
        return { ok: true };
      }
      const deadline = Date.now() + (timeout || 5000);
      while (true) {
        const nodes = await snapshot(tabId);
        const contents = nodes.map(node => `${node.name} ${node.value}`).join("\n");
        if ((!args.text || contents.includes(String(args.text)))
          && (!args.textGone || !contents.includes(String(args.textGone)))) break;
        if (Date.now() >= deadline) throw new Error("Wait condition was not met");
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return { ok: true };
    }
    case "screenshot": {
      return screenshot(tabId, args);
    }
    case "consoleMessages": return { messages: claims.get(tabId).console };
    case "networkRequests": return { requests: claims.get(tabId).requests };
    case "viewport": {
      const metrics = await command(tabId, "Page.getLayoutMetrics");
      return { width: metrics.cssVisualViewport?.clientWidth || metrics.cssLayoutViewport?.clientWidth,
        height: metrics.cssVisualViewport?.clientHeight || metrics.cssLayoutViewport?.clientHeight };
    }
    case "historyState": {
      const state = await command(tabId, "Page.getNavigationHistory");
      const current = Number(state.currentIndex || 0);
      return { canGoBack: current > 0, canGoForward: current + 1 < (state.entries || []).length };
    }
    case "resize": {
      const width = Number(args.width), height = Number(args.height);
      if (!Number.isInteger(width) || !Number.isInteger(height)
        || width < 320 || height < 240 || width > 4096 || height > 4096) throw new Error("Invalid viewport");
      await command(tabId, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      return { width, height };
    }
    case "open": {
      const tab = await chrome.tabs.get(tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    case "activate": {
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    case "fillCredential": return fillAutofill(tabId, name, args);
    case "fillContact": return fillAutofill(tabId, name, args);
    case "authRequest": return requestAuth(tabId, args, commandId);
    default: throw new Error("Unsupported browser command");
  }
}

async function handleCommand(message) {
  const tabId = message.tabId;
  if (!Number.isSafeInteger(tabId) || typeof message.id !== "string") return;
  runningCommands.add(message.id);
  clearIdleDetach(tabId);
  tabCommandCounts.set(tabId, (tabCommandCounts.get(tabId) || 0) + 1);
  try {
    if (!COMMANDS_WITHOUT_DEBUGGER.has(message.command)) await ensureAttached(tabId);
    const result = await run(tabId, message.command, message.args || {}, message.id);
    send({ type: "response", id: message.id, ok: true, result });
  } catch (error) {
    send({ type: "response", id: message.id, ok: false,
      error: pausedTabs.has(tabId) ? USER_CANCELLED_REASON : String(error?.message || error) });
  } finally {
    runningCommands.delete(message.id);
    cancelledCommands.delete(message.id);
    const remaining = (tabCommandCounts.get(tabId) || 1) - 1;
    if (remaining > 0) tabCommandCounts.set(tabId, remaining);
    else {
      tabCommandCounts.delete(tabId);
      if (claims.get(tabId)?.attached) scheduleIdleDetach(tabId);
    }
  }
}

boot();
