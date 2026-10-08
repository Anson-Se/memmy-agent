import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  type LlmClient,
  type LlmCompletionOptions,
  type LlmMessage
} from "../../../src/index.js";
import { countSummaryTokens, summaryInputTokenBudget } from "../../../src/model/llm.js";
import { MEMORY_SUMMARY_MAX_TOKENS } from "../../../src/config/index.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

type CaptureCall = { messages: LlmMessage[]; payload: string };

function captureInputLlm(calls: CaptureCall[], l1Evidence: unknown[] = []): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/capture-input",
      model: "capture-input"
    },
    isConfigured: () => true,
    complete: async () => "unused",
    async completeJson<T extends Record<string, unknown>>(
      messages: LlmMessage[],
      options: LlmCompletionOptions
    ): Promise<T> {
      if (options.operation !== "capture.summarize") return { summary: "" } as unknown as T;
      calls.push({ messages, payload: messages.find((message) => message.role === "user")?.content ?? "" });
      return {
        l1: {
          title: "输入测试",
          summary: "捕获判定输入测试。",
          evidence: l1Evidence,
          unverified_answer: false
        },
        user: null
      } as unknown as T;
    },
    status: () => ({ provider: "host", model: "capture-input", configured: true, remote: true })
  };
}

function open(service: ReturnType<typeof createTestService>["service"], userId: string) {
  return service.openSession({ namespace: { source: "codex", profileId: "default", userId } });
}

/** Distinct Chinese text, so token counts are realistic and head/tail are recognisable. */
function chineseText(label: string, chars: number): string {
  const alphabet = "数据库迁移脚本配置测试接口日志缓存索引查询模型部署回滚权限用户会话任务结果";
  let text = "";
  for (let index = 0; text.length < chars; index += 1) {
    text += `${label}${alphabet[index % alphabet.length]}${index}`;
  }
  return text.slice(0, chars);
}

describe("capture decision input", () => {
  it("keeps the user text whole and the reply's head and tail", async () => {
    const calls: CaptureCall[] = [];
    const { service } = createTestService({ llm: captureInputLlm(calls) });
    const session = open(service, "capture-input-reply-user");
    const userText = `请帮我整理迁移步骤。${chineseText("甲", 1_800)}最后的要求：保留回滚脚本。`;
    const answer = `开头说明：先检查索引。${chineseText("乙", 3_000)}结尾结论：测试全部通过，要我继续部署吗？`;

    service.completeTurn("turn-capture-input-reply", { sessionId: session.sessionId, query: userText, answer });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(calls).toHaveLength(1);
    const payload = calls[0]!.payload;
    expect(payload).toContain("最后的要求：保留回滚脚本。");
    expect(payload).toContain(userText.replace(/\s+/g, " "));
    expect(payload).toContain("开头说明：先检查索引。");
    expect(payload).toContain("结尾结论：测试全部通过，要我继续部署吗？");
    expect(payload).toContain("[... input truncated ...]");
  });

  it("keeps whole tool calls from both ends and the end of each long output", async () => {
    const calls: CaptureCall[] = [];
    const { service } = createTestService({ llm: captureInputLlm(calls) });
    const session = open(service, "capture-input-tools-user");
    const toolCalls = Array.from({ length: 12 }, (_, index) => ({ name: `step_${index}`, input: { index } }));
    const toolResults = toolCalls.map((_, index) => ({
      output: `${chineseText(`输出${index}`, 900)}尾部${index}`
    }));

    service.completeTurn("turn-capture-input-tools", {
      sessionId: session.sessionId,
      query: "跑一遍迁移和测试",
      answer: "已经跑完。",
      toolCalls,
      toolResults
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    const payload = calls[0]!.payload;
    expect(payload).toContain("step_0(");
    expect(payload).toContain("step_11(");
    expect(payload).toContain("尾部11");
    expect(payload).toMatch(/\[\.\.\. \d+ tool calls omitted \.\.\.\]/);
    const omitted = Number(payload.match(/\[\.\.\. (\d+) tool calls omitted \.\.\.\]/)![1]);
    const shown = toolCalls.filter((call) => payload.includes(`${call.name}(`)).length;
    expect(shown + omitted).toBe(toolCalls.length);
  });

  it("fits the token budget by cutting the reply first and the user text last", async () => {
    const calls: CaptureCall[] = [];
    const { service } = createTestService({ llm: captureInputLlm(calls) });
    const session = open(service, "capture-input-budget-user");
    const userText = `用户开头。${chineseText("丙", 3_900)}用户结尾。`;
    const answer = `回答开头。${chineseText("丁", 3_900)}回答结尾。`;
    expect(countSummaryTokens(userText) + countSummaryTokens(answer))
      .toBeGreaterThan(summaryInputTokenBudget(MEMORY_SUMMARY_MAX_TOKENS * 2));

    service.completeTurn("turn-capture-input-budget", { sessionId: session.sessionId, query: userText, answer });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    const { messages, payload } = calls[0]!;
    const total = messages.reduce((sum, message) => sum + countSummaryTokens(message.content), 0);
    expect(total).toBeLessThanOrEqual(summaryInputTokenBudget(MEMORY_SUMMARY_MAX_TOKENS * 2));
    expect(payload).toContain("用户开头。");
    expect(payload).toContain("用户结尾。");
    expect(payload).toContain("回答开头。");
    expect(payload).toContain("回答结尾。");
    const assistantSection = payload.slice(payload.indexOf("ASSISTANT:"), payload.indexOf("EXISTING_USER_MEMORY_CANDIDATES:"));
    const userSection = payload.slice(payload.indexOf("USER:"), payload.indexOf("ASSISTANT:"));
    expect(countSummaryTokens(assistantSection)).toBeLessThan(countSummaryTokens(userSection));
  });

  it("accepts an evidence quote that spans a line break in the original text", async () => {
    const calls: CaptureCall[] = [];
    const { db, service } = createTestService({
      llm: captureInputLlm(calls, [{ quote: "第一步先备份数据库 第二步再执行迁移", role: "user", kind: "task_request" }])
    });
    const session = open(service, "capture-input-quote-user");
    const completed = service.completeTurn("turn-capture-input-quote", {
      sessionId: session.sessionId,
      query: "第一步先备份数据库\n第二步再执行迁移",
      answer: "好的，按这个顺序做。"
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    const row = db.db.prepare(`SELECT properties_json FROM memories WHERE id = ?`)
      .get(completed.l1MemoryIds[0]) as { properties_json: string };
    const decision = (JSON.parse(row.properties_json) as {
      internal_info: { capture_decision: { l1_evidence: unknown[] } };
    }).internal_info.capture_decision;
    expect(decision.l1_evidence).toEqual([
      { quote: "第一步先备份数据库 第二步再执行迁移", source_role: "user", kind: "task_request" }
    ]);
  });
});
