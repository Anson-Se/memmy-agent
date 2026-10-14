import { describe, expect, it } from "vitest";
import { compactEventEvidence, MAX_EVIDENCE_CHARS } from "../../../../src/tools/computer-history/mac/summary-writer.js";

function record(marker: string, extra = "") {
  return JSON.stringify({ recordType: "human_event", eventType: "accessibility_snapshot", timestamp: "2026-10-09T10:01:00Z",
    application: { name: marker, bundleId: "com.example.synthetic" }, ax: { mode: "fullTree", text: `AXStaticText||${marker} ${extra}|||` } });
}
describe("retention semantic evidence", () => {
  it("keeps every arc and full visible field while model compaction remains bounded", () => {
    const middle = `HEAD ${"complete visible evidence ".repeat(90)} MIDDLE_ONLY_MARKER ${"readable evidence ".repeat(80)} TAIL`;
    const lines = Array.from({ length: 71 }, (_, index) => record(`ARC_${index}_END`, middle));
    const retained = compactEventEvidence(lines, { purpose: "retention" });
    for (let index = 0; index < 71; index++) expect(retained).toContain(`ARC_${index}_END`);
    expect(retained.includes(middle.replace(/\s+/gu, " "))).toBe(true);
    expect(retained.length).toBeGreaterThan(MAX_EVIDENCE_CHARS);
    expect(compactEventEvidence(lines).length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
  });
  it("keeps complete long labels, queries, keys, selections and messages with redaction", () => {
    const long = `HEAD ${"readable long field ".repeat(60)} MIDDLE_DETAIL_MARKER ${"other field ".repeat(60)} TAIL`;
    const base = { recordType: "human_event", timestamp: "2026-10-09T10:01:00Z", application: { name: "Fixture" } };
    const lines = [
      { ...base, eventType: "mouse_click", details: { accessibility: { title: long } } },
      { ...base, eventType: "text_input", details: { text: long, redacted: false, textPurpose: "search_query" } },
      { ...base, eventType: "key_press", details: { keys: Array.from({ length: 12 }, (_, i) => `KEY_${i}`) } },
      { ...base, eventType: "selection_changed", details: { text: long, redacted: false } },
      { ...base, eventType: "wechat_message", details: { messageId: "synthetic", senderName: "Fixture sender", text: long } },
      { ...base, eventType: "page_context", details: { url: "https://example.com/?api_key=secret_fixture_token" } },
    ].map((event) => JSON.stringify(event));
    const retained = compactEventEvidence(lines, { purpose: "retention" });
    expect(retained.includes(`interacted with: ${long.replace(/\s+/gu, " ")}`)).toBe(true);
    expect(retained.includes(`selected text: ${JSON.stringify(long.replace(/\s+/gu, " ").trim())}`)).toBe(true);
    for (let i = 0; i < 12; i++) expect(retained).toContain(`KEY_${i}`);
    expect(retained).not.toContain("secret_fixture_token");
  });
  it.each(["{broken", "{}", JSON.stringify({ recordType: "human_event", eventType: "future_event", timestamp: "2026-10-09T10:01:00Z" }),
    JSON.stringify({ recordType: "human_event", eventType: "accessibility_snapshot" })])("refuses incomplete or unsupported durable input: %s", (line) => {
    expect(() => compactEventEvidence([record("VALID"), line], { purpose: "retention" })).toThrow(/incomplete or invalid record/u);
  });
});
