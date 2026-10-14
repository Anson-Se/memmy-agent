import { describe, expect, it } from "vitest";
import { applyWindowsBrowserPrivacy, normalizeWindowsKeyboardAction } from "../../../../src/tools/computer-history/win/native-event-adapter.js";
import { evaluateObservation, type ObservationSettings } from "../../../../src/tools/computer-history/mac/observation-settings.js";
import { buildBrowserAuthoritySnapshot } from "../../../../src/tools/computer-history/browser-privacy.js";
import { filterHistoryAuthorityObservations } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

const policy: ObservationSettings = { memory: { syncEnabled: true }, observation: {
  defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [
    { scope: "url", urlDomain: "company.test", behavior: "do_not_observe" },
  ],
} };
function browser(url = "https://company.test/finance") {
  return { kind: "sampling.changed", app: { name: "chrome", bundleIdentifier: "win32.chrome", pid: 41 },
    window: { browser: true, windowId: "17", url: "https://allowed.test/", browserContext: {
      url, mode: "normal", complete: true, windowId: "17", processId: 41,
    } }, ax: { mode: "fullTree", text: "ControlType.Text||COMPANY_CONTENT|||" } };
}
describe("Windows recording boundary", () => {
  it("uses this native window URL and rejects its explicit website exclusion", () => {
    const event = browser();
    applyWindowsBrowserPrivacy(event, null);
    expect(event.window.url).toBe("https://company.test/finance");
    expect(evaluateObservation(policy, { bundleId: "win32.chrome", browser: true, url: event.window.url }).observe).toBe(false);
  });
  it.each(["missing", "incomplete", "wrong-window", "wrong-process"])("cannot rescue %s native evidence with an old allowed URL", (kind) => {
    const event: any = browser();
    if (kind === "missing") delete event.window.browserContext;
    if (kind === "incomplete") event.window.browserContext.complete = false;
    if (kind === "wrong-window") event.window.browserContext.windowId = "18";
    if (kind === "wrong-process") event.window.browserContext.processId = 42;
    applyWindowsBrowserPrivacy(event, { updatedAt: Date.now(), browsers: { chrome: { connected: true, activeUrl: "https://allowed.test/" } } });
    expect(event.window.privateBrowsingUnknown).toBe(true);
    expect(event.window.url).toBeUndefined();
    expect(evaluateObservation(policy, { bundleId: "win32.chrome", privateBrowsingUnknown: event.window.privateBrowsingUnknown }).observe).toBe(false);
  });
  it("recognizes a browser process even when the helper omitted its browser flag", () => {
    const event: any = browser();
    delete event.window.browser; delete event.window.browserContext;
    applyWindowsBrowserPrivacy(event, null);
    expect(event.window.privateBrowsingUnknown).toBe(true);
    expect(event.window.url).toBeUndefined();
  });
  it("never writes an excluded URL or title to the authority sidecar", () => {
    const now = Date.now();
    const observations = filterHistoryAuthorityObservations(policy, [{
      connectionId: "profile-1", browser: "chrome", focused: true, tabId: 5, windowId: 8,
      title: "PRIVATE_COMPANY_TITLE", url: "https://company.test/finance", mode: "normal", observedAt: now, receivedAt: now,
    }]);
    const snapshot = buildBrowserAuthoritySnapshot(["chrome"], observations, now);
    expect(JSON.stringify(snapshot)).not.toMatch(/company\.test|PRIVATE_COMPANY_TITLE/);
    expect(snapshot.browsers.chrome?.focusedTab?.mode).toBe("unknown");
    const event: any = browser("https://allowed.test/");
    applyWindowsBrowserPrivacy(event, snapshot, now);
    expect(event.window.privateBrowsingUnknown).toBe(true);
  });
});
describe("Windows action metadata", () => {
  function key(category: string, target: Record<string, unknown> = {}) {
    return { kind: "keyboard.keydown", app: { secureInput: false }, keyboard: {
      category, count: 2, text: "RAW_HOOK_SECRET", target: { role: "AXTextField", ...target },
    } };
  }
  it.each(["submit", "shortcut", "delete", "navigation"])("does not copy raw hook or target values for %s", (category) => {
    const action = normalizeWindowsKeyboardAction(key(category, { value: "PRIVATE_DRAFT", secret: "EXTRA_SECRET" }), null, false);
    expect(action).not.toBeNull();
    expect(JSON.stringify(action)).not.toMatch(/RAW_HOOK_SECRET|PRIVATE_DRAFT|EXTRA_SECRET/);
  });
  it("retains an ordinary focused field's current value without copying hook text or arbitrary fields", () => {
    const action = normalizeWindowsKeyboardAction(key("typing", {
      identifier: "qt_chat...textEditWidget", value: "发给同事的钉钉消息", secret: "EXTRA_SECRET",
    }), null, false, true);
    expect(action?.details).toMatchObject({
      text: "发给同事的钉钉消息", textSource: "focused_field_value", redacted: false,
      actionCount: 2, characterCount: 0,
    });
    expect(action?.details).not.toHaveProperty("textPurpose");
    expect(JSON.stringify(action)).not.toMatch(/RAW_HOOK_SECRET|EXTRA_SECRET/);
  });
  it("keeps an unreadable field redacted instead of falling back to hook characters", () => {
    const action = normalizeWindowsKeyboardAction(key("typing", { identifier: "qt_chat...textEditWidget" }), null, false, true);
    expect(action?.details).toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(action?.details).not.toHaveProperty("textSource");
    expect(JSON.stringify(action)).not.toContain("RAW_HOOK_SECRET");
  });
  it("retains search metadata when enabled without making search a condition for ordinary text", () => {
    const context = { purpose: "search_query", role: "AXTextField", label: "Search" };
    const event = key("typing", { value: "录音卡", description: "Search" });
    expect(normalizeWindowsKeyboardAction(event, context, true)?.details).toMatchObject({
      text: "录音卡", textSource: "focused_field_value", textPurpose: "search_query", input: context, redacted: false,
    });
    expect(normalizeWindowsKeyboardAction(event, context, false, true)?.details).toMatchObject({
      text: "录音卡", textSource: "focused_field_value", redacted: false,
    });
    expect(normalizeWindowsKeyboardAction(event, context, false, true)?.details).not.toHaveProperty("textPurpose");
  });
  it("honors disabled ordinary text capture and fields with no readable value", () => {
    const draft = key("typing", { value: "私人草稿" });
    expect(normalizeWindowsKeyboardAction(draft, null, false, false)?.details)
      .toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(normalizeWindowsKeyboardAction(draft, null, true, false)?.details)
      .toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(normalizeWindowsKeyboardAction(key("typing", { value: "" }), null, false, true)?.details)
      .toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(normalizeWindowsKeyboardAction(key("typing", { value: "[REDACTED]" }), null, false, true)?.details)
      .toMatchObject({ text: "[REDACTED]", redacted: true });
  });
  it("redacts credential patterns inside a readable field value", () => {
    const action = normalizeWindowsKeyboardAction(key("typing", {
      value: "账号文档 api_key=sample-secret-value 已打开",
    }), null, false, true);
    expect(action?.details).toMatchObject({
      text: "账号文档 api_key=[REDACTED] 已打开", textSource: "focused_field_value", redacted: false,
    });
    expect(JSON.stringify(action)).not.toContain("sample-secret-value");
  });
  it("excludes password targets, secure input and unbounded categories/counts", () => {
    expect(normalizeWindowsKeyboardAction(key("typing", { subrole: "AXSecureTextField", value: "PASSWORD" }), null, true, true)).toBeNull();
    expect(normalizeWindowsKeyboardAction(key("typing", { IsPassword: true, value: "PASSWORD" }), null, true, true)).toBeNull();
    const event = key("typing"); event.app.secureInput = true;
    expect(normalizeWindowsKeyboardAction(event, null, true)).toBeNull();
    expect(normalizeWindowsKeyboardAction(key("RAW_HOOK_SECRET"), null, true)).toBeNull();
    const excess = key("typing"); excess.keyboard.count = 10001;
    expect(normalizeWindowsKeyboardAction(excess, null, true)).toBeNull();
  });
});
