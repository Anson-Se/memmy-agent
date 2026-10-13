import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// Derived from the public key in the packaged MV3 manifest. The private key is
// not needed to load an unpacked extension and is deliberately not distributed.
export const MEMMY_BROWSER_EXTENSION_ID = "mhodbgbbgalbhehapffidmdegokpoaom";
const EXTENSION_ORIGIN = `chrome-extension://${MEMMY_BROWSER_EXTENSION_ID}`;
// The unpacked extension probes these loopback ports. Keep them aligned with
// BRIDGE_PORTS in App/shell/desktop/extensions/memmy-browser/background.js.
export const EXTERNAL_BROWSER_BRIDGE_PORTS = [47321, 47322, 47323] as const;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export type ExternalBrowserClaim = {
  connectionId: string;
  tabId: number;
  browser: "chrome" | "edge" | "memmy";
  title: string;
  url: string;
  active?: boolean;
  /** Whether this in-app tab has appeared as the selected page in its chat panel. */
  everSelected?: boolean;
  openerTabId?: number;
  claimedAt: number;
};

export type ExternalBrowserTabStatus = {
  connectionId: string;
  tabId: number;
  browser: "chrome" | "edge";
  title: string;
  url: string;
  active?: boolean;
  status: "ready" | "attach_failed" | "unsupported" | "user_detached" | "protected";
  reason: string;
  updatedAt: number;
};

/** History focus evidence is separate from long-lived Computer Use claims. */
export type ExternalBrowserHistoryFocus = {
  connectionId: string;
  browser: "chrome" | "edge";
  focused: boolean;
  tabId: number | null;
  windowId: number | null;
  title: string;
  url: string;
  mode: "normal" | "private" | "unknown";
  observedAt: number;
  receivedAt: number;
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
};

type Client = {
  socket: WebSocket;
  authorized: boolean;
  browser: "chrome" | "edge" | null;
  capabilities: Set<string>;
  claims: Map<number, ExternalBrowserClaim>;
  tabStatuses: Map<number, ExternalBrowserTabStatus>;
  historyFocus: ExternalBrowserHistoryFocus | null;
  historySequence: number;
};

export const EXTERNAL_BROWSER_EXTENSION_OUTDATED = 'The installed Memmy browser extension is too old to open tabs. Ask the user to reload it in the browser\'s extensions page or restart the browser after updating Memmy (setup: memmy://settings/browser-extension), or use a tab that is already open.';

function isSafePageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

function safeText(value: unknown, length: number): string {
  return typeof value === "string" ? value.slice(0, length) : "";
}

/**
 * A loopback-only bridge. After the Memmy extension is installed it connects
 * by itself and exposes ordinary http(s) pages. Web pages cannot connect:
 * the upgrade requires the packaged extension origin.
 */
export class ExternalBrowserBridge {
  private readonly server = http.createServer((_req, response) => {
    response.writeHead(404).end();
  });
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Map<string, Client>();
  private readonly pending = new Map<string, PendingCommand>();
  private nextId = 1;
  private port = 0;

  constructor(private readonly onClaimsChanged?: (claims: ExternalBrowserClaim[]) => void) {
    this.server.on("upgrade", (request, socket, head) => {
      const remote = request.socket.remoteAddress;
      const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!local || request.headers.origin !== EXTENSION_ORIGIN || request.url !== "/extension") {
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, client => this.accept(client));
    });
  }

  async start(requestedPort?: number): Promise<{ port: number }> {
    if (this.port) return { port: this.port };
    const configuredPort = process.env.MEMMY_EXTERNAL_BROWSER_BRIDGE_PORT;
    if (requestedPort === undefined && configuredPort !== undefined) {
      const port = Number(configuredPort);
      if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("MEMMY_EXTERNAL_BROWSER_BRIDGE_PORT must be an integer from 1 to 65535");
      }
      requestedPort = port;
    }
    const candidates = requestedPort === undefined ? [...EXTERNAL_BROWSER_BRIDGE_PORTS] : [requestedPort];
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.listen(candidate);
        return { port: this.port };
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error("browser bridge failed to bind loopback");
  }

  listConnected(): Array<"chrome" | "edge"> {
    return [...new Set([...this.clients.values()].flatMap(client =>
      client.authorized && client.browser ? [client.browser] : []))];
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("browser bridge failed to bind loopback"));
          return;
        }
        this.port = address.port;
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, "127.0.0.1");
    });
  }

  listClaims(): ExternalBrowserClaim[] {
    return [...this.clients.values()].flatMap(client => [...client.claims.values()]);
  }

  listTabStatuses(): ExternalBrowserTabStatus[] {
    return [...this.clients.values()].flatMap(client => [...client.tabStatuses.values()]);
  }

  listHistoryFocusObservations(): ExternalBrowserHistoryFocus[] {
    return [...this.clients.values()].flatMap(client => client.authorized && client.historyFocus
      ? [{ ...client.historyFocus }] : []);
  }

  /** Rescan existing pages without opening tabs; pages the user stopped return only after the extension's cooldown. */
  async refreshTabs(browser?: "chrome" | "edge"): Promise<void> {
    const clients = [...this.clients.entries()].filter(([, client]) => client.authorized
      && (!browser || client.browser === browser) && client.socket.readyState === WebSocket.OPEN);
    await Promise.all(clients.map(([connectionId, client]) => {
      const id = `${connectionId}:${this.nextId++}`;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("Browser extension page refresh timed out"));
        }, 4_000);
        timer.unref?.();
        this.pending.set(id, { resolve, reject, timer, cleanup: () => undefined });
        try { client.socket.send(JSON.stringify({ type: "refresh_tabs", id })); }
        catch (error) {
          clearTimeout(timer); this.pending.delete(id);
          reject(error instanceof Error ? error : new Error("External browser disconnected"));
        }
      });
    }));
  }

  /** Opens a background tab beside the source tab, or in the browser's current window, and resolves once it is offered. */
  async openBrowserTab(browser: "chrome" | "edge", url: string,
    source?: Pick<ExternalBrowserClaim, "connectionId" | "tabId">): Promise<ExternalBrowserClaim> {
    const usable = (client?: Client) => client?.authorized === true && client.browser === browser
      && client.socket.readyState === WebSocket.OPEN;
    const connectionId = source && usable(this.clients.get(source.connectionId)) ? source.connectionId
      : [...this.clients.entries()].find(([, client]) => usable(client))?.[0];
    const client = connectionId ? this.clients.get(connectionId) : undefined;
    if (!connectionId || !client) throw new Error(`${browser} is not connected through the Memmy extension`);
    if (!client.capabilities.has("openTab")) throw new Error(EXTERNAL_BROWSER_EXTENSION_OUTDATED);
    const id = `${connectionId}:${this.nextId++}`;
    const opened = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The browser did not open the tab in time"));
      }, 15_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, cleanup: () => undefined });
      try {
        client.socket.send(JSON.stringify({ type: "open_tab", id, url,
          ...(source?.connectionId === connectionId ? { sourceTabId: source.tabId } : {}) }));
      } catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("External browser disconnected"));
      }
    }) as { tabId?: unknown } | null;
    const tabId = opened?.tabId;
    if (!Number.isSafeInteger(tabId)) throw new Error("The browser did not open the tab");
    const deadline = Date.now() + 5_000;
    let claim = this.getClaim({ connectionId, tabId: tabId as number });
    while (!claim && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      claim = this.getClaim({ connectionId, tabId: tabId as number });
    }
    if (!claim) throw new Error("The new tab opened, but Memmy cannot control it yet. Use browser_list_tabs to check its status.");
    return claim;
  }

  getClaim(identity: Pick<ExternalBrowserClaim, "connectionId" | "tabId">): ExternalBrowserClaim | null {
    return this.clients.get(identity.connectionId)?.claims.get(identity.tabId) ?? null;
  }

  async command(claim: Pick<ExternalBrowserClaim, "connectionId" | "tabId">,
    command: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const client = this.clients.get(claim.connectionId);
    if (!client?.authorized || !client.claims.has(claim.tabId)
      || client.socket.readyState !== WebSocket.OPEN) {
      throw new Error("External browser tab is no longer connected or claimed");
    }
    const id = `${claim.connectionId}:${this.nextId++}`;
    if (signal?.aborted) throw new Error("External browser command cancelled");
    const result = new Promise<unknown>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        try { if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify({ type: "cancel", id })); }
        catch { /* The rejected command is already cancelled locally. */ }
        reject(new Error("External browser command cancelled"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        try { if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify({ type: "cancel", id })); }
        catch { /* The rejected command has already timed out locally. */ }
        reject(new Error("External browser command timed out"));
      }, command === "upload" ? 70_000
        : command === "authRequest" ? 5 * 60_000 + 15_000
        : ['cdpCall', 'cdpWrite', 'cdpEvents'].includes(command) ? 45_000 : COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try { client.socket.send(JSON.stringify({ type: "command", id, tabId: claim.tabId, command, args })); }
    catch (error) {
      const pending = this.pending.get(id);
      if (pending) { this.pending.delete(id); clearTimeout(pending.timer); pending.cleanup();
        pending.reject(error instanceof Error ? error : new Error("External browser disconnected")); }
    }
    return result;
  }

  private accept(socket: WebSocket): void {
    const connectionId = randomBytes(12).toString("hex");
    const client: Client = { socket, authorized: false, browser: null, capabilities: new Set(),
      claims: new Map(), tabStatuses: new Map(), historyFocus: null, historySequence: 0 };
    this.clients.set(connectionId, client);
    const helloTimer = setTimeout(() => socket.close(1008, "extension required"), 5_000);
    helloTimer.unref?.();
    socket.on("message", raw => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(String(raw)); }
      catch { socket.close(1003, "invalid JSON"); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        socket.close(1003, "invalid message"); return;
      }
      if (!client.authorized) {
        if (message.type !== "hello" || (message.browser !== "chrome" && message.browser !== "edge")) {
          socket.close(1008, "extension required"); return;
        }
        clearTimeout(helloTimer);
        client.authorized = true;
        client.browser = message.browser;
        client.capabilities = new Set(Array.isArray(message.capabilities)
          ? message.capabilities.filter((value): value is string => typeof value === "string").slice(0, 20) : []);
        socket.send(JSON.stringify({ type: "ready", connectionId }));
        this.onClaimsChanged?.(this.listClaims());
        return;
      }
      if (message.type === "history_focus") {
        const now = Date.now();
        if (message.browser !== client.browser || typeof message.focused !== "boolean"
          || !Number.isSafeInteger(message.sequence) || (message.sequence as number) <= client.historySequence
          || typeof message.observedAt !== "number" || !Number.isFinite(message.observedAt)
          || message.observedAt <= 0 || message.observedAt > now + 1_000
          || !["normal", "private", "unknown"].includes(String(message.mode))) return;
        const focused = message.focused === true;
        const normal = focused && message.mode === "normal";
        if (focused && (!Number.isSafeInteger(message.tabId) || (message.tabId as number) < 0
          || !Number.isSafeInteger(message.windowId) || (message.windowId as number) < 0)) return;
        if (normal && !isSafePageUrl(message.url)) return;
        client.historySequence = message.sequence as number;
        client.historyFocus = {
          connectionId, browser: client.browser!, focused,
          tabId: focused ? message.tabId as number : null,
          windowId: focused ? message.windowId as number : null,
          title: "", url: normal ? message.url as string : "",
          mode: focused ? message.mode as ExternalBrowserHistoryFocus["mode"] : "unknown",
          observedAt: message.observedAt, receivedAt: now,
        };
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "claim") {
        const tabId = message.tabId;
        if (!Number.isSafeInteger(tabId) || (tabId as number) < 0
          || !isSafePageUrl(message.url)
          || message.browser !== client.browser) return;
        const active = message.active === true;
        if (active) for (const existing of client.claims.values()) existing.active = false;
        client.claims.set(tabId as number, {
          connectionId, tabId: tabId as number,
          browser: message.browser as "chrome" | "edge",
          title: safeText(message.title, 256), url: message.url, active,
          ...(Number.isSafeInteger(message.openerTabId) && (message.openerTabId as number) >= 0
            ? { openerTabId: message.openerTabId as number } : {}),
          claimedAt: client.claims.get(tabId as number)?.claimedAt ?? Date.now(),
        });
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "tab_status") {
        const tabId = message.tabId;
        const status = message.status;
        if (!Number.isSafeInteger(tabId) || (tabId as number) < 0 || message.browser !== client.browser
          || !["ready", "attach_failed", "unsupported", "user_detached", "protected"].includes(String(status))) return;
        if (status === "ready" && !client.claims.has(tabId as number)) return;
        const hidden = status === "protected" || message.protected === true || message.private === true;
        const url = hidden ? "" : safeText(message.url, 4096);
        // Non-HTTP pages are status-only; never turn internal or private pages into claims.
        if (!hidden && status !== "unsupported" && !isSafePageUrl(url)) return;
        if (status === "unsupported" && url && !/^(?:https?:|chrome:|edge:|about:)/.test(url)) return;
        if (message.private === true || status === "unsupported" || status === "user_detached"
          || status === "attach_failed") client.claims.delete(tabId as number);
        client.tabStatuses.set(tabId as number, {
          connectionId, tabId: tabId as number, browser: client.browser!,
          title: hidden ? "受保护页面" : safeText(message.title, 256), url,
          active: !hidden && message.active === true,
          status: status as ExternalBrowserTabStatus["status"],
          reason: safeText(message.reason, 300), updatedAt: Date.now(),
        });
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "tab_removed") {
        if (Number.isSafeInteger(message.tabId)) {
          client.claims.delete(message.tabId as number);
          client.tabStatuses.delete(message.tabId as number);
          this.onClaimsChanged?.(this.listClaims());
        }
      } else if (message.type === "unclaim") {
        if (typeof message.tabId === "number") client.claims.delete(message.tabId);
        if (typeof message.tabId === "number" && client.tabStatuses.get(message.tabId)?.status === "ready") {
          client.tabStatuses.delete(message.tabId);
        }
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (!pending || !message.id.startsWith(`${connectionId}:`)) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.cleanup();
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new Error(safeText(message.error, 500) || "External browser command failed"));
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.clients.delete(connectionId);
      for (const [id, pending] of this.pending) {
        if (!id.startsWith(`${connectionId}:`)) continue;
        clearTimeout(pending.timer);
        pending.cleanup();
        pending.reject(new Error("External browser disconnected"));
        this.pending.delete(id);
      }
      this.onClaimsChanged?.(this.listClaims());
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.socket.close(1001, "Memmy closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new Error("Browser bridge closed"));
    }
    this.pending.clear();
    this.clients.clear();
    this.webSockets.close();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.port = 0;
  }
}

// The Agent's browser tools and authenticated settings endpoint share this
// instance. It remains dormant until the desktop-managed runtime starts it.
export const externalBrowserBridge = new ExternalBrowserBridge();
