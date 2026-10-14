import { resolveBrowserContext, type BrowserAuthoritySnapshot } from "../browser-privacy.js";
import { BROWSER_BUNDLE_IDS } from "../mac/observation-settings.js";
import { redactSensitive } from "../mac/redaction.js";

type NativeEvent = Record<string, any>;

/** Bind the privacy decision to this observation, never to a cached browser URL. */
export function applyWindowsBrowserPrivacy(event: NativeEvent, authority: BrowserAuthoritySnapshot | null,
  now = Date.now()): void {
  const app = event.app ?? event.application ?? {};
  const bundleId = app.bundleIdentifier ?? app.bundleId ?? "";
  if (event.window?.browser !== true && !BROWSER_BUNDLE_IDS.has(String(bundleId).toLowerCase())) return;
  const window = event.window ?? (event.window = {});
  window.browser = true;
  // An explicit native exclusion always wins, including a read which became
  // incomplete after its initial browser-chrome observation.
  if (window.privateBrowsing === true || window.privateBrowsingUnknown === true) {
    delete window.url;
    return;
  }
  const result = resolveBrowserContext({
    browserName: app.name ?? bundleId,
    title: typeof window.title === "string" ? window.title : "",
    axText: typeof event.ax?.text === "string" ? event.ax.text : "",
    nativeContext: window.browserContext,
    windowId: typeof (window.windowId ?? window.id) === "string" ? window.windowId ?? window.id : undefined,
    processId: Number.isSafeInteger(app.pid) ? app.pid : undefined,
    authority,
    now,
  });
  window.privateBrowsing = result.private === true;
  window.privateBrowsingUnknown = result.private === null;
  delete window.url;
  if (result.private === false && result.url) window.url = result.url;
}

const categories = new Set(["typing", "submit", "shortcut", "navigation", "delete"]);
const semanticKeys: Record<string, string> = { submit: "return", shortcut: "shortcut", navigation: "navigation", delete: "backspace" };

function actionTarget(target: NativeEvent | undefined): Record<string, string> | null {
  if (!target || typeof target !== "object") return null;
  const result: Record<string, string> = {};
  for (const key of ["role", "subrole", "name", "description", "identifier"]) {
    if (typeof target[key] === "string") result[key] = redactSensitive(target[key].slice(0, 320));
  }
  return result;
}

/** Windows hooks report actions and counts; they never carry raw character data. */
export function normalizeWindowsKeyboardAction(event: NativeEvent,
  searchContext: { purpose: string; role: string; label: string } | null,
  captureSearchText: boolean, captureOrdinaryText = false): {
    eventType: "text_input" | "key_press";
    details: Record<string, unknown>;
  } | null {
  if (event.kind !== "keyboard.keydown" || event.app?.secureInput === true) return null;
  const keyboard = event.keyboard;
  if (!keyboard || !categories.has(keyboard.category)
    || !Number.isSafeInteger(keyboard.count) || keyboard.count < 1 || keyboard.count > 10000) return null;
  const target = keyboard.target;
  if (target?.role === "AXSecureTextField" || target?.subrole === "AXSecureTextField"
    || target?.isPassword === true || target?.IsPassword === true) return null;
  if (keyboard.category !== "typing") {
    return { eventType: "key_press", details: {
      keys: [semanticKeys[keyboard.category]], actionCount: keyboard.count,
      ...(actionTarget(target) ? { accessibility: actionTarget(target) } : {}),
    } };
  }
  // UIA supplies the focused control's current value, not the characters in
  // this key burst. The native worker has already checked the foreground,
  // focus and password ancestry before attaching this value.
  const retainValue = captureOrdinaryText || (captureSearchText && searchContext !== null);
  const value = retainValue && typeof target?.value === "string" && target.value.length > 0
    ? redactSensitive(target.value.slice(0, 1000)) : null;
  const readableValue = value && value !== "[REDACTED]" ? value : null;
  return { eventType: "text_input", details: {
    actionCount: keyboard.count, characterCount: 0,
    text: readableValue ?? "[REDACTED]", redacted: readableValue === null,
    ...(readableValue !== null ? { textSource: "focused_field_value" } : {}),
    ...(readableValue !== null && captureSearchText && searchContext
      ? { textPurpose: "search_query", input: searchContext } : {}),
    ...(actionTarget(target) ? { accessibility: actionTarget(target) } : {}),
  } };
}
