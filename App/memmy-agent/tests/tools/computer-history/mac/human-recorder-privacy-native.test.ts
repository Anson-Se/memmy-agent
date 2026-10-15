import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL(
  "../../../../src/tools/computer-history/mac/human-recorder.swift", import.meta.url,
)), "utf8");
const swiftModuleCache = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-privacy-swift-cache-"));
afterAll(() => fs.rmSync(swiftModuleCache, { recursive: true, force: true }));
function production(from: string, until: string): string {
  return source.slice(source.indexOf(from), source.indexOf(until, source.indexOf(from)));
}
function runSwift(body: string): Record<string, any> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-privacy-native-"));
  try {
    const script = path.join(directory, "privacy.swift");
    fs.writeFileSync(script, `import Foundation\nimport Dispatch\nimport CoreFoundation\n${body}`);
    return JSON.parse(execFileSync("swift", ["-module-cache-path",
      swiftModuleCache, script], { encoding: "utf8", timeout: 60_000 }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// All AX objects and calls below are synthetic. These fixtures execute the
// production Swift functions without loading an app, installing a tap, or
// requesting permissions. No live browser/user content is used.
const axFixture = `
typealias CFString = String
typealias CFTypeRef = Any
let kAXTitleAttribute = "title", kAXDescriptionAttribute = "description", kAXRoleAttribute = "role"
let kAXSubroleAttribute = "subrole", kAXIdentifierAttribute = "identifier", kAXChildrenAttribute = "children"
let kAXWindowAttribute = "window", kAXParentAttribute = "parent", kAXValueAttribute = "value"
let kAXFocusedWindowAttribute = "focusedWindow", kAXMainWindowAttribute = "mainWindow"
let kAXSelectedTextAttribute = "selectedText", kAXSelectedTextRangeAttribute = "selectedRange"
enum AXResult { case success, attributeUnsupported, noValue, cannotComplete }
final class AXUIElement {
  var fields: [String: Any]
  var pid: pid_t
  var childrenError: AXResult?
  var childrenDelay: TimeInterval = 0
  init(_ role: String, title: String? = nil, children: [AXUIElement] = [], pid: pid_t = 1) {
    self.pid = pid; fields = ["role": role, "children": children]
    if let title { fields["title"] = title }
  }
}
func CFEqual(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { lhs === rhs }
func axElement(_ value: Any?) -> AXUIElement? { value as? AXUIElement }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Double) {}
var labelReads = 0, selectedReads = 0
var trackedLabelReads = 0
var mutateLabel: (() -> Void)?
var mutateSelection: (() -> Void)?
func accessibilityString(_ element: AXUIElement, _ attribute: String, maxCharacters: Int = 240) -> String? {
  if attribute == kAXTitleAttribute || attribute == kAXDescriptionAttribute {
    labelReads += 1
    if element.fields["tracked"] as? Bool == true {
      trackedLabelReads += 1
      if let mutation = mutateLabel { mutateLabel = nil; mutation() }
    }
  }
  if attribute == kAXSelectedTextAttribute {
    selectedReads += 1
    if let mutateSelection { mutateSelection(); selfClearSelectionMutation() }
  }
  return (element.fields[attribute] as? String).map { String($0.prefix(maxCharacters)) }
}
func selfClearSelectionMutation() { mutateSelection = nil }
func accessibilityValueString(_ element: AXUIElement) -> String? { element.fields["value"] as? String }
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ attribute: String, _ value: inout Any?) -> AXResult {
  if attribute == kAXChildrenAttribute, element.childrenDelay > 0 { Thread.sleep(forTimeInterval: element.childrenDelay) }
  if attribute == kAXChildrenAttribute, let error = element.childrenError { return error }
  value = element.fields[attribute]
  return value == nil ? .attributeUnsupported : .success
}
func copyAXAttribute(_ element: AXUIElement, _ attribute: String, _ value: inout Any?) -> AXResult { AXUIElementCopyAttributeValue(element, attribute, &value) }
func prepareAXQuery(_ element: AXUIElement, timeout: TimeInterval = 0.05) -> Bool { true }
func emitRecorderDiagnostic(code: String, count: Int? = nil, minimumInterval: TimeInterval = 10) {}
let historyWorkSessionKey = "FixtureWorkSession"
var lastTreeKey: String?, lastTreeAt: Date?
func resetAXSamplingCache() { lastTreeKey = nil; lastTreeAt = nil }
func AXUIElementGetPid(_ element: AXUIElement, _ pid: inout pid_t) -> AXResult { pid = element.pid; return .success }
var current = AXUIElement("AXWindow", title: "Public page")
var frontPid: pid_t = 1
var frontBundle = "com.google.Chrome"
var focusedWindowAvailable = true
final class RunningApplication { var processIdentifier: pid_t { frontPid } }
final class NSWorkspace {
  static let shared = NSWorkspace()
  var frontmostApplication: RunningApplication? { RunningApplication() }
}
func applicationPayload() -> [String: Any] { ["pid": frontPid, "bundleId": frontBundle] }
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement {
  let app = AXUIElement("AXApplication", pid: pid)
  if focusedWindowAvailable { app.fields["focusedWindow"] = current }
  app.fields["mainWindow"] = current
  return app
}
let browserBundleIds: Set<String> = ["com.google.Chrome", "com.apple.Safari"]
var pageUrl: String? = "https://public.example/"
func browserPage(window: AXUIElement) -> (url: String?, title: String?) { (pageUrl, nil) }
func quickPageUrl(_ window: AXUIElement) -> String? { nil }
func address() -> AXUIElement { AXUIElement("AXTextField", title: "地址和搜索栏") }
func normalToolbar() -> AXUIElement { AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您")]) }
func value(_ privateState: Bool?) -> Any { privateState as Any? ?? NSNull() }
`;

test.runIf(process.platform === "darwin")("native browser privacy requires normal primary-toolbar evidence and rechecks the same window", () => {
  const result = runSwift(`${axFixture}
${production("// A title marker", "struct FocusSnapshot")}
${production("func currentWindow(", "func refreshFocusedElement(")}
var outcomes: [String: Any] = [:]
func classify(_ name: String, _ window: AXUIElement, bundle: String = "com.google.Chrome", pageDetected: Bool = false) {
  outcomes[name] = value(frontWindowIsPrivate(window: window, bundleId: bundle, pageDetected: pageDetected))
}
let normal = AXUIElement("AXWindow", title: "Public page", children: [normalToolbar()])
classify("normal", normal)
let privateToolbar = AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "无痕模式 (2)")])
classify("privateWithoutTitleMarker", AXUIElement("AXWindow", title: "Ordinary page title", children: [privateToolbar]))
classify("privateTitle", AXUIElement("AXWindow", title: "Page (Incognito)", children: [normalToolbar()]))
classify("missingTitleAndEvidence", AXUIElement("AXWindow"))
classify("missingTitleWithNormalEvidence", AXUIElement("AXWindow", children: [normalToolbar()]))
let webArea = AXUIElement("AXWebArea", children: [AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "无痕模式")])])
let bookmarks = AXUIElement("AXToolbar", title: "书签栏", children: [AXUIElement("AXButton", title: "无痕模式"), AXUIElement("AXButton", title: "您")])
let extensionEntry = AXUIElement("AXCheckBox", title: "打开新的无痕式窗口 - 已固定")
classify("pageBookmarksExtensionDoNotChangeNormal", AXUIElement("AXWindow", title: "Public page", children: [normalToolbar(), webArea, bookmarks, extensionEntry]))
classify("bookmarkProfileCannotAuthorize", AXUIElement("AXWindow", title: "Ordinary page title", children: [bookmarks]))
classify("pageProfileCannotAuthorize", AXUIElement("AXWindow", title: "Ordinary page title", children: [AXUIElement("AXWebArea", children: [normalToolbar()])]))
classify("unscopedProfileCannotAuthorize", AXUIElement("AXWindow", title: "Page", children: [AXUIElement("AXButton", title: "您")]))
classify("customProfileUnknown", AXUIElement("AXWindow", title: "Page", children: [AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "Named profile")])]))
classify("unknownBrowserUnknown", normal, bundle: "com.example.UnknownBrowser", pageDetected: true)
classify("nativeApp", AXUIElement("AXWindow"), bundle: "com.example.Editor")
let safari = AXUIElement("AXWindow", title: "HTTPS page", children: [normalToolbar()])
safari.fields["identifier"] = "SafariWindow?IsSecure=true&UUID=synthetic"
classify("safariIsSecureNotNormalProof", safari, bundle: "com.apple.Safari")
let unavailable = AXUIElement("AXGroup"); unavailable.childrenError = .cannotComplete
classify("unrelatedReadFailureDoesNotBlockNormal", AXUIElement("AXWindow", title: "Page", children: [normalToolbar(), unavailable]))
let wide = AXUIElement("AXWindow", title: "Page", children: [normalToolbar()] + (0..<25).map { _ in AXUIElement("AXGroup") })
classify("unrelatedWideWindowDoesNotBlockNormal", wide)
let wideBookmarks = AXUIElement("AXToolbar", title: "Bookmarks", children: (0..<30).map { _ in AXUIElement("AXButton", title: "Bookmark") })
classify("wideBookmarksDoNotBlockNormal", AXUIElement("AXWindow", title: "Page", children: [normalToolbar(), wideBookmarks]))
let delayedUnrelated = AXUIElement("AXGroup", children: [AXUIElement("AXGroup")]); delayedUnrelated.childrenDelay = 0.18
classify("unrelatedDeadlineDoesNotBlockNormal", AXUIElement("AXWindow", title: "Page", children: [normalToolbar(), delayedUnrelated]))
let failedPrimary = AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您"), unavailable])
classify("primaryReadFailureUnknown", AXUIElement("AXWindow", title: "Page", children: [failedPrimary]))
let missingRole = AXUIElement("AXGroup"); missingRole.fields.removeValue(forKey: "role")
classify("primaryRoleFailureUnknown", AXUIElement("AXWindow", title: "Page", children: [AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您"), missingRole])]))
let widePrimary = AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您")] + (0..<23).map { _ in AXUIElement("AXGroup") })
classify("primaryTruncatedUnknown", AXUIElement("AXWindow", title: "Page", children: [widePrimary]))
func budgetGroups() -> [AXUIElement] {
  (0..<20).map { _ in AXUIElement("AXGroup", children: (0..<6).map { _ in AXUIElement("AXGroup") }) }
}
let budgetPrimary = AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您")] + budgetGroups())
classify("primaryNodeBudgetUnknown", AXUIElement("AXWindow", title: "Page", children: [budgetPrimary]))
classify("unrelatedNodeBudgetDoesNotBlockNormal", AXUIElement("AXWindow", title: "Page", children: [normalToolbar()] + budgetGroups()))
var hiddenPrivate = AXUIElement("AXButton", title: "Incognito")
for _ in 0..<7 { hiddenPrivate = AXUIElement("AXGroup", children: [hiddenPrivate]) }
classify("deepPrimaryUnknown", AXUIElement("AXWindow", title: "Page", children: [AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您"), hiddenPrivate])]))
let delayedPrimary = AXUIElement("AXGroup", children: [AXUIElement("AXButton", title: "Incognito")]); delayedPrimary.childrenDelay = 0.18
classify("primaryDeadlineUnknown", AXUIElement("AXWindow", title: "Page", children: [AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您"), delayedPrimary])]))
let both = AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您"), AXUIElement("AXButton", title: "Incognito")])
classify("privateWinsOverProfile", AXUIElement("AXWindow", title: "Page", children: [both]))
classify("otherAddressToolbarPrivateWins", AXUIElement("AXWindow", title: "Page", children: [normalToolbar(), privateToolbar]))
let nestedBookmarkProfile = AXUIElement("AXToolbar", title: "Bookmarks", children: [AXUIElement("AXButton", title: "您")])
classify("nestedBookmarkCannotBorrowAddress", AXUIElement("AXWindow", title: "Page", children: [AXUIElement("AXToolbar", children: [address(), nestedBookmarkProfile])]))
var containedPrivate = AXUIElement("AXButton", title: "Incognito")
for _ in 0..<4 { containedPrivate = AXUIElement("AXGroup", children: [containedPrivate]) }
classify("privateInPrimaryGroupsWins", AXUIElement("AXWindow", title: "Page", children: [AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您"), containedPrivate])]))
var nestedNormal = normalToolbar()
for _ in 0..<4 { nestedNormal = AXUIElement("AXGroup", children: [nestedNormal]) }
classify("primaryDepthIsRelativeToToolbar", AXUIElement("AXWindow", title: "Page", children: [nestedNormal]))
current = normal
let before = currentWindow(pid: 1, bundleId: "com.google.Chrome").payload
normal.fields["children"] = [privateToolbar]
let after = currentWindow(pid: 1, bundleId: "com.google.Chrome").payload
normal.fields["children"] = []
let unknown = currentWindow(pid: 1, bundleId: "com.google.Chrome").payload
outcomes["sameWindowNormal"] = before
outcomes["sameWindowPrivate"] = after
outcomes["sameWindowUnknown"] = unknown
normal.fields["children"] = [normalToolbar()]; focusedWindowAvailable = false
outcomes["focusedUnavailable"] = currentWindow(pid: 1, bundleId: "com.google.Chrome").payload
print(String(data: try JSONSerialization.data(withJSONObject: outcomes), encoding: .utf8)!)
`);
  assert.equal(result.normal, false);
  assert.equal(result.privateWithoutTitleMarker, true);
  assert.equal(result.privateTitle, true);
  assert.equal(result.missingTitleWithNormalEvidence, false);
  assert.equal(result.pageBookmarksExtensionDoNotChangeNormal, false);
  assert.equal(result.nativeApp, false);
  assert.equal(result.privateWinsOverProfile, true);
  assert.equal(result.otherAddressToolbarPrivateWins, true);
  assert.equal(result.privateInPrimaryGroupsWins, true);
  for (const name of ["unrelatedReadFailureDoesNotBlockNormal", "unrelatedWideWindowDoesNotBlockNormal",
    "wideBookmarksDoNotBlockNormal", "unrelatedDeadlineDoesNotBlockNormal", "unrelatedNodeBudgetDoesNotBlockNormal",
    "primaryDepthIsRelativeToToolbar"]) {
    assert.equal(result[name], false, name);
  }
  for (const name of ["missingTitleAndEvidence", "bookmarkProfileCannotAuthorize", "pageProfileCannotAuthorize",
    "unscopedProfileCannotAuthorize", "customProfileUnknown", "unknownBrowserUnknown", "safariIsSecureNotNormalProof",
    "primaryReadFailureUnknown", "primaryRoleFailureUnknown", "primaryTruncatedUnknown", "deepPrimaryUnknown",
    "primaryDeadlineUnknown", "primaryNodeBudgetUnknown", "nestedBookmarkCannotBorrowAddress"]) assert.equal(result[name], null, name);
  assert.equal(result.sameWindowNormal.privateBrowsing, undefined);
  assert.equal(result.sameWindowNormal.privateBrowsingUnknown, undefined);
  assert.equal(result.sameWindowPrivate.privateBrowsing, true);
  assert.equal(result.sameWindowUnknown.privateBrowsingUnknown, true);
  assert.equal(result.focusedUnavailable.privateBrowsingUnknown, true);
  assert.equal(result.focusedUnavailable.url, undefined);
}, 65_000);

test.runIf(process.platform === "darwin")("queued browser keyboard input cannot inherit permission from another same-app window", () => {
  const result = runSwift(`${axFixture}
${production("// A title marker", "struct FocusSnapshot")}
${production("func currentWindow(", "func refreshFocusedElement(")}
${production("func nodePayload(", "let interactiveFocusRoles:")}
${production("let keyNames:", "func characters(")}
let axStateLock = NSLock()
var observedPid: pid_t? = 1
var focusedElementCache: AXUIElement?
var focusedElementGeneration: UInt64 = 0
var focusedNotificationsAvailable = true
${production("struct FocusSnapshot", "func applicationEnvelope(")}
struct CGPoint { var x: Double; var y: Double }
enum EventType { case leftMouseDown, rightMouseDown, leftMouseUp, keyDown, scrollWheel, tapDisabledByTimeout, tapDisabledByUserInput, other }
enum EventField { case mouseEventClickState, keyboardEventKeycode }
final class CGEvent {
  let location = CGPoint(x: 0, y: 0)
  let text: String
  init(_ text: String) { self.text = text }
  func getIntegerValueField(_ field: EventField) -> Int64 { 0 }
  static func tapEnable(tap: Int, enable: Bool) {}
}
typealias CGEventTapCallBack = (Int, EventType, CGEvent, Any?) -> Unmanaged<CGEvent>?
func AXUIElementCreateSystemWide() -> AXUIElement { AXUIElement("AXApplication") }
func AXUIElementCopyElementAtPosition(_ system: AXUIElement, _ x: Float, _ y: Float, _ element: inout AXUIElement?) -> AXResult { .noValue }
func modifierList(_ event: CGEvent) -> [String] { [] }
func requestScrollSample(application: [String: Any]) {}
func characters(from event: CGEvent) -> String { event.text }
func secureInputActive() -> Bool { false }
func excludesUnconsentedWeChat(_ app: [String: Any]) -> Bool { false }
func isSeparatelyAuthorizedSource(_ app: [String: Any]) -> Bool { false }
let emitLock = NSLock()
var historySessionId: UInt64 = 1
let enrichmentQueue = DispatchQueue(label: "native-keyboard-fixture")
func enqueueEnrichment(key: String? = nil, _ work: @escaping () -> Void) { enrichmentQueue.async(execute: work) }
let enrichmentQueueKey = DispatchSpecificKey<Bool>()
enrichmentQueue.setSpecific(key: enrichmentQueueKey, value: true)
var eventTap: Int?
var dragOrigin: (point: CGPoint, target: [String: Any], pid: pid_t, window: AXUIElement, url: String?)?
var emitted: [[String: Any]] = []
func timestamp() -> String { "2026-10-09T00:00:00Z" }
func nextEventId() -> String { "synthetic-event" }
func applicationEnvelope(_ app: [String: Any]) -> [String: Any] { app }
func emit(_ payload: [String: Any], expectedSession: UInt64? = nil) { emitted.append(payload) }
func axSnapshot(window: AXUIElement, windowKey: String, deduplicate: Bool = false) -> [String: Any]? { nil }
${production("func emitEvent(", "func currentWindow(")}
${production("func resolveTarget(", "func modifierList(")}
${production("let callback:", "// MARK: - Entry point")}
let publicWindow = AXUIElement("AXWindow", title: "Public page", children: [normalToolbar()])
let privateWindow = AXUIElement("AXWindow", title: "Private page (Incognito)")
let publicField = AXUIElement("AXTextField", title: "Search")
publicField.fields["window"] = publicWindow; publicField.fields["tracked"] = true
let privateField = AXUIElement("AXTextField", title: "PRIVATE_SEARCH_FIELD")
privateField.fields["window"] = privateWindow; privateField.fields["tracked"] = true
current = privateWindow; focusedElementCache = privateField
let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
enrichmentQueue.async { entered.signal(); release.wait() }; entered.wait()
_ = callback(0, .keyDown, CGEvent("PRIVATE_TYPED_TEXT"), nil)
current = publicWindow
// The browser PID and focus generation are unchanged: its delayed focus
// notification has not arrived yet. Actual AX-window ownership must reject.
release.signal(); enrichmentQueue.sync {}
var outcomes: [String: Any] = ["stalePrivateInput": emitted, "staleFieldReads": trackedLabelReads]
focusedElementCache = publicField
_ = callback(0, .keyDown, CGEvent("public query"), nil); enrichmentQueue.sync {}
outcomes["normalKeyboard"] = emitted
emitted.removeAll(); focusedElementCache = nil
_ = callback(0, .keyDown, CGEvent("UNKNOWN_BROWSER_TYPED_TEXT"), nil); enrichmentQueue.sync {}
outcomes["unknownBrowserFocus"] = emitted
focusedElementCache = publicField
mutateLabel = { current = privateWindow }
_ = callback(0, .keyDown, CGEvent("SWITCHED_DURING_TARGET_READ"), nil); enrichmentQueue.sync {}
outcomes["switchDuringTargetRead"] = emitted
current = publicWindow; frontBundle = "com.example.Editor"; focusedElementCache = nil
_ = callback(0, .keyDown, CGEvent("ordinary editor input"), nil); enrichmentQueue.sync {}
outcomes["ordinaryEditorUnknownFocus"] = emitted
print(String(data: try JSONSerialization.data(withJSONObject: outcomes), encoding: .utf8)!)
`);
  assert.deepEqual(result.stalePrivateInput, []);
  assert.equal(result.staleFieldReads, 0);
  assert.equal(result.normalKeyboard.length, 1);
  assert.equal(result.normalKeyboard[0].keyboard.text, "public query");
  assert.equal(result.normalKeyboard[0].keyboard.target.title, "Search");
  assert.deepEqual(result.unknownBrowserFocus, []);
  assert.deepEqual(result.switchDuringTargetRead, []);
  assert.equal(result.ordinaryEditorUnknownFocus.length, 1);
  assert.deepEqual(result.ordinaryEditorUnknownFocus[0].keyboard.target, { role: "AXUnknown" });
}, 65_000);

test.runIf(process.platform === "darwin")("native hits and selections verify actual app/window ownership before reading labels or text", () => {
  const result = runSwift(`${axFixture}
${production("// A title marker", "struct FocusSnapshot")}
${production("func currentWindow(", "func refreshFocusedElement(")}
${production("func nodePayload(", "let interactiveFocusRoles:")}
struct CGPoint { var x: Double; var y: Double }
var hit: AXUIElement?
func AXUIElementCreateSystemWide() -> AXUIElement { AXUIElement("AXApplication") }
func AXUIElementCopyElementAtPosition(_ system: AXUIElement, _ x: Float, _ y: Float, _ element: inout AXUIElement?) -> AXResult {
  element = hit; return hit == nil ? .noValue : .success
}
typealias AXValue = AXUIElement
enum AXValueType { case cfRange }
func CFGetTypeID(_ value: Any) -> Int { 0 }
func AXValueGetTypeID() -> Int { 1 }
func AXValueGetValue(_ value: AXValue, _ kind: AXValueType, _ range: inout CFRange) -> Bool { false }
let enrichmentQueue = DispatchQueue(label: "native-selection-fixture")
func enqueueEnrichment(key: String? = nil, _ work: @escaping () -> Void) { enrichmentQueue.async(execute: work) }
var secure = false
func secureInputActive() -> Bool { secure }
func excludesUnconsentedWeChat(_ app: [String: Any]) -> Bool { false }
var emitted: [[String: Any]] = []
func emitEvent(kind: String, application: [String: Any]? = nil, expectedWindow: AXUIElement? = nil, expectedUrl: String? = nil, extra: [String: Any]) {
  var event = extra; event["kind"] = kind; emitted.append(event)
}
${production("func emitSelectionChanged(", "// MARK: - Accessibility tree snapshots")}
frontBundle = "com.example.Editor"
let window = AXUIElement("AXWindow", title: "Public document")
current = window
let field = AXUIElement("AXTextField", title: "Public field")
field.fields["window"] = window; field.fields["selectedText"] = "Permitted selection"
let otherWindow = AXUIElement("AXWindow", title: "PRIVATE_OTHER_WINDOW_TITLE")
let otherField = AXUIElement("AXTextField", title: "PRIVATE_OTHER_WINDOW_FIELD")
otherField.fields["window"] = otherWindow; otherField.fields["selectedText"] = "PRIVATE_OTHER_WINDOW_SELECTION"
let foreign = AXUIElement("AXTextField", title: "PRIVATE_OTHER_APP_FIELD", pid: 2)
foreign.fields["window"] = window; foreign.fields["selectedText"] = "PRIVATE_OTHER_APP_SELECTION"
let dock = AXUIElement("AXDockItem", title: "PRIVATE_MINIMIZED_WINDOW_TITLE")
dock.fields["subrole"] = "AXMinimizedWindowDockItem"; dock.fields["window"] = window
var outcomes: [String: Any] = [:]
for (name, candidate) in [("foreign", foreign), ("backgroundWindow", otherField), ("dock", dock)] {
  hit = candidate; labelReads = 0
  let result = accessibilityHit(at: CGPoint(x: 1, y: 1), expectedPid: 1, expectedWindow: window)
  outcomes[name] = ["accepted": result != nil, "labelReads": labelReads]
}
hit = field
outcomes["normalHit"] = accessibilityHit(at: CGPoint(x: 1, y: 1), expectedPid: 1, expectedWindow: window)?.payload as Any? ?? NSNull()
selectedReads = 0
emitSelectionChanged(foreign); emitSelectionChanged(otherField); enrichmentQueue.sync {}
outcomes["rejectedSelectionsRead"] = selectedReads
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["permittedSelection"] = emitted
emitted.removeAll()
field.fields["selectedText"] = String(repeating: "a", count: 500)
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["longSelectionLength"] = (emitted.last?["selection"] as? [String: Any])?["selectedText"] as? String ?? ""
emitted.removeAll()
let passwordField = AXUIElement("AXSecureTextField", title: "PASSWORD_FIELD_TITLE")
passwordField.fields["window"] = window; passwordField.fields["selectedText"] = "PASSWORD_SELECTION"
selectedReads = 0
emitSelectionChanged(passwordField); enrichmentQueue.sync {}
outcomes["passwordSelectionRead"] = selectedReads
mutateSelection = { current = otherWindow }
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["changedDuringRead"] = emitted
current = window; secure = true
selectedReads = 0
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["secureSelectionRead"] = selectedReads
secure = false; frontBundle = "com.google.Chrome"
selectedReads = 0
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["unknownBrowserSelectionRead"] = selectedReads
print(String(data: try JSONSerialization.data(withJSONObject: outcomes), encoding: .utf8)!)
`);
  for (const name of ["foreign", "backgroundWindow", "dock"]) {
    assert.deepEqual(result[name], { accepted: false, labelReads: 0 }, name);
  }
  assert.equal(result.normalHit.title, "Public field");
  assert.equal(result.rejectedSelectionsRead, 0);
  assert.equal(result.permittedSelection.length, 1);
  assert.equal(result.permittedSelection[0].selection.selectedText, "Permitted selection");
  assert.equal(result.longSelectionLength.length, 500);
  assert.equal(result.passwordSelectionRead, 0);
  assert.deepEqual(result.changedDuringRead, []);
  assert.equal(result.secureSelectionRead, 0);
  assert.equal(result.unknownBrowserSelectionRead, 0);
}, 65_000);

test.runIf(process.platform === "darwin")("native event emission discards snapshots after same-app window, URL, or privacy changes", () => {
  const result = runSwift(`${axFixture}
let emitLock = NSLock()
var historySessionId: UInt64 = 1
let enrichmentQueue = DispatchQueue(label: "native-emission-fixture")
func enqueueEnrichment(key: String? = nil, _ work: @escaping () -> Void) { enrichmentQueue.async(execute: work) }
let enrichmentQueueKey = DispatchSpecificKey<Bool>()
enrichmentQueue.setSpecific(key: enrichmentQueueKey, value: true)
var emitted: [[String: Any]] = []
var snapshotReads = 0
var switchAppDuringSnapshot = false
func timestamp() -> String { "2026-10-09T00:00:00Z" }
func nextEventId() -> String { "synthetic-event" }
func excludesUnconsentedWeChat(_ app: [String: Any]) -> Bool { false }
func applicationEnvelope(_ app: [String: Any]) -> [String: Any] { app }
func emit(_ payload: [String: Any], expectedSession: UInt64? = nil) { emitted.append(payload) }
func axSnapshot(window: AXUIElement, windowKey: String, deduplicate: Bool = false) -> [String: Any]? {
  snapshotReads += 1; lastTreeKey = windowKey; lastTreeAt = Date()
  if switchAppDuringSnapshot { frontPid = 2 }
  return ["mode": "fullTree", "text": "SYNTHETIC_TREE"]
}
typealias Context = (payload: [String: Any], element: AXUIElement?)
var contexts: [Context] = []
func currentWindow(pid: pid_t, bundleId: String) -> Context { contexts.count > 1 ? contexts.removeFirst() : contexts[0] }
${production("func emitEvent(", "func currentWindow(")}
let a = AXUIElement("AXWindow"), b = AXUIElement("AXWindow")
let normal: [String: Any] = ["browser": true, "url": "https://public.example/"]
var outcomes: [String: Any] = [:]
func scenario(_ name: String, first: Context, latest: Context, switchApp: Bool = false) {
  contexts = [first, latest]; emitted.removeAll(); frontPid = 1
  snapshotReads = 0; switchAppDuringSnapshot = switchApp
  lastTreeKey = "previous"; lastTreeAt = Date()
  enrichmentQueue.sync { emitEvent(kind: "mouse.click", extra: [:]) }
  outcomes[name] = ["emitted": emitted.count, "snapshotReads": snapshotReads, "baselineCleared": lastTreeKey == nil && lastTreeAt == nil]
}
scenario("normal", first: (normal, a), latest: (normal, a))
scenario("samePidOtherWindow", first: (normal, a), latest: (normal, b))
scenario("sameWindowPrivate", first: (normal, a), latest: (["browser": true, "url": pageUrl!, "privateBrowsing": true], a))
scenario("sameWindowUnknown", first: (normal, a), latest: (["browser": true, "url": pageUrl!, "privateBrowsingUnknown": true], a))
scenario("navigation", first: (normal, a), latest: (["browser": true, "url": "https://other.example/"], a))
scenario("appSwitchDuringRead", first: (normal, a), latest: (normal, a), switchApp: true)
scenario("initialUnknown", first: (["browser": true, "privateBrowsingUnknown": true], a), latest: (normal, a))
print(String(data: try JSONSerialization.data(withJSONObject: outcomes), encoding: .utf8)!)
`);
  assert.equal(result.normal.emitted, 1);
  assert.equal(result.normal.snapshotReads, 1);
  for (const name of ["samePidOtherWindow", "sameWindowPrivate", "sameWindowUnknown", "navigation", "appSwitchDuringRead", "initialUnknown"]) {
    assert.equal(result[name].emitted, 0, name);
    assert.equal(result[name].baselineCleared, true, name);
  }
  assert.equal(result.initialUnknown.snapshotReads, 0);
}, 65_000);
