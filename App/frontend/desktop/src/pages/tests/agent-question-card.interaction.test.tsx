// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  AgentQuestionCard,
  pendingAgentQuestion, composerQuestionAnswer,
  normalizeAgentQuestionResponse,
  readAgentQuestionCard,
  readAgentQuestionResponse,
  serializeAgentQuestionResponse,
  visibleAgentQuestionResponseContent,
  type AgentQuestionCardPayload,
  type AgentQuestionResponse,
} from "../agent-question-card.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: AgentQuestionCardPayload = {
  version: 1,
  requestId: "question-1",
  title: "继续前请确认",
  questions: [{
    id: "uploads",
    prompt: "还有其他文件需要上传吗？",
    options: [
      { id: "more", label: "继续上传文件" },
      { id: "done", label: "已全部上传，继续" },
    ],
    allowMultiple: false,
    allowOther: true,
  }],
};

describe("AgentQuestionCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("reads the structured agent UI payload", () => {
    expect(readAgentQuestionCard({ questionCard: card })).toEqual(card);
    expect(readAgentQuestionCard({ questionCard: { version: 1, requestId: "", questions: [] } })).toBeNull();
  });

  it("submits a clicked option as a structured response", async () => {
    const onSubmit = vi.fn(async () => true);
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <AgentQuestionCard card={card} onSubmit={onSubmit} />
      </I18nProvider>
    ));
    const option = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("已全部上传，继续"))!;
    const submit = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("提交回答"))!;

    expect(submit.disabled).toBe(true);
    act(() => option.click());
    expect(option.getAttribute("aria-pressed")).toBe("true");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    });
  });

  it("closes without submitting draft answers and restores cancellation", async () => {
    const onSubmit = vi.fn(async () => true);
    await act(async () => root.render(<I18nProvider language="zh-CN"><AgentQuestionCard card={card} onSubmit={onSubmit}/></I18nProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭卡片"]')!.click());
    expect(onSubmit).toHaveBeenCalledWith({ requestId: card.requestId, cancelled: true, answers: [] });
    expect(container.textContent).toContain("× 已取消"); expect(container.querySelector("button")).toBeNull();
    expect(normalizeAgentQuestionResponse({ requestId: card.requestId, cancelled: true, answers: [] })?.cancelled).toBe(true);
  });

  it("serializes an answer for the model while hiding the transport marker", () => {
    const response: AgentQuestionResponse = {
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    };

    const serialized = serializeAgentQuestionResponse(card, response);

    expect(serialized.displayContent).toContain("已全部上传，继续");
    expect(serialized.content).toContain("memmy-question-response:");
    expect(readAgentQuestionResponse(serialized.content)).toEqual(response);
    expect(visibleAgentQuestionResponseContent(serialized.content)).toBe(serialized.displayContent);
  });

  it("renders an answered card as read-only", async () => {
    const response: AgentQuestionResponse = {
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <AgentQuestionCard card={card} response={response} />
      </I18nProvider>
    ));

    expect(container.textContent).toContain("已全部上传，继续");
    expect(container.textContent).toContain("已回答");
    expect(container.textContent).not.toContain("提交回答");
  });
});

 describe("question routing from composer", () => {
  it("routes a free-text answer to the active question without queuing a new turn", () => {
    const active = { turnId: "active", agentUi: { questionCard: card } };
    expect(pendingAgentQuestion([{ ...active, turnId: "old" }, active], "active")).toEqual(card);
    expect(composerQuestionAnswer(card, "保留中文正文继续")).toEqual({ requestId: card.requestId, answers: [{ questionId: "uploads", selectedOptionIds: [], otherText: "保留中文正文继续" }] });
    expect(pendingAgentQuestion([{ ...active, questionResponse: { requestId: card.requestId } }], "active")).toBeNull();
    expect(pendingAgentQuestion([active], null)).toBeNull();
  });
  it("does not guess answers to multiple questions or route commands as answers", () => {
    expect(composerQuestionAnswer({ ...card, questions: [...card.questions, { ...card.questions[0]!, id: "second" }] }, "继续")).toBeNull();
    expect(composerQuestionAnswer(card, "/stop")).toBeNull();
    expect(composerQuestionAnswer({ ...card, questions: [{ ...card.questions[0]!, allowOther: false }] }, "继续")).toBeNull();
  });
});

describe("native literature-review scope", () => {
  it("shows only the two PRD questions and restores a collapsed, read-only answer summary", async () => {
    const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
    const scope: AgentQuestionCardPayload = { version: 1, requestId: "scope-native", title: "确认研究需求", context: { workflow: "literature-review", taskId: "review-1" }, questions: [
      { id: "research-domain", prompt: "研究领域", options: [{ id: "ai", label: "AI / 计算机技术" }, { id: "medical", label: "医学 / 生命科学" }], allowMultiple: false, allowOther: true },
      { id: "reference-range", prompt: "参考文献检索范围", options: [{ id: "3", label: "近 3 年" }, { id: "5", label: "近 5 年" }], allowMultiple: false, allowOther: true }
    ] };
    let answer: AgentQuestionResponse | undefined;
    const submit = vi.fn(async (response: AgentQuestionResponse) => { answer = response; return true; });
    try {
      expect(readAgentQuestionCard({ questionCard: scope })?.context).toEqual(scope.context);
      await act(async () => root.render(<I18nProvider language="zh-CN"><AgentQuestionCard card={scope} onSubmit={submit}/></I18nProvider>));
      expect(element.querySelectorAll('[role="group"]')).toHaveLength(2);
      expect(element.querySelector('input[type="number"]')).toBeNull();
      const buttons = [...element.querySelectorAll("button")];
      await act(async () => buttons.find((button) => button.textContent?.includes("AI / 计算机技术"))!.click());
      await act(async () => buttons.find((button) => button.textContent?.includes("近 5 年"))!.click());
      await act(async () => [...element.querySelectorAll("button")].find((button) => button.textContent === "确认")!.click());
      expect(submit).toHaveBeenCalledTimes(1);
      expect(element.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
      expect(element.textContent).toContain("近 5 年"); expect(element.querySelector("button")).toBeNull();
      await act(async () => root.render(<I18nProvider language="zh-CN"><AgentQuestionCard key="restored" card={scope} response={answer}/></I18nProvider>));
      expect(element.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
      expect(element.textContent).toContain("AI / 计算机技术");
    } finally { await act(async () => root.unmount()); element.remove(); }
  });
});
