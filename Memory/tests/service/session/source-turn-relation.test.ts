import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/index.js";
import type { SourceTurnCompleteRequest } from "../../../src/types.js";
import { createBatchReflectionLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

type Answer = Record<string, unknown> | (() => Promise<Record<string, unknown>>);

function relationLlm(answers: Answer[], calls: string[]): LlmClient {
  const base = createBatchReflectionLlm([]);
  let index = 0;
  return {
    ...base,
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" }
    ): Promise<T> {
      if (options.operation !== "relation.classify.v2") return base.completeJson<T>(messages, options);
      calls.push(messages.find((message) => message.role === "user")?.content ?? "");
      const answer = answers[Math.min(index++, answers.length - 1)]!;
      return (typeof answer === "function" ? await answer() : answer) as T;
    }
  };
}

function judged(relation: string): Record<string, unknown> {
  return { relation, confidence: 0.9, reason: `judged ${relation}`, feedback: { type: "none", confidence: 0.9, reason: "none" } };
}

function turn(turnId: string, minute: number, query: string, overrides: Partial<SourceTurnCompleteRequest> = {}): SourceTurnCompleteRequest {
  const at = (offset: number) => new Date(Date.UTC(2099, 0, 1, 10, minute + offset)).toISOString();
  return {
    namespace: { source: "codex", profileId: "default", userId: "source-relation-user" },
    source: "codex",
    channel: "hook",
    sourceTurn: {
      source: "codex", profileId: "default", conversationId: "native-relation-conversation", turnId,
      startedAt: at(0), completedAt: at(1), sequence: minute, completionEvidence: `task_complete:${minute}`
    },
    query,
    answer: `Answer to: ${query}`,
    ...overrides
  };
}

function counts(db: ReturnType<typeof createTestService>["db"]): Record<string, number> {
  return Object.fromEntries(["sessions", "episodes", "raw_turns", "memories", "source_turn_captures", "evolution_jobs"].map((table) => [table,
    (db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
}

describe("source turns without a turn-start record", () => {
  it("does not call the model for the first turn of a new session and plans without writing", async () => {
    const calls: string[] = [];
    const { db, service } = createTestService({ llm: relationLlm([judged("new_task")], calls) });
    const before = counts(db);
    const first = await service.completeSourceTurnJudged(turn("turn-1", 0, "Configure nginx TLS"));
    expect(first.status).toBe("stored");
    expect(calls).toEqual([]);
    expect(counts(db).source_turn_captures).toBe(before.source_turn_captures! + 1);
    expect(counts(db).sessions).toBe(before.sessions! + 1);
  });

  it("judges the turn at the entry and routes it by that judgment", async () => {
    const calls: string[] = [];
    const { db, service } = createTestService({ llm: relationLlm([judged("new_task")], calls) });
    const first = await service.completeSourceTurnJudged(turn("turn-1", 0, "Configure nginx TLS"));
    const second = await service.completeSourceTurnJudged(turn("turn-2", 5, "Write a cover letter"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("<new_user_message>Write a cover letter</new_user_message>");
    expect(second.result!.episodeId).not.toBe(first.result!.episodeId);
    expect(second.result!.closedEpisodeIds).toEqual([first.result!.episodeId]);
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type = 'turn_relation'`).get()).toEqual({ count: 0 });
  });

  it("skips the model when the capture would return early, such as a resubmitted turn", async () => {
    const calls: string[] = [];
    const { service } = createTestService({ llm: relationLlm([judged("follow_up")], calls) });
    await service.completeSourceTurnJudged(turn("turn-1", 0, "Configure nginx TLS"));
    await service.completeSourceTurnJudged(turn("turn-2", 5, "Also enable HSTS"));
    expect(calls).toHaveLength(1);
    const again = await service.completeSourceTurnJudged(turn("turn-2", 5, "Also enable HSTS"));
    expect(again.status).toBe("existing");
    expect(calls).toHaveLength(1);
  });

  it("shares one call between repeated submissions of the same turn", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const { service } = createTestService({
      llm: relationLlm([async () => {
        await gate;
        return judged("follow_up");
      }], calls)
    });
    await service.completeSourceTurnJudged(turn("turn-1", 0, "Configure nginx TLS"));
    calls.length = 0;
    const firstSubmit = service.completeSourceTurnJudged(turn("turn-2", 5, "Also enable HSTS", { channel: "agent_source_scan" }));
    const retrySubmit = service.completeSourceTurnJudged(turn("turn-2", 5, "Also enable HSTS", { channel: "agent_source_scan" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    release?.();
    const results = await Promise.all([firstSubmit, retrySubmit]);
    expect(results.map((result) => result.status).sort()).toEqual(["existing", "stored"]);
    expect(calls).toHaveLength(1);
  });

  it("stops waiting after 15 seconds for a hook, captures the turn pending, and writes the late judgment back", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const { db, service } = createTestService({
      llm: relationLlm([async () => {
        await gate;
        return judged("new_task");
      }], calls)
    });
    const first = await service.completeSourceTurnJudged(turn("turn-1", 0, "Configure nginx TLS"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = service.completeSourceTurnJudged(turn("turn-2", 5, "Write a cover letter"));
    await vi.advanceTimersByTimeAsync(15_000);
    const second = await pending;
    vi.useRealTimers();
    expect(second.result!.episodeId).toBe(first.result!.episodeId);
    const proposal = () => JSON.parse((db.db.prepare(`SELECT message_payload_json FROM raw_turns WHERE id = ?`)
      .get(second.result!.rawTurnId) as { message_payload_json: string }).message_payload_json).turn_start.routeProposal;
    expect(proposal().relationDecision.signals).toEqual(["model_pending"]);
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type = 'turn_relation'`).get()).toEqual({ count: 1 });

    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proposal().relationDecision).toMatchObject({
      relation: "new_task",
      signals: ["llm", "relation.classify.v2", "late_result", "route_mismatch"]
    });
  });

  it("puts an out-of-order turn back only when the model keeps it in the task, judged from the turns before it", async () => {
    const calls: string[] = [];
    const { db, service } = createTestService({
      llm: relationLlm([judged("follow_up"), judged("follow_up"), judged("follow_up")], calls)
    });
    const first = await service.completeSourceTurnJudged(turn("turn-1", 0, "Configure nginx TLS"));
    await service.completeSourceTurnJudged(turn("turn-3", 20, "Now test the renewal hook"));
    calls.length = 0;
    const late = await service.completeSourceTurnJudged(turn("turn-2", 10, "Also enable HSTS"));
    expect(late.status).toBe("stored");
    expect(late.result!.episodeId).toBe(first.result!.episodeId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("<latest_user_message>Configure nginx TLS</latest_user_message>");
    expect(calls[0]).not.toContain("Now test the renewal hook");
    const proposal = JSON.parse((db.db.prepare(`SELECT message_payload_json FROM raw_turns WHERE id = ?`)
      .get(late.result!.rawTurnId) as { message_payload_json: string }).message_payload_json).turn_start.routeProposal;
    expect(proposal.relationDecision).toMatchObject({ relation: "follow_up", signals: ["llm", "relation.classify.v2"] });
  });

  it("keeps an out-of-order turn the model judges a new task out of the earlier episode", async () => {
    const calls: string[] = [];
    const { service } = createTestService({
      llm: relationLlm([judged("follow_up"), judged("new_task")], calls)
    });
    await service.completeSourceTurnJudged(turn("turn-1", 0, "Configure nginx TLS"));
    await service.completeSourceTurnJudged(turn("turn-3", 20, "Now test the renewal hook"));
    const late = await service.completeSourceTurnJudged(turn("turn-2", 10, "Write a cover letter"));
    expect(late).toMatchObject({ status: "pending", reason: "source_turn_out_of_order" });
  });
});
