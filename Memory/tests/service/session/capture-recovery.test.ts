import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../../../src/server/http.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { createTurnJudgeLlm, turnJudgeConfig } from "./turn-judge-llm.js";
const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

describe("durable capture before Episode selection", () => {
  it.each([true, false])("keeps original content across model failure and restart (turnJudge=%s)", async enabled => {
    const { llm } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    llm.completeJson = async () => { throw new Error("model quota exhausted"); };
    const config = turnJudgeConfig(enabled);
    const { service, db } = fixture.createTestService({ llm, config });
    const session = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "owner" } });
    const request = { sessionId: session.sessionId, query: "Keep this original request", answer: "Keep this original answer" };
    await expect(service.completeTurn("original", request)).rejects.toThrow("quota");
    const repo = new Repositories(db.db);
    const job = repo.runtime.listJobs().find(j => j.jobType === "capture_replay")!;
    expect(job.payload.command).toMatchObject({ operation: "completeTurn", args: ["original", request] });
    expect(repo.runtime.listEpisodesForSession(session.sessionId)).toHaveLength(0);
    // No caller re-submits the lost request. A new service only has the database.
    llm.completeJson = complete;
    const reopened = new MemoryDb({ path: db.path });
    const restored = fixture.createTestMemoryService({ db: reopened, llm, config });
    for (let i = 0; i < 5; i++) await restored.runWorkerOnce(30);
    const row = reopened.db.prepare("SELECT user_text, assistant_text FROM raw_turns WHERE session_id = ? AND turn_id = ?").get(session.sessionId, "original");
    expect(row).toMatchObject({ user_text: request.query, assistant_text: request.answer });
    const before = reopened.db.prepare("SELECT count(*) AS n FROM raw_turns").get();
    await restored.completeTurn("original", request);
    expect(reopened.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual(before);
    expect(repo.runtime.getJob(job.id)?.status).toBe("succeeded");
  });

  it.each(["hook", "agent_source_scan"] as const)("recovers a %s source capture once without a caller retry", async channel => {
    const { llm } = createTurnJudgeLlm(); const complete = llm.completeJson;
    llm.completeJson = async () => { throw new Error("network unavailable"); };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const request = { source: "codex", channel, sourceTurn: { source: "codex", profileId: "default",
      conversationId: "native", turnId: "native-turn", startedAt: "2099-01-01T00:00:00Z", completedAt: "2099-01-01T00:01:00Z", completionEvidence: "task_complete" },
      query: "Preserve source input", answer: "Preserve source output" };
    await expect(service.completeSourceTurn(request)).rejects.toThrow("network");
    llm.completeJson = complete;
    for (let i = 0; i < 4; i++) await service.runWorkerOnce(30);
    expect(db.db.prepare("SELECT count(*) AS n FROM source_turn_captures").get()).toEqual({ n: 1 });
    expect((await service.completeSourceTurn(request)).status).toBe("existing");
  });

  it.each(["observe", "compact", "subagentStart", "subagentComplete"])("recovers %s through the same selection journal", async kind => {
    const { llm } = createTurnJudgeLlm(); const complete = llm.completeJson;
    llm.completeJson = async () => { throw new Error("offline"); };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "owner" } });
    const operation = () => kind === "observe" ? service.observeTool({ sessionId, turnId: "observed", toolName: "read", toolCallId: "call", args: { path: "file" }, result: "Original tool output" })
      : kind === "compact" ? service.compactSession(sessionId, { summary: "Original compaction summary", createL1: true })
      : kind === "subagentStart" ? service.subagentStart({ sessionId, subagentId: "child", task: "Original child task" })
      : service.subagentComplete({ sessionId, subagentId: "child", summary: "Original child result", status: "succeeded" });
    await expect(operation()).rejects.toThrow("offline");
    llm.completeJson = complete;
    for (let i = 0; i < 4; i++) await service.runWorkerOnce(30);
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT status FROM evolution_jobs WHERE job_type = 'capture_replay'").get()).toEqual({ status: "succeeded" });
  });

  it("journals before awaiting the model and rejects concurrent duplicate capture", async () => {
    const { llm } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    llm.completeJson = async (messages, options) => {
      entered();
      await blocked;
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    const request = { sessionId, query: "Durable before the network responds", answer: "Original output" };
    const pending = service.completeTurn("in-flight", request);
    await started;
    const repos = new Repositories(db.db);
    expect(repos.runtime.listJobs().filter(job => job.jobType === "capture_replay")).toHaveLength(1);
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 0 });
    service.reconcileWorkerStartup();
    expect(repos.runtime.listJobs().find(job => job.jobType === "capture_replay")?.status).toBe("leased");
    await expect(service.completeTurn("in-flight", request)).rejects.toThrow("already pending");
    release();
    await pending;
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
    const job = repos.runtime.listJobs().find(job => job.jobType === "capture_replay")!;
    expect(job.payload).toEqual({ operation: "completeTurn", captured: true });
  });

  it("recovers an interrupted lease after restart and rejects the stale model result", async () => {
    const { llm } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    llm.completeJson = async (messages, options) => { entered(); await blocked; return complete(messages, options); };
    const config = turnJudgeConfig();
    const { service, db } = fixture.createTestService({ llm, config });
    const { sessionId } = service.openSession({});
    const pending = service.completeTurn("interrupted", { sessionId, query: "Save before crash", answer: "Saved output" });
    const rejected = expect(pending).rejects.toThrow("lease changed");
    await started;
    const reopened = new MemoryDb({ path: db.path });
    const restored = fixture.createTestMemoryService({ db: reopened, llm: createTurnJudgeLlm().llm, config });
    restored.reconcileWorkerStartup();
    for (let i = 0; i < 4; i++) await restored.runWorkerOnce(30);
    release();
    await rejected;
    expect(reopened.db.prepare("SELECT count(*) AS n FROM raw_turns WHERE turn_id='interrupted'").get()).toEqual({ n: 1 });
    expect(reopened.db.prepare("SELECT status FROM evolution_jobs WHERE job_type='capture_replay'").get()).toEqual({ status: "succeeded" });
  });

  it("stores captures offline under the default config without a summary model", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm();
    llm.isConfigured = () => false;
    const { service, db } = fixture.createTestService({ llm, config: DEFAULT_MEMMY_CONFIG });
    const { sessionId } = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "offline" } });
    await service.completeTurn("offline", { sessionId, query: "Retain the original", answer: "Retain the answer" });
    const source = await service.completeSourceTurn({ source: "codex", channel: "hook", sourceTurn: { source: "codex", profileId: "default",
      conversationId: "offline-native", turnId: "native-turn", startedAt: "2099-01-01T00:00:00Z", completedAt: "2099-01-01T00:01:00Z",
      completionEvidence: "task_complete" }, query: "Retain source input", answer: "Retain source output" });
    expect(source.status).toBe("stored");
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 2 });
    expect(db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE job_type='capture_replay'").get()).toEqual({ n: 0 });
    for (let i = 0; i < 4; i++) await service.runWorkerOnce(30);
    expect(judgeCalls).toHaveLength(0);
  });

  it("holds a saved capture while the model is unconfigured without exhausting retries", async () => {
    const { llm } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    llm.completeJson = async () => { throw new Error("model removed"); };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    await expect(service.completeTurn("unconfigured", { sessionId, query: "Retain the original", answer: "Retain the answer" }))
      .rejects.toThrow("model removed");
    llm.isConfigured = () => false;
    llm.completeJson = complete;
    for (let i = 0; i < 4; i++) await service.runWorkerOnce(30);
    expect(db.db.prepare("SELECT status,attempts FROM evolution_jobs WHERE job_type='capture_replay'").get()).toEqual({ status: "queued", attempts: 0 });
    llm.isConfigured = () => true;
    for (let i = 0; i < 4; i++) await service.runWorkerOnce(30);
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
  });

  it("keeps a replayed source turn as detached history when a later turn was stored first", async () => {
    const { llm } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    let fail = true;
    llm.completeJson = async (messages, options) => {
      if (fail) throw new Error("quota exhausted");
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const turn = (turnId: string, minute: number) => ({ source: "codex", channel: "hook" as const,
      sourceTurn: { source: "codex", profileId: "default", conversationId: "native", turnId, sequence: minute,
        startedAt: `2099-01-01T00:0${minute}:00Z`, completedAt: `2099-01-01T00:0${minute}:30Z`, completionEvidence: "task_complete" },
      query: `Original input ${turnId}`, answer: `Original output ${turnId}` });
    await expect(service.completeSourceTurn(turn("turn-1", 1))).rejects.toThrow("quota");
    fail = false;
    expect((await service.completeSourceTurn(turn("turn-2", 2))).status).toBe("stored");
    for (let i = 0; i < 6; i++) await service.runWorkerOnce(30);
    expect(db.db.prepare("SELECT user_text FROM raw_turns WHERE turn_id = 'turn-1'").get())
      .toEqual({ user_text: "Original input turn-1" });
    expect(db.db.prepare("SELECT count(*) AS n FROM source_turn_captures").get()).toEqual({ n: 2 });
    expect((await service.completeSourceTurn(turn("turn-1", 1))).status).toBe("existing");
  });

  it("automatically retries after an HTTP capture fails, without another client request", async () => {
    const { llm } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    let attempts = 0;
    llm.completeJson = async (messages, options) => {
      if (++attempts === 1) throw new Error("temporary model outage");
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    const server = createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000,
      startAgentSourceAutomation: false, auth: { mode: "dev", allowAnonymous: true } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/turns/http-failure/complete`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, query: "Original HTTP request", answer: "Original HTTP answer" })
      });
      expect(response.status).toBe(500);
      await vi.waitFor(() => expect(db.db.prepare("SELECT user_text FROM raw_turns WHERE turn_id = 'http-failure'").get())
        .toEqual({ user_text: "Original HTTP request" }));
    } finally { await closeMemoryHttpServer(server); }
  });

  it("enables judgment by default and actually sends a judgment request", async () => {
    expect(DEFAULT_MEMMY_CONFIG.algorithm.session.turnJudge).toBe(true);
    const { llm, judgeCalls } = createTurnJudgeLlm();
    const { service } = fixture.createTestService({ llm, config: DEFAULT_MEMMY_CONFIG });
    const { sessionId } = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "default-on" } });
    await service.completeTurn("default", { sessionId, query: "Implement a durable queue", answer: "Implemented it" });
    for (let i = 0; i < 3; i++) await service.runWorkerOnce(30);
    expect(judgeCalls).toHaveLength(1);
  });
});
