import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../src/config/schema.js";
import { AgentLoop } from "../../src/core/agent-runtime/loop.js";
import { AgentHookContext } from "../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../src/core/agent-runtime/runner.js";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import { AsyncQueue } from "../../src/core/runtime-messages/queue.js";
import { Session, SessionManager } from "../../src/core/session/manager.js";
import { LLMResponse, ToolCallRequest } from "../../src/providers/base.js";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { OutputDelivery } from "../../src/core/agent-runtime/tools/output-location.js";
import { MemmyMemoryHook } from "../../src/memmy-memory/hook.js";
import { renderMemmyContextPacket } from "../../src/memmy-memory/protocol.js";
import { estimatePromptTokens } from "../../src/utils/helpers.js";
import { MemmyMemoryTool, MEMOS_MEMORY_TOOL_SPECS } from "../../src/memmy-memory/tools.js";
import { RequestContext } from "../../src/core/agent-runtime/tools/context.js";

const roots: string[] = [];
const loops: AgentLoop[] = [];
const hooks: MemmyMemoryHook[] = [];
function setup(memory = true, respond?: (args: any, call: number) => LLMResponse | Promise<LLMResponse>) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "turn-memory-replay-"));
  roots.push(workspace);
  const client = {
    openSession: vi.fn(async () => ({ sessionId: "memory-session" })),
    startTurn: vi.fn(async (turnId: string) => ({ injectedContext: `MEMORY_${turnId}`, sourceMemoryIds: [turnId] })),
    completeTurn: vi.fn(async () => ({})),
    closeSession: vi.fn(async () => ({})),
    search: vi.fn(async () => ({ injectedContext: "TOOL_SEARCH_MEMORY" })),
    getMemory: vi.fn(async () => ({ id: "trace/test", content: "TOOL_GET_MEMORY" })),
  };
  const hook = new MemmyMemoryHook(client as any);
  hooks.push(hook);
  const requests: any[][] = [];
  const provider = {
    generation: { maxTokens: 100 }, getDefaultModel: () => "test",
    estimatePromptTokens: () => [100, "test"],
    chatWithRetry: vi.fn(async (args: any) => {
      requests.push(structuredClone(args.messages));
      return respond ? respond(args, requests.length) : new LLMResponse({ content: "done" });
    }),
  };
  const loop = new AgentLoop({ workspace, provider, model: "test",
    config: new Config({ fileMemory: { enabled: false }, memmyMemory: { enabled: false },
      sessionDag: { enabled: false }, contextCompaction: { summaryMode: "text" } }),
    hooks: memory ? [hook] : [],
  });
  loops.push(loop);
  const send = (turnId: string) => loop.processMessage(new InboundMessage({
    channel: "cli", chatId: "replay", senderId: "user", content: "same question",
    metadata: { turn_id: turnId },
  }));
  return { client, hook, loop, requests, provider, send };
}

function expectActiveTurn(messages: any[], turnId: string) {
  const system = messages.filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content
      : message.content.map((block: any) => block.text ?? "").join("\n")).join("\n");
  expect([...system.matchAll(/<memmy_runtime_context active_turn_id="([^"]+)" \/>/g)]
    .map((match) => match[1])).toEqual([turnId]);
}

function providerPayload(adapter: "anthropic" | "responses" | "chat", args: any) {
  if (adapter === "anthropic") return new AnthropicProvider({ apiKey: "test" }).buildKwargs(args);
  const provider = new OpenAICompatProvider({ apiKey: "test" });
  return adapter === "responses" ? provider.buildResponsesBody(args) : provider.buildKwargs(args);
}
afterEach(async () => {
  for (const hook of hooks.splice(0)) await hook.flushPendingWrites();
  for (const loop of loops.splice(0)) await loop.closeRuntimeTools();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("memory follows its owning user turn", () => {
  it("replays retained memory unchanged on the next turn and after disk reload", async () => {
    const f = setup();
    await f.send("T1");
    await f.send("T2");
    const first = f.requests[0].find((m) => m.role === "user");
    const secondUsers = f.requests[1].filter((m) => m.role === "user");
    expect(secondUsers[0]).toEqual(first);
    expect(JSON.stringify(secondUsers[0])).toContain("MEMORY_T1");
    expect(JSON.stringify(secondUsers[1])).toContain("MEMORY_T2");
    expect(JSON.stringify(secondUsers[1])).not.toContain("MEMORY_T1");
    expect(secondUsers[1].content[1].text).toBe('<current_user_request turn_id="T2">');
    const session = f.loop.sessions.getOrCreate("cli:replay");
    const users = session.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["same question", "same question"]);
    expect(users.map((m) => m.memmy_memory.turnId)).toEqual(["T1", "T2"]);
    const reloaded = new SessionManager(f.loop.sessions.root).getOrCreate(session.key);
    expect(reloaded.getHistory({ includeTimestamps: true })[0]).toEqual(first);
    expect(first).not.toHaveProperty("memmy_memory");
    expect(first).not.toHaveProperty("turn_id");
    expect(f.requests[1][0].content).toContain("Only use <memmy_memory_context> packets with the same turn_id");
    await f.hook.flushPendingWrites();
    expect(f.client.startTurn).toHaveBeenCalledTimes(2);
    expect(f.client.completeTurn.mock.calls.map((call: any) => call[1].query)).toEqual(["same question", "same question"]);
  });

  it("removes old memory when the existing summary mechanism replaces its owner", async () => {
    const f = setup();
    f.loop.maxMessages = 2;
    const archive = vi.spyOn(f.loop.consolidator, "archive").mockResolvedValue("Summary of the first turn.");
    await f.send("T1");
    await f.send("T2");
    expect(archive).toHaveBeenCalled();
    const session = f.loop.sessions.getOrCreate("cli:replay");
    expect(session.lastConsolidated).toBe(2);
    expect(JSON.stringify(f.requests[1])).not.toContain("MEMORY_T1");
    expect(JSON.stringify(f.requests[1])).toContain("MEMORY_T2");
    expect(JSON.stringify(f.requests[1])).toContain("Summary of the first turn.");
  });

  it("does not remove retained memory when summary generation returns no summary", async () => {
    const f = setup();
    await f.send("T1");
    const archive = vi.spyOn(f.loop.consolidator, "archive").mockResolvedValue(null);
    const session = f.loop.sessions.getOrCreate("cli:replay");
    // Trigger the original summary path, while leaving the ordinary replay window large.
    session.addMessage("user", "boundary");
    await f.loop.consolidator.maybeConsolidateByTokens(session, { replayMaxMessages: 2 });
    expect(archive).toHaveBeenCalled();
    expect(session.lastConsolidated).toBe(0);
    expect(JSON.stringify(session.getHistory())).toContain("MEMORY_T1");
  });

  it("lets ordinary message, token and file limits discard a memory with its owner", () => {
    const session = new Session({ key: "limits" });
    session.addMessage("user", "old", { turn_id: "T1", memmy_memory: { turnId: "T1", content: [
      { type: "text", text: renderMemmyContextPacket("OLD_MEMORY " + "x".repeat(6000), "turn_start", "old", "T1") },
    ] } });
    session.addMessage("assistant", "old reply");
    session.addMessage("user", "new", { turn_id: "T2" });
    expect(JSON.stringify(session.getHistory())).toContain("OLD_MEMORY");
    expect(JSON.stringify(session.getHistory({ maxMessages: 1 }))).not.toContain("OLD_MEMORY");
    expect(JSON.stringify(session.getHistory({ maxTokens: 20 }))).not.toContain("OLD_MEMORY");
    const archive = vi.fn();
    session.enforceFileCap(archive, 1);
    expect(session.messages).toHaveLength(1);
    expect(archive).toHaveBeenCalledOnce();
    expect(JSON.stringify(session.messages)).not.toContain("OLD_MEMORY");
  });

  it("keeps snipHistory active and drops the old user packet as a unit", () => {
    const provider = { estimatePromptTokens: (messages: any[], tools: any[]) => [estimatePromptTokens(messages, tools), "test"] };
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: renderMemmyContextPacket("OLD_MEMORY " + "x".repeat(6000), "turn_start", "old", "T1") },
      { role: "assistant", content: "old reply" },
      { role: "user", content: renderMemmyContextPacket("NEW_MEMORY", "turn_start", "new", "T2") },
    ];
    const spec = new AgentRunSpec({ provider: provider as any, messages, contextWindowTokens: 10_000, contextBlockLimit: 500 });
    const result = new AgentRunner(provider as any).snipHistory(spec, messages);
    expect(JSON.stringify(result)).not.toContain("OLD_MEMORY");
    expect(result.at(-1)?.content).toBe(messages.at(-1)?.content);
  });

  it.each(["empty", "unavailable"])("labels the current request even when recall is %s", async (mode) => {
    const f = setup();
    await f.send("T1");
    if (mode === "empty") f.client.startTurn.mockResolvedValue({ injectedContext: "", sourceMemoryIds: [] });
    else {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      f.client.startTurn.mockRejectedValue(new Error("offline"));
    }
    await f.send("T2");
    const users = f.requests[1].filter((m) => m.role === "user");
    expect(JSON.stringify(users[0])).toContain("MEMORY_T1");
    expect(JSON.stringify(users[1])).not.toContain("MEMORY_T1");
    expect(users[1].content.some((b: any) => b.text === '<current_user_request turn_id="T2">')).toBe(true);
  });

  it("does not retag old memory during an assistant-only notification", async () => {
    const f = setup();
    const messages = [{ role: "user", content: "old" }, { role: "assistant", content: "notification" }];
    await f.hook.beforeRun(new AgentHookContext({ spec: { sessionKey: "s", turnId: "T2" }, messages }));
    expect(f.client.startTurn).toHaveBeenCalledOnce();
    expect(messages[0].content).toBe("old");
  });

  it("does not create memory snapshots when the hook is disabled", async () => {
    const f = setup(false);
    await f.send("T1");
    expect(f.loop.sessions.getOrCreate("cli:replay").messages[0]).not.toHaveProperty("memmy_memory");
    expect(f.client.startTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(f.requests)).not.toContain("memmy_runtime_context");
  });

  it("preserves the original image-placeholder persistence rule inside memory snapshots", async () => {
    const f = setup();
    const image = path.join(roots.at(-1)!, "image.png");
    fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2e0AAAAASUVORK5CYII=", "base64"));
    await f.loop.processMessage(new InboundMessage({ channel: "cli", chatId: "replay", senderId: "user",
      content: "look", media: [image], metadata: { turn_id: "T1" } }));
    const session = f.loop.sessions.getOrCreate("cli:replay");
    const stored = session.messages[0];
    expect(stored.media).toEqual([image]);
    expect(JSON.stringify(stored.memmy_memory)).toContain(image);
    expect(JSON.stringify(stored.memmy_memory)).not.toContain("data:image/");
    expect(JSON.stringify(session.getHistory())).toContain("MEMORY_T1");
  });

  it("saves a system user turn's memory through the existing saveTurn path", async () => {
    const f = setup();
    await f.loop.processSystemMessage(new InboundMessage({
      channel: "system", chatId: "cli:replay", senderId: "cron", content: "scheduled question",
    }), "cli:replay");
    const stored = f.loop.sessions.getOrCreate("cli:replay").messages.find((m) => m.role === "user")!;
    expect(stored.content).toBe("scheduled question");
    expect(stored.memmy_memory.turnId).toBe(stored.turn_id);
    const first = f.requests[0].find((m) => m.role === "user");
    await f.send("T2");
    expect(f.requests[1].filter((m) => m.role === "user")[0]).toEqual(first);
  });

  it("uses the tool caller's runtime turn ID even if a result returns after the active turn changes", async () => {
    let turnId = 'T1"<x>';
    let userText = "original question";
    let resolve!: (value: any) => void;
    const client = { search: vi.fn(() => new Promise((done) => { resolve = done; })) };
    const runtime = { currentTurnId: () => turnId, currentSessionId: () => "s", currentEpisodeId: () => null,
      currentUserText: () => userText, requestEnvelope: () => ({}) };
    const tool = new MemmyMemoryTool(MEMOS_MEMORY_TOOL_SPECS[0], client as any, runtime as any);
    tool.setContext(new RequestContext({ sessionKey: "s" }));
    const pending = tool.execute({ query: "memory", turnId: "MODEL_SUPPLIED_ID" });
    turnId = "T2";
    userText = "a different question";
    resolve({ injectedContext: "recalled memory" });
    const result = await pending;
    expect(result).toContain('turn_id="T1&quot;&lt;x&gt;"');
    expect(result).not.toContain('turn_id="T2"');
    expect(result).not.toContain('turn_id="MODEL_SUPPLIED_ID"');
    expect(result).toContain("original question");
    expect(result).not.toContain("a different question");
  });

  it("keeps the active scope through a real pending-queue follow-up and search/get calls", async () => {
    const f = setup(true, (_args, call) => call === 2 ? new LLMResponse({
      content: "checking memory",
      toolCalls: [
        new ToolCallRequest({ id: "search", name: "memmy_memory_search", arguments: { query: "details" } }),
        new ToolCallRequest({ id: "get", name: "memmy_memory_get", arguments: { id: "trace/test" } }),
      ],
    }) : new LLMResponse({ content: "done" }));
    const queue = new AsyncQueue<InboundMessage>();
    queue.put(new InboundMessage({ channel: "cli", chatId: "replay", senderId: "user",
      content: "also include the details", metadata: { turn_id: "QUEUED_MESSAGE_ID" } }));
    await f.loop.processMessageInternal(new InboundMessage({ channel: "cli", chatId: "replay",
      senderId: "user", content: "original question", metadata: { turn_id: "ACTIVE" } }),
    "cli:replay", { pendingQueue: queue });
    expect(f.requests).toHaveLength(3);
    for (const request of f.requests) expectActiveTurn(request, "ACTIVE");
    expect(JSON.stringify(f.requests[1])).toContain("also include the details");
    expect(f.client.startTurn).toHaveBeenCalledTimes(1);
    expect(f.client.search).toHaveBeenCalledOnce();
    expect(f.client.getMemory).toHaveBeenCalledOnce();
    const results = f.requests[2].filter((message) => message.role === "tool");
    expect(results).toHaveLength(2);
    for (const result of results) expect(result.content).toContain('turn_id="ACTIVE"');
    expect(results[0].content).toContain("TOOL_SEARCH_MEMORY");
    expect(results[1].content).toContain("TOOL_GET_MEMORY");
    const stored = JSON.stringify(f.loop.sessions.getOrCreate("cli:replay").messages);
    expect(stored).not.toContain("memmy_runtime_context");
  });

  it.each(["length", "empty", "delivery", "max-iterations"] as const)(
    "keeps the runtime scope and real user request during %s recovery", async (mode) => {
      const seenUserTexts: Array<string | null> = [];
      const f = setup(true, (_args, call) => {
        seenUserTexts.push(f.hook.currentUserText("recovery"));
        if (mode === "length" && call === 1) return new LLMResponse({ content: "partial", finishReason: "length" });
        if (mode === "empty" && call <= 2) return new LLMResponse({ content: "" });
        if (mode === "max-iterations" && call === 1) return new LLMResponse({ content: "working",
          toolCalls: [new ToolCallRequest({ id: "noop", name: "noop", arguments: {} })] });
        return new LLMResponse({ content: "done" });
      });
      const delivery = new OutputDelivery({}, roots.at(-1)!);
      vi.spyOn(delivery, "verify").mockResolvedValueOnce("Please verify the delivery.").mockResolvedValue(null);
      const result = await new AgentRunner(f.provider as any).run(new AgentRunSpec({
        messages: [{ role: "system", content: "system" }, { role: "user", content: "the real request" }],
        hook: f.hook, provider: f.provider as any, sessionKey: "recovery", turnId: "ACTIVE",
        tools: { getDefinitions: () => [], execute: async () => "ok" },
        maxIterations: mode === "max-iterations" ? 1 : 5,
        maxIterationsFinalPrompt: mode === "max-iterations" ? "Summarize now." : null,
        outputLocation: mode === "delivery" ? delivery : undefined,
      }));
      expect(f.requests).toHaveLength(mode === "empty" ? 3 : 2);
      for (const request of f.requests) {
        expectActiveTurn(request, "ACTIVE");
        expect(JSON.stringify(request)).toContain("MEMORY_ACTIVE");
      }
      expect(seenUserTexts.every((text) => text === "the real request")).toBe(true);
      expect(f.client.startTurn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.messages)).not.toContain("memmy_runtime_context");
      expect(result.finalContent).toBe("done");
    },
  );

  it.each(["recalled", "empty", "unavailable"] as const)(
    "declares a new turn for assistant-only background results when memory is %s", async (mode) => {
      const f = setup();
      await f.send("ACTIVE");
      const originalUser = structuredClone(f.requests[0].find((message) => message.role === "user"));
      if (mode === "empty") f.client.startTurn.mockResolvedValue({ injectedContext: "", sourceMemoryIds: [] });
      if (mode === "unavailable") {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        f.client.startTurn.mockRejectedValueOnce(new Error("offline"));
      }
      await f.loop.processSystemMessage(new InboundMessage({ channel: "system", chatId: "cli:replay",
        senderId: "subagent", content: "background result", metadata: { turn_id: "FOLLOWUP" } }), "cli:replay");
      const followup = f.requests[1];
      expectActiveTurn(followup, "FOLLOWUP");
      expect(followup.find((message) => message.role === "user")).toEqual(originalUser);
      expect(f.client.startTurn.mock.calls[1][0]).toBe("FOLLOWUP");
      expect(JSON.stringify(followup)).not.toContain('<current_user_request turn_id=\\"FOLLOWUP\\">');
      if (mode === "recalled") {
        expect(followup.at(-1).content).toContain('source="turn_start" turn_id="FOLLOWUP"');
        expect(followup.at(-1).content).toContain("MEMORY_FOLLOWUP");
      } else if (mode === "unavailable") {
        expect(followup.at(-1).content).toContain('status="unavailable" turn_id="FOLLOWUP"');
      }
      const stored = JSON.stringify(f.loop.sessions.getOrCreate("cli:replay").messages);
      expect(stored).not.toContain("memmy_runtime_context");
      expect(stored).not.toContain("MEMORY_FOLLOWUP");
      await f.send("NEXT");
      expectActiveTurn(f.requests[2], "NEXT");
      expect(JSON.stringify(f.requests[2])).not.toContain("MEMORY_FOLLOWUP");
    },
  );

  it("keeps a turn-local declaration on streaming requests", async () => {
    const f = setup();
    vi.spyOn(f.hook, "wantsStreaming").mockReturnValue(true);
    const streamed: any[][] = [];
    const provider = { ...f.provider, chatStreamWithRetry: vi.fn(async (args: any) => {
      streamed.push(structuredClone(args.messages));
      return new LLMResponse({ content: "done" });
    }) };
    await new AgentRunner(provider as any).run(new AgentRunSpec({ messages: [{ role: "user", content: "question" }],
      hook: f.hook, sessionKey: "stream", turnId: "STREAM", provider: provider as any }));
    expect(streamed).toHaveLength(1);
    expectActiveTurn(streamed[0], "STREAM");
    expect(f.provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it.each(["anthropic", "responses", "chat"] as const)(
    "preserves the active scope in the final %s payload with multiple system messages", async (adapter) => {
      const payloads: any[] = [];
      const f = setup(true, (args) => {
        payloads.push(providerPayload(adapter, args));
        return new LLMResponse({ content: "done" });
      });
      await new AgentRunner(f.provider as any).run(new AgentRunSpec({
        messages: [{ role: "system", content: "base instructions" },
          { role: "system", content: "additional instructions" }, { role: "user", content: "question" }],
        hook: f.hook, provider: f.provider as any, sessionKey: "wire", turnId: "WIRE",
      }));
      expect(payloads).toHaveLength(1);
      expectActiveTurn(f.requests[0], "WIRE");
      expect(JSON.stringify(payloads[0])).toContain('active_turn_id=\\"WIRE\\"');
      expect(JSON.stringify(payloads[0])).toContain("additional instructions");
    },
  );

  it.each(["anthropic", "responses", "chat"] as const)(
    "preserves block system prompts and the active scope in the final %s payload", async (adapter) => {
      const payloads: any[] = [];
      const f = setup(true, (args) => {
        payloads.push(providerPayload(adapter, args));
        return new LLMResponse({ content: "done" });
      });
      const system = { role: "system", content: [{ type: "text", text: "block instructions" }] };
      const original = structuredClone(system);
      await new AgentRunner(f.provider as any).run(new AgentRunSpec({
        messages: [system, { role: "user", content: "question" }],
        hook: f.hook, provider: f.provider as any, sessionKey: "blocks", turnId: "BLOCKS",
      }));
      expect(JSON.stringify(payloads[0])).toContain('active_turn_id=\\"BLOCKS\\"');
      expect(JSON.stringify(payloads[0])).toContain("block instructions");
      expect(system).toEqual(original);
    },
  );

  it.each(["anthropic", "responses", "chat"] as const)(
    "keeps an image follow-up alongside background recall in the final %s payload", async (adapter) => {
      const payloads: any[] = [];
      const f = setup(true, (args) => {
        payloads.push(providerPayload(adapter, args));
        return new LLMResponse({ content: "done" });
      });
      const followup = { role: "user", content: [
        { type: "text", text: "Use this new screenshot instead" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ] };
      const original = structuredClone(followup);
      const result = await new AgentRunner(f.provider as any).run(new AgentRunSpec({
        messages: [{ role: "system", content: "system" }, { role: "user", content: "original task" },
          { role: "assistant", content: "background notification" }],
        hook: f.hook, provider: f.provider as any, model: "gpt-4o", sessionKey: "image-followup", turnId: "BACKGROUND",
        injectionCallback: vi.fn().mockResolvedValueOnce([followup]).mockResolvedValue([]),
      }));
      expect(payloads).toHaveLength(2);
      const second = JSON.stringify(payloads[1]);
      expect(second).toContain("MEMORY_BACKGROUND");
      expect(second).toContain("Use this new screenshot instead");
      expect(second).toContain("aW1hZ2U=");
      expect(followup).toEqual(original);
      expect(JSON.stringify(result.messages)).not.toContain("MEMORY_BACKGROUND");
    },
  );

  it("accounts for request-only scope and background memory when trimming history", async () => {
    const f = setup();
    const estimates: any[][] = [];
    const provider = { ...f.provider, estimatePromptTokens: (messages: any[]) => {
      estimates.push(structuredClone(messages));
      return [estimatePromptTokens(messages), "test"];
    } };
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "old context ".repeat(2000) }, { role: "assistant", content: "old response" },
      { role: "user", content: "real task" }, { role: "assistant", content: "background result" },
    ];
    const original = structuredClone(messages);
    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({ messages,
      hook: f.hook, provider: provider as any, sessionKey: "budget", turnId: "BUDGET",
      contextWindowTokens: 10_000, maxTokens: 100, contextBlockLimit: 700 }));
    expect(result.stopReason).toBe("completed");
    expect(f.requests).toHaveLength(1);
    expectActiveTurn(f.requests[0], "BUDGET");
    expect(JSON.stringify(f.requests[0])).toContain("MEMORY_BUDGET");
    expect(JSON.stringify(f.requests[0])).not.toContain("old context");
    expect(estimatePromptTokens(f.requests[0])).toBeLessThanOrEqual(700);
    expect(estimates.some((request) => JSON.stringify(request).includes("memmy_runtime_context"))).toBe(true);
    expect(messages).toEqual(original);
    expect(JSON.stringify(result.messages)).not.toContain("memmy_runtime_context");
    expect(JSON.stringify(result.messages)).not.toContain("MEMORY_BUDGET");
  });

  it("rejects an oversized background recall before sending the request", async () => {
    const f = setup();
    f.client.startTurn.mockResolvedValue({ injectedContext: "required memory ".repeat(2000), sourceMemoryIds: [] });
    const provider = { ...f.provider, estimatePromptTokens: (messages: any[]) => [estimatePromptTokens(messages), "test"] };
    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "task" }, { role: "assistant", content: "background result" }],
      hook: f.hook, provider: provider as any, sessionKey: "budget", turnId: "BUDGET",
      contextWindowTokens: 10_000, maxTokens: 100, contextBlockLimit: 700 }));
    expect(result.response.errorCode).toBe("context_length_exceeded");
    expect(f.provider.chatWithRetry).not.toHaveBeenCalled();
  });
});
