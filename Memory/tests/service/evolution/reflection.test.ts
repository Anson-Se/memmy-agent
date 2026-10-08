import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryService,
  type LlmClient,
  type LlmCompletionOptions,
  type LlmMessage
} from "../../../src/index.js";
import {
  createBatchReflectionLlm,
  createMemoryServiceFixture,
  runWorkerRounds
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot
} = createMemoryServiceFixture();

afterEach(cleanup);

async function closeSessionAndRunWorkerRounds(
  service: MemoryService,
  sessionId: string,
  rounds = 2,
  limit = 100
): Promise<void> {
  service.closeSession(sessionId);
  await runWorkerRounds(service, rounds, limit);
}

function createUnusableReflectionLlm(): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/unusable-reflection",
      model: "unusable-reflection"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "unused";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      if (options.operation === "capture.reflection.batch.v14") {
        const payload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as {
          steps?: Array<{ idx: number }>;
        };
        return {
          scores: (payload.steps ?? []).map((step) => ({
            idx: step.idx,
            relevance: "IRRELEVANT",
            reason: "batch marked irrelevant"
          }))
        } as unknown as T;
      }
      if (options.operation === "capture.summarize") {
        const payload = messages.find((message) => message.role === "user")?.content ?? "";
        const userQuote = payload.match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "";
        return {
          l1: {
            title: "Unusable reflection",
            summary: "unusable reflection summary",
            evidence: [{ quote: userQuote, role: "user", kind: "task_outcome" }]
          },
          user: null
        } as unknown as T;
      }
      return {
        summary: "unusable reflection summary",
        reflection: "tautological reflection",
        alpha: 0.95,
        usable: false,
        tags: []
      } as unknown as T;
    },
    status() {
      return {
        provider: "host",
        model: "unusable-reflection",
        configured: true,
        remote: true
      };
    }
  };
}

function createCapturingReflectionLlm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: { operation: string };
}>): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/reflection-capturing",
      model: "reflection-capturing"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "unused";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      calls.push({ messages, options });
      if (options.operation === "capture.summarize") {
        const payload = messages.find((message) => message.role === "user")?.content ?? "";
        const userQuote = payload.match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "";
        return {
          l1: {
            title: "Sqlite migration reflection",
            summary: "sqlite migration reflection summary",
            evidence: [{ quote: userQuote, role: "user", kind: "task_outcome" }]
          },
          user: null
        } as unknown as T;
      }
      return {
        summary: "sqlite migration reflection summary",
        reflection: "I inspected the sqlite migration output before retrying.",
        alpha: 0.82,
        usable: true,
        tags: ["sqlite", "migration"]
      } as unknown as T;
    },
    status() {
      return {
        provider: "host",
        model: "reflection-capturing",
        configured: true,
        remote: true
      };
    }
  };
}

function createSocialAwareReflectionLlm(
  calls: Array<{
    messages: Array<{ role: string; content: string }>;
    options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
  }>,
  socialStates: string[],
  failReflection = false
): LlmClient {
  const base = createBatchReflectionLlm(calls);
  return {
    ...base,
    async completeJson<T extends Record<string, unknown>>(
      messages: LlmMessage[],
      options: LlmCompletionOptions
    ): Promise<T> {
      if (options.operation !== "capture.reflection.batch.v14") {
        return base.completeJson<T>(messages, options);
      }
      calls.push({ messages, options });
      if (failReflection) {
        throw new Error("reflection model unavailable");
      }
      const payload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as {
        steps?: Array<{ idx: number; state?: string }>;
      };
      return {
        scores: (payload.steps ?? []).map((step) => socialStates.includes(step.state ?? "")
          ? { idx: step.idx, relevance: "IRRELEVANT", reason: "model social" }
          : { idx: step.idx, relevance: "RELATED", reason: "model related" })
      } as unknown as T;
    }
  };
}

describe("MemoryService / evolution / reflection", () => {
  it("sets alpha to zero when batch reflection marks a trace irrelevant", async () => {
    const root = createTestRoot("mindock-memory-reflection-alpha-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createUnusableReflectionLlm()
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-alpha-user"
      }
    });
    const complete = service.completeTurn("turn-reflection-alpha", {
      sessionId: session.sessionId,
      query: "record an unusable reflection scorer result",
      answer: "done"
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "accepted"
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          alpha: number;
          usable: boolean;
          reflection: string;
        };
      };
    };
    expect(properties.internal_info.trace.usable).toBe(false);
    expect(properties.internal_info.trace.alpha).toBe(0);
    expect(properties.internal_info.trace.reflection).toBe("IRRELEVANT");
    db.close();
  });

  it("keeps the model result when it marks a durable-memory-looking trace irrelevant", async () => {
    const root = createTestRoot("mindock-memory-reflection-durable-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createUnusableReflectionLlm()
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-durable-user"
      }
    });
    const complete = service.completeTurn("turn-reflection-durable", {
      sessionId: session.sessionId,
      query: "Record that the deployment verification command runs through zsh.",
      answer: "The deployment verification command runs through zsh."
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "accepted"
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          alpha: number;
          usable: boolean;
          reflection: string;
          reflection_reason?: string;
        };
      };
    };
    expect(properties.internal_info.trace.usable).toBe(false);
    expect(properties.internal_info.trace.alpha).toBe(0);
    expect(properties.internal_info.trace.reflection).toBe("IRRELEVANT");
    expect(properties.internal_info.trace.reflection_reason).toBe("batch marked irrelevant");
    db.close();
  });

  it("scores extracted inline reflections instead of keeping the fallback alpha", async () => {
    const root = createTestRoot("mindock-memory-inline-reflection-alpha-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createUnusableReflectionLlm()
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "inline-reflection-alpha-user"
      }
    });
    const complete = service.completeTurn("turn-inline-reflection-alpha", {
      sessionId: session.sessionId,
      query: "record an inline reflection scorer result",
      answer: [
        "I completed the small task.",
        "### Reasoning:",
        "I did it because I did it, which is tautological and not useful."
      ].join("\n")
    });

    const before = service.getMemory(complete.l1MemoryId);
    const beforeTrace = (before.metadata.properties as {
      internal_info: { trace: { alpha: number; reflection_source: string } };
    }).internal_info.trace;
    expect(beforeTrace.alpha).toBe(0);
    expect(beforeTrace.reflection_source).toBe("none");

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const after = service.getMemory(complete.l1MemoryId);
    const afterTrace = (after.metadata.properties as {
      internal_info: {
        trace: {
          alpha: number;
          usable: boolean;
          reflection: string;
          reflection_scored_at?: string;
        };
      };
    }).internal_info.trace;
    expect(afterTrace.usable).toBe(false);
    expect(afterTrace.alpha).toBe(0);
    expect(afterTrace.reflection).toBe("IRRELEVANT");
    expect(afterTrace.reflection_scored_at).toBeTruthy();
    db.close();
  });

  it("sends short social-only steps to the reflection model", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const root = createTestRoot("mindock-memory-reflection-social-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createSocialAwareReflectionLlm(calls, ["谢谢，辛苦了"])
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-social-user"
      }
    });
    const complete = service.completeTurn("turn-reflection-social", {
      sessionId: session.sessionId,
      query: "谢谢，辛苦了",
      answer: "不客气。"
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "accepted"
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const trace = (JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          alpha: number;
          usable: boolean;
          reflection_reason?: string;
        };
      };
    }).internal_info.trace;
    const reflectionCalls = calls.filter((call) => call.options.operation === "capture.reflection.batch.v14");
    expect(reflectionCalls).toHaveLength(1);
    const payload = JSON.parse(
      reflectionCalls[0]!.messages.find((message) => message.role === "user")?.content ?? "{}"
    ) as { steps: Array<{ idx: number; state: string }> };
    expect(payload.steps).toEqual([expect.objectContaining({ idx: 0, state: "谢谢，辛苦了" })]);
    expect(trace.alpha).toBe(0);
    expect(trace.usable).toBe(false);
    expect(trace.reflection_reason).toBe("model social");
    db.close();
  });

  it("does not classify a sentence containing hi as social when it exceeds six words", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const root = createTestRoot("mindock-memory-reflection-long-hi-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(calls)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-long-hi-user"
      }
    });
    const complete = service.completeTurn("turn-reflection-long-hi", {
      sessionId: session.sessionId,
      query: "Hi I walked through the park all afternoon",
      answer: "That sounds like a long walk."
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const row = db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const trace = (JSON.parse(row.properties_json) as {
      internal_info: { trace: { reflection: string; reflection_reason?: string; alpha: number } };
    }).internal_info.trace;
    expect(calls.some((call) => call.options.operation === "capture.reflection.batch.v14")).toBe(true);
    expect(trace.reflection).toBe("PIVOTAL");
    expect(trace.reflection_reason).toBe("batch scored");
    expect(trace.alpha).toBe(1);
    db.close();
  });

  it("keeps short social steps in a mixed batch and lets the model score every step", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const root = createTestRoot("mindock-memory-reflection-mixed-social-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createSocialAwareReflectionLlm(calls, ["Hi, thanks"])
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-mixed-social-user"
      }
    });
    const social = service.completeTurn("turn-reflection-mixed-social", {
      sessionId: session.sessionId,
      query: "Hi, thanks",
      answer: "You're welcome."
    });
    const knowledge = service.completeTurn("turn-reflection-mixed-knowledge", {
      sessionId: session.sessionId,
      episodeId: social.episodeId,
      query: "为什么黑美人西瓜不常见？",
      answer: "主要受市场偏好、运输和品种迭代影响。"
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const reflectionCalls = calls.filter((call) =>
      call.options.operation === "capture.reflection.batch.v14"
    );
    expect(reflectionCalls).toHaveLength(1);
    const summaryCalls = calls.filter((call) => call.options.operation === "capture.summarize");
    expect(summaryCalls).toHaveLength(2);
    expect(summaryCalls.map((call) => call.messages.find((message) => message.role === "user")?.content))
      .toEqual(expect.arrayContaining([
        expect.stringContaining("USER: Hi, thanks"),
        expect.stringContaining("USER: 为什么黑美人西瓜不常见？")
      ]));
    expect(summaryCalls.every((call) => !call.messages.find((message) => message.role === "user")?.content.includes("REFLECTION:"))).toBe(true);
    expect(calls.some((call) => call.options.operation === "capture.reflected_trace_summary.v1")).toBe(false);
    const payload = JSON.parse(
      reflectionCalls[0]!.messages.find((message) => message.role === "user")?.content ?? "{}"
    ) as { steps: Array<{ idx: number; state: string }> };
    expect(payload.steps).toEqual([
      expect.objectContaining({ idx: 0, state: "Hi, thanks" }),
      expect.objectContaining({ idx: 1, state: "为什么黑美人西瓜不常见？" })
    ]);
    const socialTrace = (JSON.parse((db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(social.l1MemoryId) as { properties_json: string }).properties_json) as {
      internal_info: { trace: { reflection: string; reflection_reason?: string } };
    }).internal_info.trace;
    const knowledgeTrace = (JSON.parse((db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(knowledge.l1MemoryId) as { properties_json: string }).properties_json) as {
      internal_info: { trace: { reflection: string; reflection_reason?: string } };
    }).internal_info.trace;
    expect(socialTrace).toMatchObject({
      reflection: "IRRELEVANT",
      reflection_reason: "model social"
    });
    expect(knowledgeTrace).toMatchObject({
      reflection: "RELATED",
      reflection_reason: "model related"
    });
    db.close();
  });

  it("marks social steps with SOCIAL_FALLBACK when every reflection window fails", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const root = createTestRoot("mindock-memory-reflection-social-fallback-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createSocialAwareReflectionLlm(calls, [], true)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-social-fallback-user"
      }
    });
    const social = service.completeTurn("turn-reflection-fallback-social", {
      sessionId: session.sessionId,
      query: "Hi, thanks",
      answer: "You're welcome."
    });
    const knowledge = service.completeTurn("turn-reflection-fallback-knowledge", {
      sessionId: session.sessionId,
      episodeId: social.episodeId,
      query: "为什么黑美人西瓜不常见？",
      answer: "主要受市场偏好、运输和品种迭代影响。"
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    expect(calls.some((call) => call.options.operation === "capture.reflection.batch.v14")).toBe(true);
    const traceOf = (memoryId: string | undefined) => (JSON.parse((db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(memoryId) as { properties_json: string }).properties_json) as {
      internal_info: { trace: { reflection: string; reflection_reason?: string; alpha: number } };
    }).internal_info.trace;
    expect(traceOf(social.l1MemoryId)).toMatchObject({
      reflection: "IRRELEVANT",
      reflection_reason: "SOCIAL_FALLBACK",
      alpha: 0
    });
    expect(traceOf(knowledge.l1MemoryId)).toMatchObject({
      reflection: "RELATED_DEFAULT",
      reflection_reason: "FALLBACK_RELATED_DEFAULT",
      alpha: 0.5
    });
    db.close();
  });

  it("does not treat this in agent thinking as an English hi greeting", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const root = createTestRoot("mindock-memory-reflection-this-regression-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(calls)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-this-regression-user"
      }
    });
    const complete = service.completeTurn("turn-reflection-this-regression", {
      sessionId: session.sessionId,
      query: "黑美人都是黑籽的吗？但是好像不怎么买得到",
      answer: "黑美人通常是有籽二倍体品种，市场份额受无籽西瓜和新品种挤压。",
      reasoningSummary: "Let me think about this specific watermelon variety before answering."
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const row = db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const trace = (JSON.parse(row.properties_json) as {
      internal_info: { trace: { reflection: string; reflection_reason?: string; alpha: number } };
    }).internal_info.trace;
    expect(trace.reflection).toBe("PIVOTAL");
    expect(trace.reflection_reason).toBe("batch scored");
    expect(trace.alpha).toBe(1);
    db.close();
  });

  it("uses the evolution LLM with thinking disabled for batch reflection", async () => {
    const summaryCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const evolutionCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const root = createTestRoot("mindock-memory-reflection-evolution-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(summaryCalls, "summary result", "summary-model"),
      skillLlm: createBatchReflectionLlm(evolutionCalls, "unused evolution summary", "evolution-model")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-evolution-user"
      }
    });

    service.completeTurn("turn-reflection-evolution", {
      sessionId: session.sessionId,
      query: "分析旅行规划任务中的自然景观筛选流程",
      answer: "先按季节和交通条件筛选自然景观，再核验开放状态。"
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const reflectionCall = evolutionCalls.find((call) =>
      call.options.operation === "capture.reflection.batch.v14"
    );
    expect(reflectionCall?.options.thinkingMode).toBe("disabled");
    expect(summaryCalls.some((call) => call.options.operation === "capture.reflection.batch.v14")).toBe(false);
    const summaryCall = summaryCalls.find((call) => call.options.operation === "capture.summarize");
    expect(summaryCall).toBeTruthy();
    expect(summaryCall!.messages[0]?.content).toContain("Judge L1 and User Memory");
    expect(summaryCall!.messages[1]?.content).not.toContain("REFLECTION:");
    expect(summaryCalls.some((call) => call.options.operation === "capture.reflected_trace_summary.v1")).toBe(false);
    const payload = JSON.parse(
      reflectionCall?.messages.find((message) => message.role === "user")?.content ?? "{}"
    ) as { host_context?: { reflectionModel?: string } };
    expect(payload.host_context?.reflectionModel).toBe("evolution-model");
    db.close();
  });

  it("uses the plugin windowed batch reflection prompt contract in the worker", async () => {
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const root = createTestRoot("mindock-memory-reflection-prompt-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(calls),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            batchMode: "windowed"
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-prompt-user"
      }
    });

    service.completeTurn("turn-reflection-prompt", {
      sessionId: session.sessionId,
      query: "debug a failing sqlite migration command",
      answer: [
        "I inspected the migration failure and kept the retry focused.",
        "### Reasoning:",
        "I chose to read the sqlite migration output before retrying because the error was specific."
      ].join("\n"),
      toolCalls: [{
        name: "shell",
        input: "npm run migrate",
        output: "error: missing sqlite migration 003",
        success: false
      }]
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const reflectionCall = calls.find((call) =>
      call.options.operation === "capture.reflection.batch.v14"
    );
    expect(reflectionCall).toBeTruthy();
    expect(reflectionCall!.messages[0]?.content).toContain("reviewing a WINDOW of one AI agent episode");
    expect(reflectionCall!.messages[0]?.content).toContain("Each step is stored as an L1 trace, Memmy's evidence layer.");
    expect(reflectionCall!.messages[0]?.content).toContain("Scoring rubric (choose one label for each step):");
    expect(reflectionCall!.messages[0]?.content).toContain("label it at least RELATED (never\nIRRELEVANT;");
    expect(reflectionCall!.messages[0]?.content).toContain("a reasonable attempt that fails is exploration and stays\n  RELATED");
    expect(reflectionCall!.messages[0]?.content).not.toContain("apply in order");
    const payload = JSON.parse(reflectionCall!.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      steps: Array<{ idx: number; action: string; tool_calls: Array<{ input: string; output: string }> }>;
      task_context?: string | null;
    };
    expect(payload.task_context).toContain("sqlite migration");
    expect(payload.steps).toHaveLength(1);
    expect(payload.steps[0]!.tool_calls).toMatchObject([{
      name: "shell",
      input: "npm run migrate",
      output: "error: missing sqlite migration 003"
    }]);
    expect(JSON.stringify(payload)).toContain("npm run migrate");
    expect(payload.steps[0]!.action).toContain("inspected the migration failure");
    expect(calls.some((call) => call.options.operation === "capture.alpha.reflection.score.v3")).toBe(false);
    db.close();
  });

  it("keeps neutral alpha when plugin alpha scoring is disabled", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const root = createTestRoot("mindock-memory-alpha-disabled-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createCapturingReflectionLlm(calls),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            alphaScoring: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "alpha-disabled-user"
      }
    });
    const complete = service.completeTurn("turn-alpha-disabled", {
      sessionId: session.sessionId,
      query: "record neutral alpha behavior",
      answer: [
        "Done.",
        "### Reasoning:",
        "I used the local migration output to avoid a broad retry."
      ].join("\n")
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    expect(calls.some((call) => call.options.operation === "capture.alpha.reflection.score.v3")).toBe(false);
    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          alpha: number;
          usable: boolean;
          reflection_scored_at?: string;
        };
      };
    };
    expect(properties.internal_info.trace.alpha).toBe(0.5);
    expect(properties.internal_info.trace.usable).toBe(true);
    expect(properties.internal_info.trace.reflection_scored_at).toBeTruthy();
    db.close();
  });

  it("uses windowed batch reflection instead of long per-step downstream fallback", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const root = createTestRoot("mindock-memory-downstream-preview-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(calls),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            batchMode: "windowed",
            batchThreshold: 1,
            reflectionContextMode: "task_downstream",
            longEpisodeReflectMode: "per_step_downstream",
            downstreamStepCount: 2
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "downstream-preview-user"
      }
    });
    const complete = service.completeTurn("turn-downstream-preview", {
      sessionId: session.sessionId,
      query: "debug migration and then run focused test",
      answer: "I reran the focused check after inspecting the migration output.",
      toolCalls: [
        {
          name: "shell",
          input: "npm run migrate",
          output: "error: missing sqlite migration 003",
          success: false
        },
        {
          name: "shell",
          input: "npm test -- memory-service",
          output: "1 test passed",
          success: true
        }
      ]
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryIds[0]!,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "accepted"
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const batchCall = calls.find((call) => call.options.operation === "capture.reflection.batch.v14");
    expect(batchCall).toBeTruthy();
    expect(calls.some((call) => call.options.operation === "capture.alpha.reflection.score.v3")).toBe(false);
    const payload = JSON.parse(batchCall!.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      steps: Array<{ tool_calls: Array<{ input: string; output: string }> }>;
      task_context?: string | null;
    };
    expect(payload.task_context).toContain("debug migration");
    const toolCalls = payload.steps.flatMap((step) => step.tool_calls);
    expect(toolCalls).toMatchObject([
      { input: "npm run migrate", output: "error: missing sqlite migration 003" },
      { input: "npm test -- memory-service", output: "1 test passed" }
    ]);
    db.close();
  });

  it("uses the plugin batched reflection prompt contract for short episodes", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const root = createTestRoot("mindock-memory-reflection-batch-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(calls)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "reflection-batch-user"
      }
    });

    const complete = service.completeTurn("turn-reflection-batch", {
      sessionId: session.sessionId,
      query: "debug the sqlite migration and then run the focused test",
      answer: "I found the missing migration and reran the targeted check.",
      toolCalls: [
        {
          name: "shell",
          input: "npm run migrate",
          output: "error: missing sqlite migration 003",
          success: false
        },
        {
          name: "shell",
          input: "npm test -- memory-service",
          output: "1 test passed",
          success: true
        }
      ]
    });
    expect(complete.l1MemoryIds).toHaveLength(1);
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryIds[0]!,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "accepted"
    });

    await closeSessionAndRunWorkerRounds(service, session.sessionId);

    const batchCall = calls.find((call) =>
      call.options.operation === "capture.reflection.batch.v14"
    );
    expect(batchCall).toBeTruthy();
    expect(batchCall!.messages[0]?.content).toContain("reviewing a WINDOW of one AI agent episode");
    const payload = JSON.parse(batchCall!.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      steps: Array<{ idx: number; tool_calls: unknown[]; synth_allowed: boolean }>;
      task_context?: string | null;
    };
    expect(payload.steps).toHaveLength(1);
    expect(payload.steps.every((step, index) => step.idx === index)).toBe(true);
    expect(payload.steps[0]?.tool_calls).toHaveLength(2);
    expect(payload.steps.every((step) => step.synth_allowed)).toBe(true);
    expect(payload.task_context).toContain("sqlite migration");
    const summaryCall = calls.find((call) => call.options.operation === "capture.summarize");
    expect(summaryCall).toBeTruthy();
    expect(summaryCall!.messages[0]?.content).toContain("Judge L1 and User Memory");
    const summaryPayload = summaryCall!.messages.find((message) => message.role === "user")?.content ?? "";
    expect(summaryPayload).not.toContain("REFLECTION:");
    expect(summaryPayload).toContain("TOOLS:");
    expect(calls.some((call) => call.options.operation === "capture.reflected_trace_summary.v1")).toBe(false);

    const rows = complete.l1MemoryIds.map((id) => db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(id) as { properties_json: string });
    for (const row of rows) {
      const properties = JSON.parse(row.properties_json) as {
        internal_info: {
          trace: {
            alpha: number;
            usable: boolean;
            reflection: string;
            reflection_source: string;
            reflection_scored_at?: string;
            summary: string;
            summary_deferred_until_reflection?: boolean;
          };
        };
      };
      expect(properties.internal_info.trace.reflection).toBe("PIVOTAL");
      expect(properties.internal_info.trace.alpha).toBeCloseTo(1);
      expect(properties.internal_info.trace.summary).toBe("LLM batch summary");
      expect(properties.internal_info.trace.summary_deferred_until_reflection).toBeUndefined();
      expect(properties.internal_info.trace.usable).toBe(true);
      expect(properties.internal_info.trace.reflection_source).toBe("synth");
      expect(properties.internal_info.trace.reflection_scored_at).toBeTruthy();
    }
    expect(service.panelItems({ userId: "reflection-batch-user", layer: "L1" }).items.some((item) =>
      item.metrics?.alpha === 1 && item.metrics.reflectionDone
    )).toBe(true);
    const queuedEmbedding = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'embedding'
         AND payload_json LIKE '%reflection.updated%'`
    ).get() as { count: number };
    expect(queuedEmbedding.count).toBe(complete.l1MemoryIds.length);
    db.close();
  });
});
