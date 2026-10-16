import type { BrowserToolName, BrowserScope } from "./browser.js";
import { emitComputerUseSurface } from "../../../tools/computer-use/surface-preview.js";
import { browserAppKey } from "../../../tools/computer-use/native-app-key.js";
import { ExternalBrowserBridge, type ExternalBrowserClaim } from "./external-browser-bridge.js";
import { OcuUserIntervened } from "../../../tools/computer-use/mac-focus-guard.js";

type ExternalResult = Record<string, any>;
type ToolContent = Array<Record<string, any>>;

export const EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED =
  'Screenshots are not supported for Memmy in-app browser tabs. Use browser_snapshot to read the page text and element references. Do not switch to another tab or a desktop screenshot to capture this tab.';

export type BrowserCommandBridge = Pick<ExternalBrowserBridge, 'command' | 'getClaim'>;

export function externalBrowserTargetId(claim: ExternalBrowserClaim): string {
  return `${claim.browser === 'memmy' ? 'embedded' : 'external'}:${claim.connectionId}:${claim.tabId}`;
}

export async function emitExternalBrowserFrame(
  bridge: BrowserCommandBridge, claim: ExternalBrowserClaim, scope: BrowserScope,
  screenshot?: ExternalResult,
): Promise<void> {
  if (claim.browser === 'memmy') return;
  try {
    const frame = screenshot ?? await bridge.command(claim, "screenshot", { type: "jpeg" }) as ExternalResult;
    if (typeof frame.data !== "string" || !["png", "jpeg"].includes(frame.format)) return;
    const history = await bridge.command(claim, "historyState") as ExternalResult;
    const latest = bridge.getClaim(claim) ?? claim;
    emitComputerUseSurface({ surface: "browser", ...scope,
      targetId: externalBrowserTargetId(latest), appKey: browserAppKey(latest.browser as 'chrome' | 'edge'),
      title: latest.title.slice(0, 256),
      url: latest.url.slice(0, 4096),
      canGoBack: history.canGoBack === true, canGoForward: history.canGoForward === true,
      imageDataUrl: `data:image/${frame.format};base64,${frame.data}` });
  } catch { /* Preview errors must not fail the browser action. */ }
}

function formatNodes(nodes: unknown): string {
  if (!Array.isArray(nodes)) return "No accessible elements.";
  return nodes.map((node: any) => {
    const label = [node.name, node.value].filter(Boolean).map((value: string) => JSON.stringify(value)).join(" ");
    return `${node.ref ? `[${node.ref}] ` : ""}${node.role || "generic"}${label ? ` ${label}` : ""}`;
  }).join("\n").slice(0, 150_000);
}

/** Translate the existing browser tool vocabulary to a user-claimed Chrome/Edge tab. */
export async function callExternalBrowserTool(
  bridge: BrowserCommandBridge,
  claim: ExternalBrowserClaim,
  scope: BrowserScope,
  name: BrowserToolName,
  params: Record<string, any>,
  authorizeNavigation: (url: string) => Promise<boolean>,
  abortSignal?: AbortSignal | null,
): Promise<ToolContent> {
  if (claim.browser === 'memmy' && name === 'browser_take_screenshot') {
    throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
  }
  if (name === 'browser_file_upload') {
    const result = await bridge.command(claim, 'upload', params, abortSignal ?? undefined) as ExternalResult;
    await emitExternalBrowserFrame(bridge, claim, scope);
    return [{ type: 'text', text: JSON.stringify(result ?? {}) }];
  }
  const toolCommands: Record<BrowserToolName, string> = {
    browser_navigate: "navigate", browser_snapshot: "snapshot", browser_find: "find",
    browser_click: "click", browser_type: "type", browser_select_option: "selectOption",
    browser_press_key: "pressKey", browser_wait_for: "waitFor",
    browser_console_messages: "consoleMessages", browser_network_requests: "networkRequests",
    browser_take_screenshot: "screenshot", browser_resize: "resize",
    browser_file_upload: "unsupported",
  };
  if (name === "browser_navigate") {
    const target = new URL(String(params.url));
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("External browser accepts HTTP(S) URLs only");
    if (target.origin !== new URL(claim.url).origin) {
      if (!await authorizeNavigation(target.href)) throw new Error(`Access to ${target.origin} was not approved`);
      await bridge.command(claim, "allowOrigin", { origin: target.origin });
    }
  }
  let result: ExternalResult;
  try { result = await bridge.command(claim, toolCommands[name], params) as ExternalResult; }
  catch (error) {
    if ((error as Error).message === "USER_ACTIVE_ON_TARGET_TAB") {
      throw new OcuUserIntervened(claim.browser === "memmy"
        ? "你正在操作 Memmy 内置浏览器里的这个页面，我先暂停了。你操作完后发条消息，我再接着做。"
        : `你正在使用这个 ${claim.browser === "edge" ? "Edge" : "Chrome"} 标签页，我先暂停了。切到其他标签页或窗口后发条消息，我再接着做。`);
    }
    throw error;
  }
  if (name === "browser_take_screenshot") {
    if (typeof result?.data !== "string" || !["png", "jpeg"].includes(result.format)) {
      throw new Error("External browser returned an invalid screenshot");
    }
    await emitExternalBrowserFrame(bridge, claim, scope, result);
    return [
      { type: "text", text: "Screenshot of the claimed external browser tab." },
      { type: "image", mimeType: `image/${result.format}`, data: result.data },
    ];
  }
  if (name === "browser_snapshot" || name === "browser_find") {
    await emitExternalBrowserFrame(bridge, claim, scope);
    return [{ type: "text", text: formatNodes(result?.nodes) }];
  }
  await emitExternalBrowserFrame(bridge, claim, scope);
  return [{ type: "text", text: JSON.stringify(result ?? {}) }];
}
