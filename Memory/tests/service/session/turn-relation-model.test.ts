import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/index.js";
import { L3WorldModelRepository, Repositories } from "../../../src/storage/repositories.js";
import { MEMORY_BYOK_BUDGET_KV_KEY } from "../../../src/service/memory-token-budget-ledger.js";
import { localCalendarDate } from "@memmy/agent-source-core";
import {
  byokRuntimeConfig,
  createBatchReflectionLlm,
  createMemoryServiceFixture,
  setRawTurnActivityAt
} from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

type RelationAnswer = Record<string, unknown> | (() => Promise<Record<string, unknown>>);

/** Answers relation.classify.v2 from a queue (the last answer repeats); everything else goes to the batch fake. */
function relationLlm(answers: RelationAnswer[], calls: string[] = []): LlmClient {
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

function judged(relation: string, feedbackType = "none"): Record<string, unknown> {
  return {
    relation,
    confidence: 0.9,
    reason: `judged ${relation}`,
    feedback: { type: feedbackType, confidence: 0.8, reason: `reaction ${feedbackType}` }
  };
}

function routeProposalOf(db: ReturnType<typeof createTestService>["db"], rawTurnId: string): Record<string, any> {
  return JSON.parse((db.db.prepare(`SELECT message_payload_json FROM raw_turns WHERE id = ?`)
    .get(rawTurnId) as { message_payload_json: string }).message_payload_json).turn_start.routeProposal;
}

function relationJob(db: ReturnType<typeof createTestService>["db"]): {
  id: string;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
} {
  const row = db.db.prepare(
    `SELECT id, status, attempts, payload_json FROM evolution_jobs WHERE job_type = 'turn_relation'`
  ).get() as { id: string; status: string; attempts: number; payload_json: string };
  return { ...row, payload: JSON.parse(row.payload_json) as Record<string, unknown> };
}

function makeRunnable(db: ReturnType<typeof createTestService>["db"], jobId: string): void {
  db.db.prepare(`UPDATE evolution_jobs SET payload_json = json_remove(payload_json, '$.runAfter') WHERE id = ?`).run(jobId);
}

function open(service: ReturnType<typeof createTestService>["service"], userId: string) {
  return service.openSession({ namespace: { source: "codex", profileId: "default", userId } });
}

describe("turn relation judged by the model", () => {
  it("joins the open episode and holds the judgment job while no model is configured", async () => {
    const { db, service } = createTestService();
    const session = open(service, "relation-no-model-user");
    const first = service.completeTurn("turn-no-model-first", { sessionId: session.sessionId, query: "Plan a Kyoto trip", answer: "Day 1: temples." });
    const started = await service.startTurn({ turnId: "turn-no-model-next", sessionId: session.sessionId, query: "new task: write a cover letter" });
    expect(started.status).toContain("relation:pending:proposed");

    const next = service.completeTurn("turn-no-model-next", { sessionId: session.sessionId, query: "new task: write a cover letter", answer: "Dear hiring manager..." });
    expect(next.episodeId).toBe(first.episodeId);
    expect(routeProposalOf(db, next.rawTurnId).relationDecision).toEqual({
      relation: "unknown", confidence: 0, reason: "model pending", signals: ["model_pending"]
    });

    await service.runWorkerOnce(20);
    expect(relationJob(db)).toMatchObject({ status: "queued", attempts: 0 });
    db.close();
  });

  it("does not start the turn-start call while the memory budget is paused", async () => {
    const calls: string[] = [];
    const { db, service } = createTestService({
      llm: relationLlm([judged("new_task")], calls),
      config: byokRuntimeConfig({ tokenBudget: { dailyLimitM: 1, totalLimitM: 500 } })
    });
    const session = open(service, "relation-budget-user");
    service.completeTurn("turn-budget-first", { sessionId: session.sessionId, query: "Plan a Kyoto trip", answer: "Day 1: temples." });
    new Repositories(db.db).runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    const started = await service.startTurn({ turnId: "turn-budget-next", sessionId: session.sessionId, query: "Write a cover letter" });
    expect(started.status).toContain("relation:pending:proposed");
    expect(calls).toEqual([]);
    db.close();
  });

  it("judges a turn without an opening in the background from the input before the turn", async () => {
    const calls: string[] = [];
    const { db, service } = createTestService({ llm: relationLlm([judged("follow_up", "positive")], calls) });
    const session = open(service, "relation-job-user");
    const first = service.completeTurn("turn-job-first", { sessionId: session.sessionId, query: "Plan a Kyoto trip", answer: "Day 1: temples." });
    const next = service.completeTurn("turn-job-next", { sessionId: session.sessionId, query: "再加一天去奈良", answer: "Day 4: Nara." });
    expect(next.episodeId).toBe(first.episodeId);
    expect(calls).toEqual([]);

    await service.runWorkerOnce(20);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("<first_user_message>Plan a Kyoto trip</first_user_message>");
    expect(calls[0]).toContain("<previous_assistant_reply>Day 1: temples.</previous_assistant_reply>");
    expect(calls[0]).toContain("<new_user_message>再加一天去奈良</new_user_message>");
    expect(calls[0]).not.toContain("Day 4: Nara.");
    expect(routeProposalOf(db, next.rawTurnId)).toMatchObject({
      relationDecision: { relation: "follow_up", signals: ["llm", "relation.classify.v2", "late_result"] },
      feedback: { type: "positive" }
    });
    expect(relationJob(db).status).toBe("succeeded");
    db.close();
  });

  it("stops after five invalid outputs, marks model_failed, and writes back after a manual retry", async () => {
    const answers: RelationAnswer[] = Array.from({ length: 5 }, () => ({ relation: "switch", confidence: 0.9, reason: "", feedback: {} }));
    answers.push(judged("new_task"));
    const { db, service } = createTestService({ llm: relationLlm(answers) });
    const session = open(service, "relation-invalid-user");
    service.completeTurn("turn-invalid-first", { sessionId: session.sessionId, query: "Plan a Kyoto trip", answer: "Day 1: temples." });
    const next = service.completeTurn("turn-invalid-next", { sessionId: session.sessionId, query: "Write a cover letter", answer: "Dear hiring manager..." });

    for (let round = 0; round < 5; round += 1) {
      const job = relationJob(db);
      makeRunnable(db, job.id);
      await service.runWorkerOnce(20);
    }
    const dead = relationJob(db);
    expect(dead.status).toBe("dead_letter");
    expect(dead.payload.invalidOutputCount).toBe(5);
    expect(routeProposalOf(db, next.rawTurnId).relationDecision).toEqual({
      relation: "unknown", confidence: 0, reason: "model failed", signals: ["model_failed"]
    });

    expect(service.retryModelJudgmentJob(dead.id)).toMatchObject({ accepted: true });
    await service.runWorkerOnce(20);
    expect(routeProposalOf(db, next.rawTurnId).relationDecision).toMatchObject({
      relation: "new_task",
      signals: ["llm", "relation.classify.v2", "late_result", "route_mismatch"]
    });
    db.close();
  });

  it("backs off a failed call instead of falling back to a rule", async () => {
    const { db, service } = createTestService({
      llm: relationLlm([async () => { throw new Error("network timeout"); }])
    });
    const session = open(service, "relation-network-user");
    service.completeTurn("turn-network-first", { sessionId: session.sessionId, query: "Plan a Kyoto trip", answer: "Day 1: temples." });
    const next = service.completeTurn("turn-network-next", { sessionId: session.sessionId, query: "不对，重做", answer: "Redone." });
    await service.runWorkerOnce(20);
    const job = relationJob(db);
    expect(job.status).toBe("failed");
    expect(Date.parse(String(job.payload.runAfter))).toBeGreaterThan(Date.now() + 50_000);
    expect(routeProposalOf(db, next.rawTurnId).relationDecision.signals).toEqual(["model_pending"]);
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM feedback`).get()).toEqual({ count: 0 });
    db.close();
  });

  it("defers the job while the turn-start call is still in flight instead of calling twice", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const { db, service } = createTestService({
      llm: relationLlm([async () => {
        await gate;
        return judged("follow_up");
      }], calls)
    });
    const session = open(service, "relation-in-flight-user");
    service.completeTurn("turn-in-flight-first", { sessionId: session.sessionId, query: "Plan a Kyoto trip", answer: "Day 1: temples." });
    await service.startTurn({ turnId: "turn-in-flight-next", sessionId: session.sessionId, query: "再加一天去奈良" });
    const next = service.completeTurn("turn-in-flight-next", { sessionId: session.sessionId, query: "再加一天去奈良", answer: "Day 4: Nara." });
    const job = relationJob(db);
    makeRunnable(db, job.id);

    await service.runWorkerOnce(20);
    const deferred = relationJob(db);
    expect(deferred).toMatchObject({ status: "queued", attempts: 0 });
    expect(Date.parse(String(deferred.payload.runAfter))).toBeGreaterThan(Date.now() + 50_000);
    expect(calls).toHaveLength(1);

    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(routeProposalOf(db, next.rawTurnId).relationDecision.signals).toEqual(["llm", "relation.classify.v2", "late_result"]);
    makeRunnable(db, job.id);
    await service.runWorkerOnce(20);
    expect(calls).toHaveLength(1);
    expect(relationJob(db).status).toBe("succeeded");
    db.close();
  });

  it("routes a completed subagent into the dispatching task without a model call or feedback", async () => {
    const calls: string[] = [];
    const { db, service } = createTestService({ llm: relationLlm([judged("new_task")], calls) });
    const session = open(service, "relation-subagent-user");
    const first = service.completeTurn("turn-subagent-first", { sessionId: session.sessionId, query: "Refactor the parser", answer: "Dispatched a subagent." });
    const result = service.subagentComplete({ sessionId: session.sessionId, subagentId: "parser-worker", result: "Parser refactored." });
    expect(result.episodeId).toBe(first.episodeId);
    expect(calls).toEqual([]);
    expect(routeProposalOf(db, result.rawTurnId).relationDecision).toEqual({
      relation: "follow_up", confidence: 1, reason: "subagent completion", signals: ["subagent_complete"]
    });
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type = 'turn_relation'`).get()).toEqual({ count: 0 });
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM feedback`).get()).toEqual({ count: 0 });
    db.close();
  });

  it("does not split an open episode by time, and does not reopen a closed one past the window even for a revision", async () => {
    const { db, service } = createTestService({ llm: relationLlm([judged("follow_up"), judged("revision", "negative")]) });
    const session = open(service, "relation-window-user");
    const first = service.completeTurn("turn-window-first", { sessionId: session.sessionId, query: "Draft the report", answer: "Draft ready." });
    setRawTurnActivityAt(db, first.rawTurnId, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    await service.startTurn({ turnId: "turn-window-later", sessionId: session.sessionId, query: "核心结果部分多写一点" });
    const later = service.completeTurn("turn-window-later", { sessionId: session.sessionId, query: "核心结果部分多写一点", answer: "Expanded." });
    expect(later.episodeId).toBe(first.episodeId);
    expect(later.closedEpisodeIds).toEqual([]);

    const repos = new Repositories(db.db);
    repos.runtime.closeEpisode(first.episodeId, { closeReason: "idle_timeout" });
    setRawTurnActivityAt(db, later.rawTurnId, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    await service.startTurn({ turnId: "turn-window-revision", sessionId: session.sessionId, query: "还是不行，你再看看" });
    const revision = service.completeTurn("turn-window-revision", { sessionId: session.sessionId, query: "还是不行，你再看看", answer: "Rechecked." });
    expect(revision.episodeId).not.toBe(first.episodeId);
    expect(repos.runtime.getEpisode(first.episodeId)?.status).toBe("closed");
    db.close();
  });

  it("freezes L3 batches of the previous turn's episode when the user returns after the idle timeout", async () => {
    const freeze = vi.spyOn(L3WorldModelRepository.prototype, "freezeBatches")
      .mockImplementation(() => ({}) as ReturnType<L3WorldModelRepository["freezeBatches"]>);
    const { db, service } = createTestService({ llm: relationLlm([judged("follow_up")]) });
    const session = open(service, "relation-l3-user");
    db.db.prepare(`UPDATE sessions SET meta_json = json_set(meta_json, '$.l3_world_model_protocol_version', 2) WHERE id = ?`)
      .run(session.sessionId);
    const first = service.completeTurn("turn-l3-first", { sessionId: session.sessionId, query: "Draft the report", answer: "Draft ready." });
    setRawTurnActivityAt(db, first.rawTurnId, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    await service.startTurn({ turnId: "turn-l3-later", sessionId: session.sessionId, query: "核心结果部分多写一点" });
    service.completeTurn("turn-l3-later", { sessionId: session.sessionId, query: "核心结果部分多写一点", answer: "Expanded." });
    expect(freeze).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.sessionId,
      trigger: "episode_idle_close",
      episodeId: first.episodeId
    }));

    freeze.mockClear();
    await service.startTurn({ turnId: "turn-l3-soon", sessionId: session.sessionId, query: "标题短一点" });
    service.completeTurn("turn-l3-soon", { sessionId: session.sessionId, query: "标题短一点", answer: "Shorter." });
    expect(freeze).not.toHaveBeenCalled();
    db.close();
  });

  describe("when the judgment arrives after the turn completed", () => {
    function feedbackRows(db: ReturnType<typeof createTestService>["db"]) {
      return db.db.prepare(
        `SELECT channel, polarity, magnitude, l1_memory_id, rationale, raw_payload_json FROM feedback ORDER BY created_at`
      ).all() as Array<{ channel: string; polarity: string; magnitude: number; l1_memory_id: string; rationale: string; raw_payload_json: string }>;
    }

    async function lateJudgment(answer: Record<string, unknown>, setup?: (
      db: ReturnType<typeof createTestService>["db"],
      first: { episodeId: string; rawTurnId: string; l1MemoryId: string }
    ) => void) {
      const { db, service } = createTestService({ llm: relationLlm([answer]) });
      const session = open(service, `late-${String(answer.relation)}-user`);
      const first = service.completeTurn("turn-late-effects-first", { sessionId: session.sessionId, query: "Configure nginx TLS", answer: "Use port 80." });
      setup?.(db, first);
      const next = service.completeTurn("turn-late-effects-next", { sessionId: session.sessionId, query: "还是不行", answer: "Rechecked the port." });
      return { db, service, session, first, next };
    }

    it("adds revision feedback on the L1 saved at completion, not the turn's own", async () => {
      const { db, service, first, next } = await lateJudgment(judged("revision", "negative"));
      expect(feedbackRows(db)).toEqual([]);
      await service.runWorkerOnce(20);
      const rows = feedbackRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: "explicit", polarity: "negative", magnitude: 1, l1_memory_id: first.l1MemoryId });
      expect(next.episodeId).toBe(first.episodeId);
      db.close();
    });

    it("adds implicit feedback for a new_task without moving the turn", async () => {
      const { db, service, first, next } = await lateJudgment(judged("new_task", "improvement"));
      await service.runWorkerOnce(20);
      const rows = feedbackRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: "implicit", polarity: "negative", magnitude: 0.6, l1_memory_id: first.l1MemoryId, rationale: "还是不行" });
      expect(JSON.parse(rows[0]!.raw_payload_json)).toMatchObject({ method: "llm", reason: "reaction improvement" });
      expect((db.db.prepare(`SELECT episode_id FROM raw_turns WHERE id = ?`).get(next.rawTurnId) as { episode_id: string }).episode_id)
        .toBe(first.episodeId);
      expect(routeProposalOf(db, next.rawTurnId).relationDecision.signals).toContain("route_mismatch");
      db.close();
    });

    it("closes the episode for a late end_topic and keeps that turn out of L1", async () => {
      const { db, service, first, next } = await lateJudgment(judged("end_topic", "positive"));
      await service.runWorkerOnce(20);
      expect(new Repositories(db.db).runtime.getEpisode(first.episodeId)).toMatchObject({
        status: "closed",
        meta: { closeReason: "end_topic", endTopicTurnId: "turn-late-effects-next" }
      });
      const ownL1 = db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(next.l1MemoryId) as { status: string };
      expect(ownL1.status).toBe("deleted");
      expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(first.l1MemoryId)).not.toEqual({ status: "deleted" });
      expect(routeProposalOf(db, next.rawTurnId).relationDecision.signals).not.toContain("route_mismatch");
      db.close();
    });

    it("does not close for a late end_topic when the user has already gone on", async () => {
      const { db, service, session, first, next } = await lateJudgment(judged("end_topic"));
      service.completeTurn("turn-late-effects-after", { sessionId: session.sessionId, query: "Also enable HSTS", answer: "Enabled." });
      const turnRelationJobs = db.db.prepare(`SELECT id FROM evolution_jobs WHERE job_type = 'turn_relation' ORDER BY created_at`).all() as Array<{ id: string }>;
      db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE id = ?`).run(turnRelationJobs[1]!.id);
      await service.runWorkerOnce(20);
      expect(new Repositories(db.db).runtime.getEpisode(first.episodeId)?.status).toBe("open");
      expect((db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(next.l1MemoryId) as { status: string }).status).toBe("deleted");
      db.close();
    });

    it("only records the judgment once the turn's episode has closed", async () => {
      const { db, service, first, next } = await lateJudgment(judged("revision", "negative"));
      new Repositories(db.db).runtime.closeEpisode(first.episodeId, { closeReason: "idle_timeout" });
      await service.runWorkerOnce(20);
      expect(routeProposalOf(db, next.rawTurnId).relationDecision).toMatchObject({ relation: "revision", signals: expect.arrayContaining(["late_result"]) });
      expect(feedbackRows(db)).toEqual([]);
      db.close();
    });

    it("reroutes a turn that started a new episode: revision within the window gets revision feedback", async () => {
      const { db, service, first, next } = await lateJudgment(judged("revision", "negative"), (database, firstTurn) => {
        new Repositories(database.db).runtime.closeEpisode(firstTurn.episodeId, { closeReason: "idle_timeout" });
      });
      expect(next.episodeId).not.toBe(first.episodeId);
      await service.runWorkerOnce(20);
      const rows = feedbackRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: "explicit", l1_memory_id: first.l1MemoryId });
      expect(routeProposalOf(db, next.rawTurnId).relationDecision.signals).toContain("route_mismatch");
      db.close();
    });

    it("reroutes a turn that started a new episode: follow_up adds no feedback", async () => {
      const { db, service, next } = await lateJudgment(judged("follow_up", "positive"), (database, firstTurn) => {
        new Repositories(database.db).runtime.closeEpisode(firstTurn.episodeId, { closeReason: "idle_timeout" });
        setRawTurnActivityAt(database, firstTurn.rawTurnId, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
      });
      await service.runWorkerOnce(20);
      expect(feedbackRows(db)).toEqual([]);
      expect(routeProposalOf(db, next.rawTurnId).relationDecision.signals).not.toContain("route_mismatch");
      db.close();
    });
  });
});
