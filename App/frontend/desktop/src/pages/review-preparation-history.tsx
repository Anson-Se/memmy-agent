import "./review-cards.css";
import type { PluginInteractionRequest } from "@memmy/local-api-contracts";
import { useOptionalPluginUiCalls, type PluginUiCall } from "../app/plugin-ui-context.js";
import { AgentQuestionCard, type AgentQuestionCardPayload, type AgentQuestionResponse } from "./agent-question-card.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";

const labels: Record<string, MessageKey> = {
  "review-spec": "plugin.review.requirements", "source-import": "plugin.review.sources",
  keywords: "plugin.review.keywords", outline: "plugin.review.outline", "paper-selection": "plugin.review.papers"
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";

export function isReviewPreparation(call: PluginUiCall): boolean {
  return call.pluginId === "literature-review" && call.capabilityId === "review_request_interaction"
    && call.events.some((event) => event.type === "interaction" && text(record(event.request.payload).cardType) in labels);
}
export function reviewResponseKey(call: PluginUiCall, interactionId: string): string {
  return `${call.pluginId}:${call.callId}:${interactionId}`;
}
export interface ReviewReceipt {
  id: string; taskKey: string; type: string; request: PluginInteractionRequest; response: Record<string, unknown>;
}
export interface ReviewPreparationGroup { key: string; complete: boolean; receipts: ReviewReceipt[] }

/** Read acknowledged responses, never infer approval from a proposal or a terminal error. */
export function collectReviewPreparation(calls: PluginUiCall[], acknowledged: ReadonlyMap<string, unknown>): ReviewPreparationGroup[] {
  const groups = new Map<string, ReviewPreparationGroup>();
  const waiting = new Set<string>();
  for (const call of calls) {
    if (call.pluginId === "literature-review" && call.capabilityId === "review_update_spec") {
      const event = [...call.events].reverse().find((item) => item.type === "result");
      const output = event?.type === "result" ? record(event.output) : {};
      const spec = record(record(output.data).spec);
      const taskId = text(output.taskId);
      if (output.ok === true && taskId && Object.keys(spec).length) {
        const taskKey = JSON.stringify([call.conversationId, taskId]);
        const group = groups.get(taskKey) ?? { key: taskKey, complete: false, receipts: [] };
        group.complete = false;
        group.receipts.push({ id: `${call.callId}:scope`, taskKey, type: "review-spec", request: { interactionId: `${call.callId}:scope`, type: "question", payload: { taskId } }, response: { action: "submit", values: { spec } } });
        groups.set(taskKey, group);
      }
      continue;
    }
    if (!isReviewPreparation(call)) continue;
    const result = [...call.events].reverse().find((event) => event.type === "result");
    const data = result?.type === "result" ? record(record(result.output).data) : {};
    const latest = [...call.events].reverse().find((event) => event.type === "interaction");
    if (latest?.type !== "interaction") continue;
    const payload = record(latest.request.payload);
    const taskKey = JSON.stringify([call.conversationId, payload.taskId || call.callId]);
    const key = reviewResponseKey(call, latest.request.interactionId);
    const rawResponse = data.interactionId === latest.request.interactionId ? data.response : acknowledged.get(key);
    if (rawResponse === undefined) {
      if (!call.events.some((event) => event.type === "result" || event.type === "error")) waiting.add(taskKey);
      continue;
    }
    const response = record(rawResponse);
    if (response.action === "refresh" || record(response.values).intent === "import-fulltext") continue;
    const type = text(payload.cardType);
    const group = groups.get(taskKey) ?? { key: taskKey, complete: false, receipts: [] };
    group.receipts.push({ id: key, taskKey, type, request: latest.request, response });
    // A later correction can reopen research preparation.
    group.complete = type === "paper-selection" && (response.action === "submit" || response.action === undefined);
    groups.set(taskKey, group);
  }
  return [...groups.values()].map((group) => ({ ...group, complete: group.complete && !waiting.has(group.key) }));
}

export function reviewReceiptLines(receipt: ReviewReceipt): string[] {
  const values = record(receipt.response.values);
  if (receipt.type === "review-spec") {
    const spec = record(values.spec), range = record(spec.dateRange);
    return [text(spec.topic), [text(range.from), text(range.to)].filter(Boolean).join("–"), text(spec.writingGuidance)].filter(Boolean);
  }
  if (receipt.type === "keywords") return array(values.keywords).filter((item) => record(item).selected !== false).map((item) => {
    const keyword = record(item); return `${text(keyword.term)} · ${text(keyword.weight)}`;
  });
  if (receipt.type === "outline") return array(values.outline).flatMap((item, index) => {
    const node = record(item); return [`${index + 1}. ${text(node.title)}`, ...array(node.children).map((child, childIndex) => `${index + 1}.${childIndex + 1} ${text(record(child).title)}`)];
  });
  if (receipt.type === "source-import") return array(receipt.response.files).map((file) => text(record(file).name)).filter(Boolean);
  if (receipt.type === "paper-selection") {
    const selected = new Set(array(values.includedPaperIds));
    const payload = record(receipt.request.payload), data = record(payload.data);
    const papers = array(data.papers || data.candidates);
    const names = new Map(papers.map((paper) => [record(paper).id, text(record(paper).title)]));
    return [...selected].map((id) => names.get(id) || text(id));
  }
  return [];
}

export function ReviewPreparationHistory({ groups }: { groups: ReviewPreparationGroup[] }) {
  const { t } = useTranslation();
  return <>{groups.map((group) => (
    <details key={`${group.key}:${group.complete}`} open={group.complete ? undefined : true} className="review-preparation" data-review-preparation={group.complete ? "complete" : "pending"}>
      <summary className="cursor-pointer py-2 text-xs text-text-ink/50">{t(group.complete ? "plugin.review.prepared" : "plugin.review.preparation")}</summary>
      <div className="review-preparation-items">
        {group.receipts.map((receipt) => {
          const action = receipt.response.action;
          const cancelled = action === "cancel", skipped = action === "chat-feedback";
          const lines = cancelled || skipped ? [] : reviewReceiptLines(receipt);
          return <details key={receipt.id} className="review-receipt" data-review-receipt={receipt.type}>
            <summary className="cursor-pointer text-xs text-text-ink/65">
              {t(labels[receipt.type]!)} · {t(cancelled ? "plugin.review.cancelled" : skipped ? "plugin.review.skipped" : "plugin.review.confirmed")}{lines.length ? ` · ${lines.length}` : ""}
            </summary>
            <div className="review-receipt-content">
              {lines.length ? lines.map((line, index) => <p key={index}>{line}</p>) : <p>{t(cancelled ? "plugin.review.cancelled" : skipped ? "plugin.review.skipped" : "plugin.review.noSources")}</p>}
            </div>
          </details>;
        })}
      </div>
    </details>
  ))}</>;
}

/** Move a native answer into preparation only after the matching spec was durably saved. */
export function isConsolidatedScopeQuestion(card: AgentQuestionCardPayload, calls: PluginUiCall[]): boolean {
  if (card.context?.workflow !== "literature-review") return false;
  return calls.some((call) => call.pluginId === "literature-review" && call.capabilityId === "review_update_spec" && call.events.some((event) => {
    if (event.type !== "result") return false;
    const output = record(event.output), data = record(output.data), confirmation = record(data.scopeConfirmation);
    return output.ok === true && output.taskId === card.context!.taskId && Object.keys(record(data.spec)).length > 0 && confirmation.questionRequestId === card.requestId;
  }));
}

export function WorkflowQuestionCard(props: { card: AgentQuestionCardPayload; response?: AgentQuestionResponse | null; onSubmit?: (response: AgentQuestionResponse) => Promise<boolean> | boolean }) {
  const calls = useOptionalPluginUiCalls();
  if (props.response && !props.response.cancelled && isConsolidatedScopeQuestion(props.card, calls)) return null;
  return <AgentQuestionCard {...props} />;
}
