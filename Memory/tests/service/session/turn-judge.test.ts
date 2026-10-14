import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  type LlmClient,
  type LlmCompletionOptions,
  type LlmMessage
} from "../../../src/index.js";
import {
  createMemoryServiceFixture,
  isTurnJudgeCall,
  turnJudgeUserText
} from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

type JudgeAnswer = Record<string, unknown> | Error;

interface JudgeCall {
  messages: LlmMessage[];
  options: LlmCompletionOptions;
  user: string;
}

function turnJudgeConfig(enabled = true): typeof DEFAULT_MEMMY_CONFIG {
  return {
    ...DEFAULT_MEMMY_CONFIG,
    algorithm: {
      ...DEFAULT_MEMMY_CONFIG.algorithm,
      session: { ...DEFAULT_MEMMY_CONFIG.algorithm.session, turnJudge: enabled }
    }
  };
}

function l1For(user: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `记录 ${user.slice(0, 10)}`,
    summary: `用户要求：${user.slice(0, 40)}`,
    evidence: [{ quote: user.slice(0, 12), role: "user", kind: "task_request" }],
    unverified_answer: false,
    ...overrides
  };
}

// Answers the per-turn judgment by the USER it is asked about; anything else
// gets a minimal valid answer for its operation.
function createTurnJudgeLlm(answers: Record<string, JudgeAnswer[] | ((call: JudgeCall) => JudgeAnswer)> = {}): {
  llm: LlmClient;
  judgeCalls: JudgeCall[];
  otherCalls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }>;
} {
  const judgeCalls: JudgeCall[] = [];
  const otherCalls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
  const llm: LlmClient = {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "host", endpoint: "http://127.0.0.1/turn-judge", model: "turn-judge" },
    isConfigured: () => true,
    async complete(_messages, options) {
      return options.operation.startsWith("episode_title")
        ? JSON.stringify({ title: "测试任务标题", summary: "测试任务摘要。" })
        : "unused";
    },
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> {
      if (options.operation === "capture.summarize" && isTurnJudgeCall(messages)) {
        const user = turnJudgeUserText(messages);
        const call = { messages, options, user };
        judgeCalls.push(call);
        const scripted = Object.entries(answers).find(([prefix]) => user.startsWith(prefix))?.[1];
        const answer = typeof scripted === "function"
          ? scripted(call)
          : scripted?.length ? scripted.shift()! : undefined;
        if (answer instanceof Error) throw answer;
        const taskEmpty = messages.at(-1)!.content.includes("<first_user_message></first_user_message>");
        return (answer ?? {
          relation: taskEmpty ? null : "follow_up",
          feedback: taskEmpty ? null : "neutral",
          reason: "default",
          l1: l1For(user),
          user: null
        }) as T;
      }
      otherCalls.push({ messages, options });
      if (options.operation === "capture.summarize") {
        return { l1: { title: "旧版标题", summary: "旧版概要", evidence: [] }, user: null } as unknown as T;
      }
      if (options.operation.startsWith("capture.reflection.batch")) return { scores: [] } as unknown as T;
      return { summary: "", reflection: "", alpha: 0.5, usable: false, tags: [] } as unknown as T;
    },
    status: () => ({ provider: "host", model: "turn-judge", configured: true, remote: true })
  };
  return { llm, judgeCalls, otherCalls };
}

function openSession(service: ReturnType<typeof createTestService>["service"], userId: string) {
  return service.openSession({ namespace: { source: "codex", profileId: "default", userId } });
}

function rawTurnPayload(db: ReturnType<typeof createTestService>["db"], rawTurnId: string): Record<string, any> {
  const row = db.db.prepare("SELECT message_payload_json FROM raw_turns WHERE id = ?").get(rawTurnId) as { message_payload_json: string };
  return JSON.parse(row.message_payload_json) as Record<string, any>;
}

function memoryProperties(db: ReturnType<typeof createTestService>["db"], memoryId: string): Record<string, any> {
  const row = db.db.prepare("SELECT info_json, properties_json FROM memories WHERE id = ?").get(memoryId) as {
    info_json: string;
    properties_json: string;
  };
  return { info: JSON.parse(row.info_json), ...JSON.parse(row.properties_json) } as Record<string, any>;
}

function captureJob(db: ReturnType<typeof createTestService>["db"], memoryId: string): Record<string, unknown> {
  const row = db.db.prepare(
    "SELECT payload_json FROM evolution_jobs WHERE job_type = 'trace_summary' AND target_memory_id = ? ORDER BY created_at LIMIT 1"
  ).get(memoryId) as { payload_json: string };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

describe("turn.judge.v1 capture (switch on)", () => {
  it("keeps the capture-only decision while the switch is off", async () => {
    const { llm, judgeCalls, otherCalls } = createTurnJudgeLlm();
    const { service, db } = createTestService({ llm, config: turnJudgeConfig(false) });
    const session = openSession(service, "turn-judge-off");
    const turn = service.completeTurn("t1", { sessionId: session.sessionId, query: "帮我写一个部署脚本", answer: "好的，脚本如下。" });
    await service.runWorkerOnce(20);

    expect(judgeCalls).toHaveLength(0);
    expect(otherCalls.some((call) => call.options.operation === "capture.summarize")).toBe(true);
    expect(captureJob(db, turn.l1MemoryId).turnJudge).toBeUndefined();
    expect(rawTurnPayload(db, turn.rawTurnId).turn_judge).toBeUndefined();
  });

  it("judges the first turn with TASK SO FAR empty and records the prompt version", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm();
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "turn-judge-first");
    const turn = service.completeTurn("t1", { sessionId: session.sessionId, query: "帮我写一个部署脚本", answer: "好的，脚本如下。" });
    expect(captureJob(db, turn.l1MemoryId)).toMatchObject({ turnJudge: true, promptVersion: "turn.judge.v1", decideCapture: true });

    await service.runWorkerOnce(20);

    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]!.options).toMatchObject({ maxTokens: 1024, inputTokenBudget: 12_800, thinkingMode: "disabled" });
    expect(judgeCalls[0]!.messages.at(-1)!.content).toContain("<first_user_message></first_user_message>");
    const payload = rawTurnPayload(db, turn.rawTurnId);
    expect(payload.turn_judge).toMatchObject({ prompt_version: "turn.judge.v1", status: "judged", relation: null, feedback: null });
    expect(payload.turn_judge.input).toMatchObject({ taskEmpty: true, filedByRule: "first_turn" });
    const decision = memoryProperties(db, turn.l1MemoryId).internal_info.capture_decision;
    expect(decision).toMatchObject({
      status: "accepted",
      prompt_version: "turn.judge.v1",
      unverified_answer: false,
      turn_judge: { relation: null, feedback: null }
    });
  });

  it("builds TASK SO FAR only from turns before this one", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm({
      "第一轮": [{ relation: null, feedback: null, reason: "r", l1: l1For("第一轮：写部署脚本", { title: "部署脚本初稿" }), user: null }]
    });
    const { service } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "turn-judge-cutoff");
    service.completeTurn("t1", { sessionId: session.sessionId, query: "第一轮：写部署脚本", answer: "第一轮回答：脚本在此。" });
    await service.runWorkerOnce(20);
    service.completeTurn("t2", { sessionId: session.sessionId, query: "第二轮：加上回滚", answer: "第二轮回答。" });
    service.completeTurn("t3", { sessionId: session.sessionId, query: "第三轮：再加日志", answer: "第三轮回答。" });
    await service.runWorkerOnce(20);

    const second = judgeCalls.find((call) => call.user.startsWith("第二轮"))!.messages.at(-1)!.content;
    expect(second).toContain("<first_user_message>第一轮：写部署脚本</first_user_message>");
    expect(second).toContain("<recent_user_messages>\n</recent_user_messages>");
    expect(second).toContain("- 部署脚本初稿");
    expect(second).toContain("<previous_assistant_reply>第一轮回答：脚本在此。</previous_assistant_reply>");
    expect(second).not.toContain("第三轮");
    const third = judgeCalls.find((call) => call.user.startsWith("第三轮"))!.messages.at(-1)!.content;
    expect(third).toContain("<user_message>第二轮：加上回滚</user_message>");
    expect(third).toContain("<previous_assistant_reply>第二轮回答。</previous_assistant_reply>");
  });

  it("sends USER from the stored turn in full, not the 4000-character trace copy", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm();
    const { service } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "turn-judge-long-user");
    const query = `长消息开头${"内容".repeat(2_500)}结尾才是要求：只改第三段`;
    service.completeTurn("t1", { sessionId: session.sessionId, query, answer: "已改。" });
    await service.runWorkerOnce(20);

    expect(judgeCalls[0]!.user).toBe(query);
  });

  it("reuses the stored input when the answer is rejected and the job retries", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm({
      "帮我": [
        { relation: null, feedback: null, reason: "r", l1: { title: "t", summary: "s", evidence: [] }, user: null },
        { relation: null, feedback: null, reason: "r", l1: l1For("帮我写一个部署脚本"), user: null }
      ]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "turn-judge-retry");
    const turn = service.completeTurn("t1", { sessionId: session.sessionId, query: "帮我写一个部署脚本", answer: "好的。" });
    await service.runWorkerOnce(20);
    service.completeTurn("t2", { sessionId: session.sessionId, query: "另一轮", answer: "好的。" });
    await service.runWorkerOnce(20);

    const firstTurnCalls = judgeCalls.filter((call) => call.user.startsWith("帮我"));
    expect(firstTurnCalls).toHaveLength(2);
    expect(firstTurnCalls[1]!.messages).toEqual(firstTurnCalls[0]!.messages);
    expect(memoryProperties(db, turn.l1MemoryId).internal_info.capture_decision).toMatchObject({
      status: "accepted",
      unverified_answer: false
    });
  });

  it("marks an L1 unverified only when the model says so and the turn has no tool result", async () => {
    const unverified = (user: string) => ({
      relation: null,
      feedback: null,
      reason: "r",
      l1: l1For(user, { unverified_answer: true }),
      user: null
    });
    const { llm } = createTurnJudgeLlm({
      "火星": [unverified("火星的基本数据写一段")],
      "读一下": [unverified("读一下配置文件")],
      "为什么": [{ relation: null, feedback: null, reason: "r", l1: l1For("为什么登录测试失败？"), user: null }]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const general = service.completeTurn("t1", {
      sessionId: openSession(service, "turn-judge-unverified-1").sessionId,
      query: "火星的基本数据写一段",
      answer: "火星直径约 6779 公里。"
    });
    const withTool = service.completeTurn("t1", {
      sessionId: openSession(service, "turn-judge-unverified-2").sessionId,
      query: "读一下配置文件",
      answer: "配置里端口是 443。",
      toolCalls: [{ id: "call-1", name: "read_file", input: { path: "config.yaml" } }],
      toolResults: [{ toolCallId: "call-1", output: "port: 443", success: true }]
    });
    const question = service.completeTurn("t1", {
      sessionId: openSession(service, "turn-judge-unverified-3").sessionId,
      query: "为什么登录测试失败？",
      answer: "因为 token 字段为空。"
    });
    await service.runWorkerOnce(30);

    const generalMemory = memoryProperties(db, general.l1MemoryId);
    expect(generalMemory.info).toMatchObject({ evidence_status: "provisional", policy_eligible: false });
    expect(generalMemory.internal_info.claims).toEqual([expect.objectContaining({ source_role: "agent", evidence_status: "provisional" })]);
    expect(generalMemory.internal_info.capture_decision.unverified_answer).toBe(true);

    const toolMemory = memoryProperties(db, withTool.l1MemoryId);
    expect(toolMemory.info.evidence_status).toBe("verified");
    expect(toolMemory.internal_info.capture_decision.unverified_answer).toBe(true);

    // A question no longer becomes provisional by keyword.
    const questionMemory = memoryProperties(db, question.l1MemoryId);
    expect(questionMemory.info.evidence_status).toBeUndefined();
    expect(questionMemory.internal_info.capture_decision.original_evidence_status).toBeUndefined();
  });

  it("no longer forces L1 for an ordinary tool result", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm({
      "看看": [{ relation: null, feedback: null, reason: "r", l1: null, user: null }]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "turn-judge-tool");
    const turn = service.completeTurn("t1", {
      sessionId: session.sessionId,
      query: "看看当前目录",
      answer: "目录里有三个文件。",
      toolCalls: [{ name: "list_dir", input: { path: "." }, output: "a b c", success: true }]
    });
    await service.runWorkerOnce(20);

    expect(judgeCalls[0]!.messages.filter((message) => message.role === "system")).toHaveLength(2);
    const decision = memoryProperties(db, turn.l1MemoryId).internal_info.capture_decision;
    expect(decision).toMatchObject({ status: "rejected", create_l1: false });
  });

  it("still forces L1 for a device memory observation and retries an answer without one", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm({
      "我的电脑": [
        { relation: null, feedback: null, reason: "r", l1: null, user: null },
        { relation: null, feedback: null, reason: "r", l1: l1For("我的电脑内存多大？"), user: null }
      ]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "turn-judge-device-memory");
    const turn = service.completeTurn("t1", {
      sessionId: session.sessionId,
      query: "我的电脑内存多大？",
      answer: "你的电脑内存是 32GB。",
      toolCalls: [{ id: "call-1", name: "system_info", input: {} }],
      toolResults: [{ toolCallId: "call-1", output: "MemTotal: 32GB", success: true }]
    });
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);

    expect(judgeCalls).toHaveLength(2);
    expect(judgeCalls[0]!.messages.filter((message) => message.role === "system")).toHaveLength(3);
    expect(memoryProperties(db, turn.l1MemoryId).internal_info.capture_decision.status).toBe("accepted");
  });

  it("stores quotes aligned to the text the model saw and records what it dropped", async () => {
    const { llm } = createTurnJudgeLlm({
      "以后": [{
        relation: null,
        feedback: null,
        reason: "r",
        l1: l1For("以后每次提交前先跑测试", {
          evidence: [
            { quote: "以后每次提交前…先跑测试", role: "user", kind: "user_directive" },
            { quote: "原文里没有", role: "user", kind: "decision" }
          ]
        }),
        user: { action: "create", evidence: [{ quote: "每次提交前 先跑测试", type: "User Preference" }], target: "", replacement: "" }
      }]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "turn-judge-quotes");
    const turn = service.completeTurn("t1", { sessionId: session.sessionId, query: "以后每次提交前先跑测试", answer: "好的，记住了。" });
    await service.runWorkerOnce(20);

    const decision = memoryProperties(db, turn.l1MemoryId).internal_info.capture_decision;
    expect(decision.l1_evidence).toEqual([{ quote: "以后每次提交前先跑测试", source_role: "user", kind: "user_directive" }]);
    expect(decision.user_memory_evidence).toEqual([{ quote: "每次提交前先跑测试", type: "User Preference" }]);
    expect(decision.turn_judge.dropped_quotes).toEqual({ l1: 1, user: 0 });
    expect(decision.policy_eligible).toBe(true);
  });
});
