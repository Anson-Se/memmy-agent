import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createOpencodeSkillTarget as backend } from "../App/backend/src/adapters/outbound/skill-writer/opencode/target.ts";
import { createOpencodeSkillTarget as memory } from "../Memory/src/agent-source/integration/opencode/target.ts";
import { readOpencodeDatabase } from "../Memory/src/agent-source/adapters/opencode/db-reader.ts";
import { selectSourceTurn } from "../AgentSourceCore/src/source-turn.ts";

const roots = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(factory) {
  const root = mkdtempSync(join(tmpdir(), "memmy-opencode-upgrade-")); roots.push(root);
  return { root, target: factory({ rootDirectory: root, memmyConfigPath: join(root, "missing.yaml") }) };
}
async function load(root) {
  // Import the installed artifact unchanged: real bridge, real Zod, no SDK substitution.
  const source = readFileSync(join(root, "plugins/memmy-memory.js"), "utf8");
  const path = join(root, "plugins/test-runtime.mjs"); writeFileSync(path, source);
  return (await import(pathToFileURL(path).href)).default;
}

describe.each([["Backend", backend], ["Memory", memory]])("%s OpenCode upgrade", (_, factory) => {
  it("refreshes old files, preserves connection settings and other plugins, and detects partial updates", async () => {
    const { root, target } = fixture(factory);
    mkdirSync(join(root, "plugins"));
    const original = { endpoint: "http://127.0.0.1:19991", token: "fixture-token", memmy_config_path: join(root, "custom.yaml"), custom: { enabled: true } };
    const config = join(root, "plugins/memmy-memory-config.json");
    writeFileSync(config, JSON.stringify(original));
    writeFileSync(join(root, "plugins/memmy-memory.js"), "old plugin");
    writeFileSync(join(root, "plugins/other.js"), "other plugin");
    writeFileSync(join(root, "opencode.jsonc"), "// custom model settings\n{}");
    writeFileSync(join(root, "AGENTS.md"), "user instructions\n");
    expect(await target.isInstalledHookCurrent()).toBe(false);
    await target.installPlugin("opencode");
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject(original);
    expect(await target.isInstalledHookCurrent()).toBe(true);
    const otherPath = (factory === backend ? memory : backend)({ rootDirectory: root });
    expect(await otherPath.isInstalledHookCurrent()).toBe(true);
    const installed = readFileSync(config, "utf8");
    await target.installPlugin("opencode");
    expect(readFileSync(config, "utf8")).toBe(installed);
    expect(readFileSync(join(root, "plugins/other.js"), "utf8")).toBe("other plugin");
    expect(readFileSync(join(root, "opencode.jsonc"), "utf8")).toBe("// custom model settings\n{}");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8").match(/memmy:start/g)).toHaveLength(1);
    writeFileSync(join(root, "plugins/memmy-workspace-bridge.mjs"), "partial write");
    expect(await target.isInstalledHookCurrent()).toBe(false);
    await target.installPlugin("opencode");
    expect(await target.isInstalledHookCurrent()).toBe(true);
    rmSync(join(root, "commands/memmy-resume.md"));
    expect(await target.isInstalledHookCurrent()).toBe(false);
  });

  it("does not overwrite a malformed user config or publish a new revision", async () => {
    const { root, target } = fixture(factory);
    mkdirSync(join(root, "plugins"));
    writeFileSync(join(root, "plugins/memmy-memory-config.json"), "{broken");
    writeFileSync(join(root, "plugins/memmy-memory.js"), "old");
    await expect(target.installPlugin("opencode")).rejects.toThrow();
    expect(readFileSync(join(root, "plugins/memmy-memory.js"), "utf8")).toBe("old");
  });

  it("registers V2 tools, recalls, captures the V2 database once, resumes, and cleans up", async () => {
    const { root, target } = fixture(factory);
    await target.installPlugin("opencode");
    const plugin = await load(root);
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body) : {};
      requests.push({ path, body });
      const data = path === "/api/v1/sessions/open" ? { sessionId: "memmy-session" }
        : path === "/api/v1/turns/start" ? { turnId: body.turnId, injectedContext: { markdown: "Remembered preference" } }
        : path === "/api/v1/memory/search" ? { debug: { hits: [{ id: "trace-1", score: 1 }] } }
        : path === "/api/v1/memory/trace-1" ? { id: "trace-1", summary: "Remembered", refs: { episode: { id: "episode-1", title: "Task" } } }
        : path === "/api/v1/memory/episode-1" ? { id: "episode-1", title: "Task", body: "Episode detail" }
        : path === "/api/v1/memory/add" ? { id: "new-memory" }
        : { status: "stored" };
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    }));
    const dataHome = join(root, "data"); vi.stubEnv("XDG_DATA_HOME", dataHome);
    const dbPath = writeV2Fixture(dataHome);
    const tools = new Map(); let promptHook; let command; let signal; let deliver;
    const disposals = [];
    const registration = () => { const dispose = vi.fn(); disposals.push(dispose); return { dispose }; };
    const ctx = {
      location: { directory: root },
      tool: { async transform(fn) { fn({ add(t) { tools.set(t.name, t); } }); return registration(); } },
      command: { async transform(fn) { fn({ add(c) { command = c; } }); return registration(); } },
      session: {
        async get() { return { agent: "build" }; },
        async hook(name, fn) { expect(name).toBe("prompt"); promptHook = fn; return registration(); },
        async prompt(input) { const event = { sessionID: input.sessionID, messageID: "resume", prompt: { text: input.text } }; await promptHook(event); return event; }
      },
      event: { async *subscribe(options) {
        signal = options.signal;
        while (!signal.aborted) {
          const event = await new Promise(resolve => {
            const abort = () => resolve(null);
            signal.addEventListener("abort", abort, { once: true });
            deliver = value => { signal.removeEventListener("abort", abort); resolve(value); };
          });
          if (event) yield event;
        }
      } }
    };
    const cleanup = await plugin.setup(ctx);
    try {
      expect([...tools.keys()]).toEqual(["memmy_memory_search", "memmy_memory_get", "memmy_memory_add"]);
      expect(tools.get("memmy_memory_search").input).toMatchObject({ type: "object", required: ["query"] });
      const context = { sessionID: "session-1", agent: "build" };
      for (const [name, args] of [["search", { query: "preference" }], ["get", { id: "trace-1" }], ["add", { content: "fixture fact" }]]) {
        expect(await tools.get("memmy_memory_" + name).execute(args, context)).toHaveProperty("content");
      }
      await expect(tools.get("memmy_memory_add").execute({ content: "" }, context)).rejects.toThrow("Missing required");
      const event = { sessionID: "session-1", messageID: "user-1", prompt: { text: "Inspect README", files: [{ uri: "file:///fixture" }] } };
      await promptHook(event);
      expect(event.prompt.text).toContain("Remembered preference");
      expect(event.prompt.files).toHaveLength(1);
      deliver({ type: "session.status", data: { sessionID: "session-1", status: { type: "idle" } } });
      await vi.waitFor(() => expect(requests.filter(r => r.path === "/api/v1/source-turns/complete")).toHaveLength(1));
      deliver({ type: "session.idle", data: { sessionID: "session-1" } });
      const capture = requests.find(r => r.path === "/api/v1/source-turns/complete").body;
      expect(capture).toMatchObject({ query: "Inspect README", answer: "Verified", toolCalls: [expect.objectContaining({ name: "read", output: "README contents" })] });
      const scanned = await selectSourceTurn(readOpencodeDatabase(dbPath), { conversationId: "session-1", turnId: "user-1" });
      expect(capture.sourceTurn.turnId).toBe(scanned.turn.turnId);
      expect(capture.answer).toBe(scanned.turn.answer);
      await command.execute({ sessionID: "resume-session", prompt: { text: "prior task" }, delivery: "queue" });
      expect(requests.some(r => r.path === "/api/v1/memory/search" && r.body.query === "prior task")).toBe(true);
      const selection = { sessionID: "resume-session", messageID: "selection", prompt: { text: "1" } };
      await promptHook(selection);
      expect(selection.prompt.text).toContain("Episode detail");
      ctx.session.get = async () => { throw new Error("session temporarily unavailable"); };
      const unavailable = { sessionID: "unavailable", messageID: "retry", prompt: { text: "Keep my request" } };
      await expect(promptHook(unavailable)).resolves.toBeUndefined();
      expect(unavailable.prompt.text).toBe("Keep my request");
    } finally { await cleanup(); await cleanup(); }
    expect(signal.aborted).toBe(true);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(requests.filter(r => r.path === "/api/v1/source-turns/complete")).toHaveLength(1);
  });
});

describe("V2 native completion boundaries", () => {
  it.each(["unfinished", "tool-only", "interrupted", "subagent", "reverted"])("handles %s without capturing an invalid turn", async (kind) => {
    const { root } = fixture(memory);
    const dbPath = writeV2Fixture(root);
    const db = new DatabaseSync(dbPath);
    if (kind === "subagent") db.exec("UPDATE session_v2 SET parent_id = 'parent'");
    if (kind === "reverted") {
      db.exec("ALTER TABLE session_v2 ADD COLUMN revert TEXT");
      db.prepare("UPDATE session_v2 SET revert = ?").run(JSON.stringify({ messageID: "user-1" }));
    }
    if (["unfinished", "tool-only", "interrupted"].includes(kind)) db.exec("DELETE FROM session_message WHERE id = 'assistant-2'");
    if (["tool-only", "interrupted"].includes(kind)) db.prepare("INSERT INTO session_message VALUES ('idle', 'session-1', 'idle', ?, 4, ?)").run(
      JSON.stringify({ outcome: kind === "interrupted" ? "interrupted" : "succeeded", time: { created: 1792371600010 } }), 1792371600010);
    db.close();
    const { turn } = await selectSourceTurn(readOpencodeDatabase(dbPath), { conversationId: "session-1", turnId: "user-1" });
    if (["tool-only", "interrupted"].includes(kind)) {
      expect(turn.status).toBe(kind === "interrupted" ? "failed" : "succeeded");
      expect(turn.toolCalls).toHaveLength(1);
    } else expect(turn).toBeNull();
  });
});

function writeV2Fixture(dataHome) {
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  const path = join(dataHome, "opencode/opencode.db"); const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, agent TEXT, time_created INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, seq INTEGER, time_created INTEGER)");
  db.prepare("INSERT INTO session_v2 VALUES (?, NULL, ?, 'build', 1)").run("session-1", dataHome);
  const insert = db.prepare("INSERT INTO session_message VALUES (?, 'session-1', ?, ?, ?, ?)");
  const start = Date.parse("2026-10-19T01:00:00Z");
  insert.run("user-1", "user", JSON.stringify({ type: "user", text: "Inspect README", time: { created: start } }), 1, start);
  insert.run("assistant-1", "assistant", JSON.stringify({ type: "assistant", agent: "build", finish: "tool-calls", time: { created: start + 1, completed: start + 2 }, content: [{ type: "tool", id: "call-1", name: "read", state: { status: "completed", input: { path: "README.md" }, content: [{ type: "text", text: "README contents" }] } }] }), 2, start + 1);
  insert.run("assistant-2", "assistant", JSON.stringify({ type: "assistant", agent: "build", finish: "stop", time: { created: start + 3, completed: start + 4 }, content: [{ type: "text", text: "Verified" }] }), 3, start + 3);
  db.close(); return path;
}
