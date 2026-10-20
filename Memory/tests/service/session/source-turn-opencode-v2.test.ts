import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildSourceTurnRequest, createOpencodeDatabaseSource, readOpencodeSourceTurn } from "@memmy/agent-source-core";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

describe("OpenCode V2 live capture and historical scan", () => {
  it.each(["hook", "agent_source_scan"] as const)("stores consecutive turns once when %s arrives first", async (firstChannel) => {
    const native = new DatabaseSync(":memory:");
    const { db, service } = fixture.createTestService();
    try {
      native.exec("CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, agent TEXT, time_created INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, seq INTEGER, time_created INTEGER)");
      native.exec("INSERT INTO session_v2 VALUES ('native-session', NULL, '/fixture', 'build', 1)");
      const insert = native.prepare("INSERT INTO session_message VALUES (?, 'native-session', ?, ?, ?, ?)");
      for (const [index, outcome] of ["succeeded", "failed", "interrupted"].entries()) {
        const id = `native-user-${index}`;
        const time = 4_070_944_800_000 + index * 1000;
        insert.run(id, "user", JSON.stringify({ type: "user", text: `Inspect and document lifecycle case ${index}.`, time: { created: time } }), index * 3, time);
        insert.run(`${id}-answer`, "assistant", JSON.stringify({ type: "assistant", agent: "build", finish: "stop", content: [{ type: "text", text: `Verified and documented lifecycle case ${index}.` }], time: { created: time + 1, completed: time + 2 } }), index * 3 + 1, time + 1);
        insert.run(`${id}-idle`, "idle", JSON.stringify({ type: "idle", outcome, time: { created: time + 3 } }), index * 3 + 2, time + 3);
        const identity = { conversationId: "native-session", turnId: id };
        const live = await readOpencodeSourceTurn(createOpencodeDatabaseSource(native)!, identity);
        const scanned = await readOpencodeSourceTurn(createOpencodeDatabaseSource(native)!, identity);
        expect(live.turn).not.toBeNull();
        expect(scanned.turn).toEqual(live.turn);
        const request = (channel: "hook" | "agent_source_scan") => ({
          ...buildSourceTurnRequest(channel === "hook" ? live.turn! : scanned.turn!, channel),
          namespace: { source: "opencode", profileId: "build", userId: "fixture-user" }
        });
        const first = service.completeSourceTurn(request(firstChannel));
        expect(first.status).toBe("stored");
        const second = service.completeSourceTurn(request(firstChannel === "hook" ? "agent_source_scan" : "hook"));
        expect(second.status).toBe("existing");
        expect(second.result?.l1MemoryId).toBe(first.result?.l1MemoryId);
      }
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get()).toEqual({ count: 3 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'L1'").get()).toEqual({ count: 3 });
    } finally { native.close(); }
  });
});
