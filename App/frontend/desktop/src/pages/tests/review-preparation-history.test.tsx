// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Window as TestWindow } from "happy-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PluginUiCall } from "../../app/plugin-ui-context.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginCapabilityHost } from "../plugin-capability-host.js";
import { collectReviewPreparation, isConsolidatedScopeQuestion, reviewReceiptLines, reviewResponseKey } from "../review-preparation-history.js";

function call(type: string, response?: unknown, taskId = "review-1"): PluginUiCall {
  return { pluginId: "literature-review", capabilityId: "review_request_interaction", origin: "agent", conversationId: "chat-1", callId: `${type}-${taskId}`, events: [
    { type: "interaction", request: { type: type === "source-import" ? "file-input" : "custom", interactionId: type, payload: { taskId, cardType: type, data: { papers: [{ id: "paper-1", title: "MemoryBank" }] } } } },
    ...(response === undefined ? [] : [{ type: "result" as const, output: { data: { interactionId: type, response } } }])
  ] };
}
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("review preparation history", () => {
  it("uses acknowledged edits rather than proposals and restores them from terminal events", () => {
    const response = { action: "submit", values: { keywords: [{ term: "Edited keyword", weight: 8, selected: true }, { term: "Off", selected: false }] } };
    const active = call("keywords");
    expect(collectReviewPreparation([active], new Map())).toEqual([]);
    const local = collectReviewPreparation([active], new Map([[reviewResponseKey(active, "keywords"), response]]));
    const restored = collectReviewPreparation([call("keywords", response)], new Map());
    expect(restored).toEqual(local);
    expect(reviewReceiptLines(restored[0]!.receipts[0]!)).toEqual(["Edited keyword · 8"]);
  });

  it("keeps cancellation, chat skipping, task grouping and re-opened preparation distinct", () => {
    const groups = collectReviewPreparation([
      call("keywords", { action: "cancel" }), call("outline", { action: "chat-feedback", values: { outline: [{ title: "Unconfirmed" }] } }),
      call("paper-selection", { action: "submit", values: { includedPaperIds: ["paper-1"] } }),
      call("source-import", { files: [{ name: "local.pdf" }] }, "review-2")
    ], new Map());
    expect(groups).toHaveLength(2); expect(groups[0]!.complete).toBe(true);
    expect(reviewReceiptLines(groups[0]!.receipts[2]!)).toEqual(["MemoryBank"]);
    expect(reviewReceiptLines(groups[1]!.receipts[0]!)).toEqual(["local.pdf"]);
    expect(collectReviewPreparation([call("paper-selection", { action: "submit" }), call("outline")], new Map())[0]!.complete).toBe(false);
    expect(collectReviewPreparation([{ ...call("keywords", { action: "submit" }), pluginId: "other" }], new Map())).toEqual([]);
  });

  it("renders collapsed summaries after the editor is gone, with expandable content and a collapsed completed group", async () => {
    const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
    try {
      const calls = [call("keywords", { action: "submit", values: { keywords: [{ term: "long-term memory", weight: 10 }] } }), call("outline", { action: "cancel" })];
      const render = () => root.render(<I18nProvider language="zh-CN"><PluginCapabilityHost calls={calls} plugins={[]} client={null} /></I18nProvider>);
      await act(async () => render());
      expect(element.querySelector('[data-review-preparation="pending"]')?.hasAttribute("open")).toBe(true);
      const keywords = element.querySelector<HTMLDetailsElement>('[data-review-receipt="keywords"]')!;
      expect(keywords.open).toBe(false); expect(keywords.textContent).toContain("long-term memory · 10");
      expect(element.textContent).toContain("× 已取消"); expect(element.querySelector("iframe")).toBeNull();
      keywords.open = true; expect(keywords.open).toBe(true);
      calls.push(call("paper-selection", { action: "submit", values: { includedPaperIds: ["paper-1"] } }));
      await act(async () => render());
      const complete = element.querySelector<HTMLDetailsElement>('[data-review-preparation="complete"]')!;
      expect(complete.open).toBe(false); expect(complete.textContent).toContain("完成研究准备");
      expect(complete.textContent).toContain("MemoryBank");
      await act(async () => render()); expect(complete.open).toBe(false);
    } finally { await act(async () => root.unmount()); element.remove(); }
  });
  it("consolidates native answers only after the matching scope save, then folds them with paper confirmation", () => {
    const card = { version: 1 as const, requestId: "native-scope", context: { workflow: "literature-review", taskId: "review-1" }, questions: [] };
    const save: PluginUiCall = { ...call("source-import"), callId: "scope-save", capabilityId: "review_update_spec", events: [{ type: "result", output: { ok: true, taskId: "review-1", data: { spec: { topic: "Memory", dateRange: { from: 2022, to: 2026 } }, scopeConfirmation: { questionRequestId: "native-scope" } } } }] };
    expect(isConsolidatedScopeQuestion(card, [])).toBe(false);
    expect(isConsolidatedScopeQuestion({ ...card, requestId: "other" }, [save])).toBe(false);
    expect(isConsolidatedScopeQuestion(card, [save])).toBe(true);
    const before = collectReviewPreparation([save], new Map());
    expect(before[0]!.complete).toBe(false); expect(reviewReceiptLines(before[0]!.receipts[0]!)).toEqual(["Memory", "2022–2026"]);
    const after = collectReviewPreparation([save, call("paper-selection", { action: "submit", values: { includedPaperIds: ["paper-1"] } })], new Map());
    expect(after[0]!.complete).toBe(true); expect(after[0]!.receipts.map((receipt) => receipt.type)).toEqual(["review-spec", "paper-selection"]);
  });

  it("offers native folder upload, validates the file limit, and only replaces the editor after a successful answer", async () => {
    const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
    const source = call("source-import");
    const interaction = source.events[0]!;
    if (interaction.type === "interaction") interaction.request.payload = { taskId: "review-1", cardType: "source-import", title: "添加本地文献", multiple: true, allowDirectory: true, maxFiles: 1, accept: [".pdf"] };
    const respond = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(undefined);
    const client = { getUi: vi.fn(), cancel: vi.fn(), respond };
    const uploadFiles = vi.fn(async () => [{ name: "one.pdf", path: "/media/one.pdf", url: "/media/one.pdf", kind: "file" as const, mime: "application/pdf", bytes: 3 }]);
    try {
      await act(async () => root.render(<I18nProvider language="zh-CN"><PluginCapabilityHost calls={[source]} plugins={[]} client={client} uploadFiles={uploadFiles} /></I18nProvider>));
      expect(element.querySelector('[webkitdirectory]')).not.toBeNull();
      const picker = element.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(picker, "files", { configurable: true, value: [new File(["pdf"], "one.pdf", { type: "application/pdf" }), new File(["pdf"], "two.pdf", { type: "application/pdf" })] });
      await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
      expect(element.querySelector('[role="alert"]')).not.toBeNull();
      expect(Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "确认文献，继续")?.disabled).toBe(true);
      await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="移除文件 two.pdf"]')!.click());
      const submit = () => Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "确认文献，继续")!;
      await act(async () => submit().click());
      expect(element.querySelector(".review-upload")).not.toBeNull();
      expect(element.querySelector('[data-review-receipt]')).toBeNull();
      await act(async () => submit().click());
      expect(element.querySelector(".review-upload")).toBeNull();
      expect(element.querySelector('[data-review-receipt="source-import"]')?.textContent).toContain("one.pdf");
    } finally { await act(async () => root.unmount()); element.remove(); }
  });

});

// Exercise the shipped HTML and its real message bridge, not a duplicate renderer.
describe.skipIf(!process.env.LITERATURE_REVIEW_PLUGIN_ROOT)("PRD review card bundle", () => {
  async function bundle(run: (window: TestWindow, send: (type: string, data: unknown) => void, outgoing: any[]) => void) {
    const window = new TestWindow({ settings: { enableJavaScriptEvaluation: true } });
    try {
      const outgoing: any[] = []; vi.spyOn(window, "postMessage").mockImplementation((message) => { outgoing.push(message); });
      const html = readFileSync(path.join(process.env.LITERATURE_REVIEW_PLUGIN_ROOT!, "ui/bundles/review-cards/index.html"), "utf8");
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, "")); window.eval(html.match(/<script>([\s\S]*?)<\/script>/)![1]!);
      const send = (type: string, data: unknown) => window.eval(`window.dispatchEvent(new MessageEvent("message", { source: parent, data: ${JSON.stringify({ type: "memmy.plugin.render", version: 1, events: [{ type: "interaction", request: { interactionId: type, type: "custom", payload: { cardType: type, data } } }] })} }))`);
      run(window, send, outgoing);
    } finally { await window.happyDOM.close(); }
  }
  const button = (window: TestWindow, label: string) => Array.from(window.document.querySelectorAll("button")).find((node) => node.textContent === label)!;
  it("submits edited keyword weights and closes with cancel", async () => bundle((window, send, outgoing) => {
    send("keywords", { keywords: ["one", "two", "three"].map((term) => ({ term, selected: true, weight: 5 })) });
    const weight = window.document.querySelector<HTMLInputElement>('input[type="range"]')!; weight.value = "9"; weight.dispatchEvent(new window.Event("input"));
    button(window, "确认关键词").click();
    expect(outgoing.find((event) => event.response)?.response.values.keywords[0].weight).toBe(9);
    send("outline", { outline: [] });
    window.document.querySelector<HTMLButtonElement>('[aria-label="关闭并跳过当前卡片"]')!.click();
    expect(outgoing.filter((event) => event.response).at(-1)?.response.action).toBe("cancel");
  }));
  it("promotes and demotes outline nodes without losing descendants, and enforces PRD limits", async () => bundle((window, send, outgoing) => {
    send("outline", { outline: ["Intro", "Methods", "Future"].map((title, i) => ({ id: `s${i}`, title, children: i === 1 ? [{ id: "child", title: "Subtopic", children: [] }] : [] })) });
    window.document.querySelectorAll<HTMLButtonElement>('[aria-label="降为二级标题"]')[1]!.click();
    expect(window.document.querySelectorAll(".outline-head")).toHaveLength(2);
    expect(window.document.querySelectorAll(".child")).toHaveLength(2);
    button(window, "确认大纲").click();
    expect(window.document.querySelector(".error")?.textContent).toContain("3～20");
    window.document.querySelectorAll<HTMLButtonElement>('[aria-label="升为一级标题"]')[0]!.click();
    button(window, "确认大纲").click();
    const outline = outgoing.find((event) => event.response)?.response.values.outline;
    expect(outline).toHaveLength(3); expect(outline[0].children[0].title).toBe("Subtopic"); expect(outline[1].title).toBe("Methods");
  }));
  it("handles native drag/drop across levels and keyboard promotion without losing node IDs", async () => bundle((window, send, outgoing) => {
    send("outline", { outline: ["Intro", "Methods", "Results", "Future"].map((title, i) => ({ id: `s${i}`, title, children: [] })) });
    const handles = window.document.querySelectorAll(".outline-head .drag-handle");
    const drag = new window.MouseEvent("dragstart", { clientX: 40, clientY: 100, bubbles: true }); handles[1]!.dispatchEvent(drag);
    window.document.querySelector(".outline-head")!.dispatchEvent(new window.MouseEvent("drop", { clientX: 100, clientY: 100, bubbles: true }));
    expect(window.document.querySelectorAll(".outline-head")).toHaveLength(3);
    expect(window.document.querySelector('.child input')?.getAttribute("aria-label")).toBe("二级章节标题");
    const childHandle = window.document.querySelector(".child .drag-handle")!;
    childHandle.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(window.document.querySelectorAll(".outline-head")).toHaveLength(4);
    expect(window.document.activeElement?.getAttribute("aria-label")).toBe("拖曳一级章节：Methods");
    button(window, "确认大纲").click();
    expect(outgoing.find((event) => event.response)?.response.values.outline.map((node: any) => node.id)).toEqual(["s0", "s1", "s2", "s3"]);
  }));
  it("distinguishes local files from internet full text", async () => bundle((window, send, outgoing) => {
    send("paper-selection", { papers: [{ id: "online", title: "Online PDF", availability: "full-text" }, { id: "local", title: "Local PDF" }], localPaperIds: ["local"] });
    expect(Array.from(window.document.querySelectorAll(".source-status")).map((node) => node.textContent)).toEqual(["需联网获取", "本机已有"]);
  }));
});
