// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginUiProvider, usePluginUi } from "../../app/plugin-ui-context.js";
import { useConversationFeatures } from "../conversation-features.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  chatId: null as string | null,
  invoke: vi.fn(async () => ({ callId: "guide-call" })),
  list: vi.fn(), dispatch: vi.fn(), openRecording: vi.fn(),
  send: vi.fn(async () => true), sending: false,
  messages: [] as AgentChatMessage[],
}));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: clients }) }));
vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({
  state: { agent: { currentChatId: mocks.chatId, currentSessionKey: mocks.chatId ? `websocket:${mocks.chatId}` : null, isSending: mocks.sending },
    account: { userId: "test-user" }, bootstrap: { app: { userMode: "account" } } }, dispatch: mocks.dispatch
}) }));
vi.mock("../recording-entry.js", async (original) => {
  const actual = await original<typeof import("../recording-entry.js")>();
  const { useState } = await import("react");
  return { ...actual, useRecordingEntry: () => {
    const [compactOpen, setCompact] = useState(false);
    return { compactOpen, toggleCompact: () => setCompact((open) => !open), closeCompact: () => setCompact(false),
      close() {}, archive() {}, session: { status: "idle", elapsedMs: 0, live: null, error: null, lines: [], recordings: [],
        start() {}, pause() {}, resume() {}, finish() {} } };
  } };
});

const clients = { plugins: { list: mocks.list, invoke: mocks.invoke, getUi: vi.fn(), respond: vi.fn(), cancel: vi.fn() },
  asr: { transcribe: vi.fn() }, memmyAgent: { uploadAgentMedia: vi.fn(), resolveArtifact: vi.fn() } };
const plugin = { id: "legal-labor", state: "active", manifest: { capabilities: [], commands: [
  { command: "/legal-guide", name: "诊断指引", capabilityId: "guide-open", pinned: true, icon: "file-text" },
  { command: "/legal-record", name: "访谈录音", capabilityId: "material-collect", pinned: true, topbar: true, icon: "audio-lines" }
] } };

describe("conversation feature integration", () => {
  let root: Root;
  let container: HTMLDivElement;
  let ui: ReturnType<typeof usePluginUi>;
  let features: ReturnType<typeof useConversationFeatures>;
  function Harness() {
    ui = usePluginUi();
    features = useConversationFeatures({ scopeKey: mocks.chatId ?? "draft-1", agentMessages: mocks.messages, onDraft: vi.fn(),
      onStageFiles: async () => {}, onSend: mocks.send, onOpenRecording: mocks.openRecording });
    return <>{features.recorders}<nav>{features.shortcuts}</nav><section>{features.cards}</section></>;
  }
  const render = () => root.render(<I18nProvider language="zh-CN"><PluginUiProvider><Harness /></PluginUiProvider></I18nProvider>);
  const button = (name: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === name);
  const enterLegalConversation = async () => {
    mocks.chatId = "legal-chat";
    await act(async () => render());
    await act(async () => ui.receive({ pluginId: "legal-labor", capabilityId: "session-start", callId: "session-call",
      conversationId: "websocket:legal-chat", origin: "agent", event: { type: "progress", current: 0, message: "Preparing" } }));
  };
  beforeEach(() => {
    vi.clearAllMocks(); mocks.chatId = null; mocks.sending = false; mocks.messages = []; mocks.list.mockResolvedValue([plugin]);
    localStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });

  it("keeps legal shortcuts out of empty and unrelated conversations", async () => {
    await act(async () => render());
    expect(container.querySelector("nav")?.textContent).toBe("");
    mocks.chatId = "ordinary-chat";
    await act(async () => render());
    expect(container.querySelector("nav")?.textContent).toBe("");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("opens one Host recorder without invoking material collection or starting a diagnosis", async () => {
    mocks.sending = true;
    await enterLegalConversation();
    expect(container.querySelectorAll("nav button")).toHaveLength(2);
    expect(button("录音")).toBeUndefined();
    await act(async () => button("访谈录音")!.click());
    expect(container.querySelectorAll(".recording-entry-card")).toHaveLength(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(features.waiting).toBe(false);
    await act(async () => button("访谈录音")!.click());
    expect(container.querySelector(".recording-entry-card")).toBeNull();
  });

  it("routes an explicitly typed recording command to the Host even without a diagnosis session", async () => {
    await act(async () => render());
    await act(async () => expect(features.runCommand("/legal-record")).toBe(true));
    expect(container.querySelector(".recording-entry-card")).not.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("opens the read-only guide directly and leaves session creation to the Agent", async () => {
    await enterLegalConversation();
    await act(async () => button("诊断指引")!.click());
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("legal-labor", "guide-open", expect.objectContaining({
      conversationId: "legal-chat", origin: "user", input: { command: "/legal-guide", arguments: "" }
    }));
  });

  it("never routes the guide shortcut into session-start even with an outdated command manifest", async () => {
    mocks.list.mockResolvedValue([{ ...plugin, manifest: { ...plugin.manifest,
      commands: plugin.manifest.commands.map((command) => command.command === "/legal-guide"
        ? { ...command, capabilityId: "session-start" } : command) } }]);
    await enterLegalConversation();
    await act(async () => button("诊断指引")!.click());
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("legal-labor", "guide-open", expect.objectContaining({ origin: "user" }));
    expect(mocks.send).not.toHaveBeenCalled();
    expect(features.waiting).toBe(false);
  });

  it("does not show a late invocation failure in a different conversation", async () => {
    let reject!: (error: Error) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<{ callId: string }>((_resolve, fail) => { reject = fail; }));
    await enterLegalConversation();
    await act(async () => button("诊断指引")!.click());
    mocks.chatId = "different-chat";
    await act(async () => render());
    await act(async () => reject(new Error("old conversation failure")));
    expect(container.textContent).not.toContain("old conversation failure");
  });

  it("releases only the captured Agent question after explicit steering, leaving independent cards alone", async () => {
    await enterLegalConversation();
    const receiveQuestion = (callId: string, origin: "agent" | "user", turnId: string) => ui.receive({
      pluginId: "legal-labor", capabilityId: "gap-resolve", callId, origin, turnId, conversationId: "legal-chat",
      event: { type: "interaction", request: { interactionId: "question", type: "question", payload: {
        title: "确认信息", questions: [{ id: "q", label: "地区", type: "text" }]
      } } }
    });
    await act(async () => {
      receiveQuestion("active-question", "agent", "turn-current");
      receiveQuestion("other-turn", "agent", "turn-other");
      receiveQuestion("user-card", "user", "turn-current");
    });
    const release = features.capturePendingInputRelease("turn-current");
    expect(clients.plugins.cancel).not.toHaveBeenCalled();
    expect(ui.answeredInteractions.has("legal-labor:active-question:question")).toBe(false);
    await act(async () => release());
    expect(clients.plugins.cancel).toHaveBeenCalledExactlyOnceWith("legal-labor", "active-question");
    expect(ui.answeredInteractions.has("legal-labor:active-question:question")).toBe(true);
    expect(ui.dismissedCallIds.has("active-question")).toBe(true);
    expect(ui.dismissedCallIds.has("other-turn")).toBe(false);
    expect(ui.dismissedCallIds.has("user-card")).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not release a newer question that arrived while steering was awaiting acknowledgement", async () => {
    await enterLegalConversation();
    const receive = (interactionId: string) => ui.receive({ pluginId: "legal-labor", capabilityId: "gap-resolve",
      callId: "flow-question", origin: "agent", turnId: "turn-current", conversationId: "legal-chat",
      event: { type: "interaction", request: { interactionId, type: "question", payload: { title: "确认信息" } } } });
    await act(async () => receive("first"));
    const release = features.capturePendingInputRelease("turn-current");
    await act(async () => receive("next"));
    await act(async () => release());
    expect(clients.plugins.cancel).not.toHaveBeenCalled();
    expect(ui.dismissedCallIds.has("flow-question")).toBe(false);
  });

  it("keeps the pending card when releasing its plugin call fails", async () => {
    await enterLegalConversation();
    await act(async () => ui.receive({ pluginId: "legal-labor", capabilityId: "gap-resolve", callId: "pending",
      origin: "agent", turnId: "turn-current", conversationId: "legal-chat",
      event: { type: "interaction", request: { interactionId: "q", type: "question", payload: { title: "确认信息" } } } }));
    clients.plugins.cancel.mockRejectedValueOnce(new Error("offline"));
    await expect(features.capturePendingInputRelease("turn-current")()).rejects.toThrow("offline");
    expect(ui.answeredInteractions.has("legal-labor:pending:q")).toBe(false);
    expect(ui.dismissedCallIds.has("pending")).toBe(false);
  });
  it("clears a stale keyword wait after the matching tool finishes", async () => {
    mocks.chatId = "review-chat";
    await act(async () => render());
    await act(async () => ui.receive({ pluginId: "literature-review", capabilityId: "review_request_interaction",
      callId: "keywords-call", agentToolCallId: "tool-keywords", origin: "agent", turnId: "turn-review",
      conversationId: "review-chat", event: { type: "interaction", request: { interactionId: "keywords",
        type: "custom", payload: { title: "确认检索关键词", cardType: "keywords" } } } }));
    expect(features.waitingLabel).toBe("等待确认检索关键词");
    expect(features.processInteraction?.awaiting).toBe(true);
    mocks.messages = [{ id: "done", role: "tool", kind: "trace", content: "", turnId: "turn-review",
      toolEvents: [{ phase: "end", call_id: "provider-call", ui_tool_call_id: "tool-keywords",
        name: "mcp_plugins_plugin_review_request_interaction" }] }];
    await act(async () => render());
    expect(ui.answeredInteractions.has("literature-review:keywords-call:keywords")).toBe(true);
    expect(features.waitingLabel).toBeNull();
    // The finished tool owns its completed action row; the live waiting slot is gone.
    expect(features.processInteraction).toBeNull();
  });

  it("keeps Agent Office progress and files off the composer", async () => {
    mocks.chatId = "office-chat";
    await act(async () => render());
    const call = { pluginId: "office", capabilityId: "office_create", callId: "office-call",
      conversationId: "office-chat", origin: "agent" as const, turnId: "office-turn" };
    await act(async () => ui.receive({ ...call,
      event: { type: "progress", current: 0, message: "Office processing" } }));
    expect(container.textContent).not.toContain("Office processing");
    const path = "/workspace/outputs/office/office-smoke-test.docx";
    await act(async () => {
      ui.receive({ ...call, event: { type: "artifact", artifact: { id: "office-file", name: "office-smoke-test.docx",
        path, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        uri: "https://example.test/office-file", role: "deliverable" } } });
      ui.receive({ ...call, event: { type: "result", output: { ok: true } } });
    });
    expect(container.textContent).not.toContain("office-smoke-test.docx");
    expect(ui.calls.find((item) => item.callId === "office-call")?.events.some((event) => event.type === "artifact")).toBe(true);
  });

});
