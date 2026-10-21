/** Local visual fixture: uses the shipped renderer and the real host; no backend writes. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { AgentQuestionCard, type AgentQuestionCardPayload } from "../../agent-question-card.js";
import { isConsolidatedScopeQuestion } from "../../review-preparation-history.js";
import { PluginCapabilityHost } from "../../plugin-capability-host.js";
import type { PluginUiCall } from "../../../app/plugin-ui-context.js";
import { PluginUiProvider, usePluginUi } from "../../../app/plugin-ui-context.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import "../../../styles.css";
import renderer from "../../../../../../../../Literature-Review-Plugin/ui/bundles/review-cards/index.html?raw";
const plugin = InstalledPluginSchema.parse({ id: "literature-review", version: "0.5.39", manifest: { apiVersion: "memmy/v1", id: "literature-review", name: "Literature Review", version: "0.5.39", runtime: { adapter: "command", config: {} }, capabilities: [{ id: "review_request_interaction", name: "Review cards", description: "Preview", inputSchema: {}, outputSchema: {}, execution: "request" }], permissions: [], ui: { renderer: { entry: "ui/bundles/review-cards/index.html", height: 680 } } }, state: "active", approvedPermissions: [], config: {}, lastError: null, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" });
const types = ["review-spec", "source-import", "keywords", "outline", "paper-selection"];
const keywords = ["long-term memory", "LLM memory", "memory-augmented generation", "memory evaluation"].map((term, index) => ({ id: `k${index}`, term, aliases: [], weight: 10 - index, selected: true }));
const outline = ["引言与研究范围", "记忆表征与存储", "检索与上下文注入", "写入、更新与遗忘机制", "评测方法与公开基准", "开放问题与未来方向"].map((title, index) => ({ id: `s${index}`, title, guidance: "", children: index === 0 ? [{ id: "s0-1", title: "长期记忆的概念与分类", children: [] }] : [] }));
const papers = [{ id: "p0", title: "MemGPT: Towards LLMs as Operating Systems", authors: ["Packer et al."], year: 2023 }, { id: "p1", title: "MemoryBank: Enhancing Large Language Models with Long-Term Memory", authors: ["Zhong et al."], year: 2024 }, { id: "p2", title: "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", authors: ["Wu et al."], year: 2024 }];
const data: Record<string, unknown> = { keywords: { keywords }, outline: { outline }, "paper-selection": { papers, localPaperIds: ["p1"], includedPaperIds: ["p0", "p1", "p2"] } };
function makeCall(type: string, sequence: number): PluginUiCall { return { pluginId: plugin.id, callId: `preview-${sequence}`, capabilityId: "review_request_interaction", conversationId: "chat-preview", origin: "agent", events: [{ type: "interaction", request: { interactionId: `preview-${sequence}`, type: type === "source-import" ? "file-input" : "custom", payload: { cardType: type, title: "添加本地参考文献", taskId: "review-preview", chatFeedback: true, accept: [".pdf", ".docx", ".txt", ".md"], maxFiles: 200, multiple: true, allowDirectory: true, data: data[type] || {} } } }] }; }
function Preview() {
  const [scope, setScope] = useState<AgentQuestionCardPayload | null>(null);
  const [calls, setCalls] = useState<PluginUiCall[]>([]); const [message, setMessage] = useState(""); const ui = usePluginUi();
  const client = { getUi: async () => renderer, cancel: async () => {}, respond: async (_plugin: string, callId: string, interactionId: string, response: unknown) => {
    setCalls((current) => current.map((call) => call.callId === callId ? { ...call, events: [...call.events, { type: "result", output: { data: { interactionId, response } } }] } : call));
  } };
  return <main style={{ maxWidth: 800, margin: "40px auto", padding: "0 16px", color: "#253331" }}>
    <nav style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 28 }}>{types.map((type) => <button key={type} onClick={() => {
      if (type === "review-spec") setScope({ version: 1, requestId: `native-${Date.now()}`, title: "确认研究需求", context: { workflow: "literature-review", taskId: "review-preview" }, questions: [
        { id: "research-domain", prompt: "这篇文献综述的主题 / 研究领域是什么？", options: ["AI / 计算机技术", "金融 / 经济", "医学 / 生命科学", "社科 / 教育 / 管理"].map((label, index) => ({ id: `domain-${index}`, label })), allowMultiple: false, allowOther: true },
        { id: "reference-range", prompt: "希望参考文献检索覆盖什么时间范围？", options: [3,5,10].map((years) => ({ id: `recent-${years}`, label: `近 ${years} 年` })), allowMultiple: false, allowOther: true }
      ] });
      else setCalls((current) => [...current, makeCall(type, current.length)]);
    }}>{type}</button>)}<button onClick={() => { setCalls([]); setScope(null); }}>重置</button></nav>
    <p style={{ marginBottom: 20 }}>我会结合研究主题与本机文献，逐步确认关键词、大纲和参考文献。</p>
    {scope && !isConsolidatedScopeQuestion(scope, calls) ? <AgentQuestionCard key={scope.requestId} card={scope} onSubmit={async (response) => {
      if (response.cancelled) return true;
      const domain = response.answers.find((answer) => answer.questionId === "research-domain")!;
      const range = response.answers.find((answer) => answer.questionId === "reference-range")!;
      const topic = domain.otherText || scope.questions[0]!.options.find((option) => domain.selectedOptionIds.includes(option.id))!.label;
      const years = Number(range.selectedOptionIds[0]?.replace("recent-", ""));
      const dateRange = years ? { from: 2026 - years + 1, to: 2026 } : {};
      setCalls((current) => [...current, { pluginId: plugin.id, capabilityId: "review_update_spec", callId: `scope-save-${current.length}`, conversationId: "chat-preview", origin: "agent", events: [{ type: "result", output: { ok: true, taskId: "review-preview", data: { spec: { topic, dateRange }, scopeConfirmation: { questionRequestId: response.requestId } } } }] }]); return true;
    }}/> : null}
    <PluginCapabilityHost calls={calls} plugins={[plugin]} client={client} />
    <form style={{ marginTop: 16, padding: 16, border: "1px solid #e3eeec", borderRadius: 14 }} onSubmit={(event) => { event.preventDefault(); ui.routeChatFeedback("chat-preview", { message, clientRequestId: String(Date.now()) }); setMessage(""); }}><input aria-label="聊天消息" placeholder="补充要求，或发送新消息跳过当前卡片…" value={message} onChange={(event) => setMessage(event.target.value)} style={{ width: "85%" }}/><button type="submit">发送</button></form>
  </main>;
}
createRoot(document.getElementById("root")!).render(<I18nProvider language="zh-CN"><PluginUiProvider><Preview /></PluginUiProvider></I18nProvider>);
