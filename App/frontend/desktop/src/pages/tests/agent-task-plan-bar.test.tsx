// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTaskPlanState } from "../../api/memmy-agent-client.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentTaskPlanBar } from "../agent-task-plan-bar.js";
import { AgentThreadMessages, shouldEmbedTaskPlanInProcess } from "../agent-thread-messages.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function plan(overrides: Partial<AgentTaskPlanState> = {}): AgentTaskPlanState {
  return {
    plan_id: "32f2868d-ae25-4f47-b33b-17f474eecc3a",
    title: "Generate literature review",
    status: "active",
    items: [
      { id: "evidence", content: "Map evidence", status: "completed" },
      { id: "sections", content: "Generate sections", status: "in_progress" },
      { id: "render", content: "Render and verify outputs", status: "pending" },
    ],
    created_at: "2026-09-14T06:00:00.000Z",
    updated_at: "2026-09-14T06:05:00.000Z",
    ...overrides,
  };
}

describe("AgentTaskPlanBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(value: AgentTaskPlanState): void {
    act(() => root.render(
      <I18nProvider language="en-US">
        <AgentTaskPlanBar plan={value} />
      </I18nProvider>
    ));
  }

  it("renders ordered progress and supports collapsing the fixed panel", () => {
    render(plan());
    const header = container.querySelector<HTMLButtonElement>(
      ".agent-task-plan-bar__header",
    )!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Task plan");
    expect(container.textContent).not.toContain("Generate literature review");
    expect(container.textContent).toContain("1/3");
    expect([...container.querySelectorAll(".agent-task-plan-bar__item")]
      .map((item) => item.textContent)).toEqual([
        "Map evidence",
        "Generate sections",
        "Render and verify outputs",
      ]);

    act(() => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".agent-task-plan-bar__items")).toBeNull();
  });

  it("starts a completed plan collapsed while preserving its summary", () => {
    render(plan({
      status: "completed",
      items: [
        { id: "evidence", content: "Map evidence", status: "completed" },
        { id: "sections", content: "Generate sections", status: "completed" },
      ],
    }));
    expect(container.querySelector(".agent-task-plan-bar__header")
      ?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Completed");
    expect(container.textContent).toContain("2/2");
  });

  it("collapses a blocked standalone plan when its run ends", () => {
    render(plan());
    expect(container.querySelector(".agent-task-plan-bar__header")?.getAttribute("aria-expanded")).toBe("true");
    render(plan({ status: "blocked" }));
    expect(container.querySelector(".agent-task-plan-bar__header")?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".agent-task-plan-bar__items")).toBeNull();
  });

  it("does not render an empty task plan snapshot", () => {
    render(plan({
      plan_id: null,
      title: "",
      status: null,
      items: [],
      created_at: null,
      updated_at: null,
    }));
    expect(container.querySelector(".agent-task-plan-bar")).toBeNull();
  });

  it("keeps one checklist at its creation step and updates that card in place", () => {
    const active = plan();
    const messages: AgentChatMessage[] = [
      { id: "user", role: "user", content: "按清单推进", turnId: "turn" },
      { id: "create", role: "tool", kind: "trace", content: "", turnId: "turn", toolEvents: [
        { phase: "end", call_id: "create", name: "create_task_plan", arguments: { title: active.title } }
      ] },
      { id: "update", role: "tool", kind: "trace", content: "", turnId: "turn", isStreaming: true, toolEvents: [
        { phase: "end", call_id: "update", name: "update_task_plan", arguments: { item_id: "sections", status: "in_progress" } }
      ] }
    ];
    expect(shouldEmbedTaskPlanInProcess(messages, "plan-chat", active, true)).toBe(true);
    const show = (value: AgentTaskPlanState) => act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="plan-chat" messages={messages} isSending taskPlan={value} />
    </I18nProvider>));
    show(active);
    const card = container.querySelector<HTMLElement>(".agent-activity-cluster__body .agent-task-plan-bar--embedded")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("1/3");
    expect(container.querySelector(".agent-activity-timeline-item--tool")?.textContent).toContain("Create task plan");
    expect(container.textContent).not.toContain("Update task plan");
    show(plan({ items: [
      { id: "evidence", content: "Map evidence", status: "completed" },
      { id: "sections", content: "Generate sections", status: "completed" },
      { id: "render", content: "Render and verify outputs", status: "in_progress" }
    ] }));
    expect(container.querySelector(".agent-task-plan-bar--embedded")).toBe(card);
    expect(card.textContent).toContain("2/3");
  });

  it("keeps a stopped plan in the existing process rather than adding a new chat row", () => {
    const messages: AgentChatMessage[] = [
      { id: "user", role: "user", content: "写综述", turnId: "turn" },
      { id: "tool", role: "tool", kind: "trace", content: "", turnId: "turn", stoppedByUser: true,
        toolEvents: [{ phase: "end", call_id: "write", name: "write_file" }] }
    ];
    expect(shouldEmbedTaskPlanInProcess(messages, "stopped", plan(), false)).toBe(true);
    expect(shouldEmbedTaskPlanInProcess(messages, "stopped", plan({ status: "completed" }), false)).toBe(false);
    act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="stopped" messages={messages} taskPlan={plan()} />
    </I18nProvider>));
    expect(container.querySelector(".agent-activity-cluster__body .agent-task-plan-bar--embedded")).not.toBeNull();
    expect(container.querySelectorAll(".agent-task-plan-bar")).toHaveLength(1);
  });

  it("keeps a completed plan at the earlier creation turn after a later task", () => {
    const completed = plan({ status: "completed", items: plan().items.map((item) => ({ ...item, status: "completed" })) });
    const messages: AgentChatMessage[] = [
      { id: "user", role: "user", content: "做综述", turnId: "first" },
      { id: "create", role: "tool", kind: "trace", content: "", turnId: "first",
        toolEvents: [{ phase: "end", call_id: "create", name: "create_task_plan", arguments: { title: completed.title } }] },
      { id: "answer", role: "assistant", content: "第一轮完成", turnId: "first" },
      { id: "next-user", role: "user", content: "继续", turnId: "second" },
      { id: "next-tool", role: "tool", kind: "trace", content: "", turnId: "second",
        toolEvents: [{ phase: "end", call_id: "next", name: "read_file" }] }
    ];
    act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="history-plan" messages={messages} taskPlan={completed} />
    </I18nProvider>));
    const clusters = container.querySelectorAll(".agent-activity-cluster");
    expect(clusters).toHaveLength(2);
    act(() => clusters[0]!.querySelector<HTMLButtonElement>(".agent-activity-cluster__toggle")!.click());
    expect(clusters[0]!.querySelector(".agent-task-plan-bar--embedded")).not.toBeNull();
    expect(clusters[1]!.querySelector(".agent-task-plan-bar--embedded")).toBeNull();
  });
});
