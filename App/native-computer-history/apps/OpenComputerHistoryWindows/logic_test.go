package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPrintableKeysNeverEscapeAsTextOrVirtualCodes(t *testing.T) {
	for vk := uint32(0); vk < 256; vk++ {
		name, code := safeKey(vk)
		if name == "[typing]" && code != 0 {
			t.Fatalf("raw key escaped: %d", vk)
		}
		if name != "" && !strings.HasPrefix(name, "[") && name != "Enter" && name != "Backspace" && name != "Tab" && name != "Escape" {
			t.Fatalf("unexpected key: %s", name)
		}
	}
	for vk := uint32(65); vk <= 90; vk++ {
		key, code := safeKey(vk)
		if key != "[typing]" || code != 0 {
			t.Fatalf("letter revealed: %d", vk)
		}
	}
}

func TestTypingSettlesOnceWithoutPerKeyTreeReads(t *testing.T) {
	s := scheduler{}
	now := time.Unix(1700000000, 0)
	for i := 0; i < 30; i++ {
		s.add(action{Kind: "keyboard.keydown", Window: "10", PID: 20, Key: "[typing]"}, now.Add(time.Duration(i)*20*time.Millisecond))
	}
	s.lastPoll = now.Add(600 * time.Millisecond)
	if _, _, ok := s.next(now.Add(900 * time.Millisecond)); ok {
		t.Fatal("typing did not debounce")
	}
	a, full, ok := s.next(now.Add(2 * time.Second))
	if !ok || !full || a.Kind != "keyboard.keydown" || a.Count != 30 || s.typing != nil {
		t.Fatalf("invalid burst: %+v", a)
	}
	if len(s.pending) != 0 {
		t.Fatal("burst emitted twice")
	}
}

func TestDifferentWindowsCannotMergeTypedBursts(t *testing.T) {
	s := scheduler{}
	now := time.Now()
	s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "1", PID: 1}, now)
	s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "2", PID: 1}, now)
	a, _, _ := s.next(now.Add(2 * time.Second))
	if a.Window != "2" || a.Count != 1 {
		t.Fatalf("cross-window attribution: %+v", a)
	}
}

func TestFullTreesThrottledAndIdleReadsFourSeconds(t *testing.T) {
	s := scheduler{}
	now := time.Unix(1700000000, 0)
	s.add(action{Kind: "mouse.click"}, now)
	_, full, _ := s.next(now)
	if !full {
		t.Fatal("initial tree absent")
	}
	s.add(action{Kind: "mouse.click"}, now.Add(100*time.Millisecond))
	_, full, _ = s.next(now.Add(100 * time.Millisecond))
	if full {
		t.Fatal("full tree read more than once per second")
	}
	_, full, _ = s.next(now.Add(2 * time.Second))
	if full {
		t.Fatal("idle tree read too early")
	}
	_, full, _ = s.next(now.Add(4 * time.Second))
	if !full {
		t.Fatal("idle tree not refreshed")
	}
}

func TestAccessibilityAndScrollStormsRemainBounded(t *testing.T) {
	s := scheduler{}
	now := time.Now()
	for i := 0; i < 5000; i++ {
		s.add(action{Kind: "accessibility.changed", Window: "1", PID: 1}, now)
	}
	if len(s.pending) != 1 {
		t.Fatalf("change queue unbounded: %d", len(s.pending))
	}
	for i := 0; i < 100; i++ {
		s.add(action{Kind: "mouse.scroll", Window: "1", PID: 1, Delta: 120}, now)
	}
	if len(s.pending) != 2 || s.pending[1].Delta != 12000 {
		t.Fatal("scroll events not coalesced")
	}
	for i := 0; i < 50; i++ {
		s.add(action{Kind: "mouse.click", Window: "1", PID: 1}, now)
	}
	if len(s.pending) > 16 || s.dropped == 0 {
		t.Fatal("action queue overflow not bounded")
	}
}

func sampleEnvelope(mode string, complete bool) map[string]any {
	return map[string]any{"id": 1, "ok": true, "skipped": false, "readFailures": 0, "event": map[string]any{
		"kind": "sampling.changed", "timestamp": "2026-10-13T12:00:00Z", "app": map[string]any{"bundleIdentifier": "win32.chrome", "pid": 10, "secureInput": false},
		"window": map[string]any{"browser": true, "windowId": "100", "processId": 10, "browserContext": map[string]any{"url": "https://example.com/", "documentUrl": "https://example.com/", "mode": mode, "complete": complete, "windowId": "100", "processId": 10}},
		"ax":     map[string]any{"text": "ControlType.Text||Example|||"},
	}}
}
func encoded(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestBrowserEventsAreKeptWhateverTheirBrowsingMode(t *testing.T) {
	for _, mode := range []string{"private", "unknown", "", "normal"} {
		for _, complete := range []bool{false, true} {
			if _, err := parseResult(encoded(t, sampleEnvelope(mode, complete)), 1); err != nil {
				t.Fatalf("mode %q complete %v rejected: %v", mode, complete, err)
			}
		}
	}
	value := sampleEnvelope("unknown", false)
	context := value["event"].(map[string]any)["window"].(map[string]any)["browserContext"].(map[string]any)
	context["url"], context["documentUrl"] = "", ""
	if _, err := parseResult(encoded(t, value), 1); err != nil {
		t.Fatalf("event without a page address rejected: %v", err)
	}
}

func TestBrowserAddressMustBeTheCommittedWebURIOfTheForegroundWindow(t *testing.T) {
	for name, change := range map[string]func(map[string]any, map[string]any){
		"missing context": func(window, _ map[string]any) { delete(window, "browserContext") },
		"other window":    func(_, context map[string]any) { context["windowId"] = "200" },
		"other process":   func(_, context map[string]any) { context["processId"] = 11 },
		"non-web address": func(_, context map[string]any) {
			context["url"], context["documentUrl"] = "chrome://settings", "chrome://settings"
		},
		"uncommitted value": func(_, context map[string]any) { context["documentUrl"] = "https://other.example/" },
		"missing address":   func(_, context map[string]any) { delete(context, "url") },
	} {
		value := sampleEnvelope("unknown", true)
		window := value["event"].(map[string]any)["window"].(map[string]any)
		change(window, window["browserContext"].(map[string]any))
		if _, err := parseResult(encoded(t, value), 1); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestWorkerIdentityAndBudgets(t *testing.T) {
	if _, err := parseResult(encoded(t, sampleEnvelope("normal", true)), 2); err == nil {
		t.Fatal("wrong request accepted")
	}
	if _, err := parseResult(make([]byte, maxProtocolBytes+1), 1); err == nil {
		t.Fatal("oversize accepted")
	}
	value := sampleEnvelope("normal", true)
	event := value["event"].(map[string]any)
	event["ax"].(map[string]any)["text"] = strings.Repeat("a", maxTextCharacters+1)
	if _, err := parseResult(encoded(t, value), 1); err == nil {
		t.Fatal("text budget exceeded")
	}
	event["ax"].(map[string]any)["text"] = ""
	event["app"].(map[string]any)["secureInput"] = true
	if _, err := parseResult(encoded(t, value), 1); err == nil {
		t.Fatal("secure input accepted")
	}
}

func TestSkippedWorkerNeverLeaksAttachedEvent(t *testing.T) {
	value := sampleEnvelope("normal", true)
	value["skipped"] = true
	r, err := parseResult(encoded(t, value), 1)
	if err != nil || r.Event != nil {
		t.Fatal("skipped event propagated")
	}
}

func TestEmbeddedWorkerHasNoScreenshotOrRawKeyboardConversion(t *testing.T) {
	content := string(workerSource)
	for _, word := range []string{"CopyFromScreen", "BitBlt", "ToUnicode", "GetKeyboardState", "keybd_event", "SendKeys"} {
		if strings.Contains(content, word) {
			t.Fatalf("unexpected screenshot/input API %s", word)
		}
	}
	for _, required := range []string{"120000", "$visited -lt 400", "navigation_changed", "wechat_consent_required", "secure_input", "foreground_changed", "focus_changed", "selection=@", "'typing'", "$SelfTest"} {
		if !strings.Contains(content, required) {
			t.Fatalf("worker contract lost: %s", required)
		}
	}
}
