import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMemmatePermissionScope, withMemmatePermission, withMemmateFileCall, withMemmateReadPath } from "../../../src/core/agent-runtime/memmate-permission.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { ToolCallRequest } from "../../../src/providers/base.js";
import { writePdf, writeDocx } from "../../helpers/long-document-fixtures.js";
import { ListDirTool, ReadFileTool } from "../../../src/core/agent-runtime/tools/filesystem.js";
import { FindFilesTool, GrepTool } from "../../../src/core/agent-runtime/tools/search.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(name: string, decide: (input: any) => Promise<string> = async () => "allow", reason = "operator_rejected") {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "memmate-files-"))); roots.push(workspace);
  await fs.mkdir(path.join(workspace, "nested"));
  await fs.writeFile(path.join(workspace, "nested", "private.txt"), "needle secret");
  const tool = name === "read_file" ? new ReadFileTool({ workspace }) : name === "list_dir" ? new ListDirTool({ workspace }) : name === "grep" ? new GrepTool({ workspace }) : new FindFilesTool({ workspace });
  const requests: any[] = [];
  vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1");
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    return Response.json({ decision: await decide(request), reason });
  }));
  const scope = createMemmatePermissionScope({ url: "http://127.0.0.1:12345/authorize", token: "a".repeat(64) }, new AbortController().signal);
  const events: Record<string, unknown>[] = [];
  scope.onEvent = event => { events.push(event); };
  const run = (args: Record<string, unknown> = { path: ".", recursive: true, pattern: "needle" }) => withMemmatePermission(scope, () => new AgentRunner().executeTools(new AgentRunSpec({
    workspace, tools: { get: () => tool, prepareCall: (_name: string, args: any) => [tool, args, null] } as any
  }), [new ToolCallRequest({ id: "parent", name, arguments: args })]));
  return { workspace, requests, run, scope, tool, events };
}
it.each(["list_dir", "find_files", "grep"])("%s checks every visited path and preserves the parent call id", async name => {
  const { workspace, requests, run, events } = await fixture(name);
  const results = await run();
  expect(results[0].event.status).toBe("ok"); expect(results[0].result).toContain("private.txt");
  expect(requests[0]).toMatchObject({ callId: "parent", fileAccessProtocol: 1, args: { path: workspace } });
  const children = requests.slice(1);
  expect(children.map(r => r.args.path)).toEqual([workspace, path.join(workspace, "nested"), path.join(workspace, "nested", "private.txt")]);
  expect(new Set(children.map(r => r.callId)).size).toBe(children.length);
  for (const child of children) {
    expect(child.callId).not.toBe("parent");
    expect(events.filter(event => event.callId === child.callId)).toEqual([
      { type: "tool_call", callId: child.callId, name: "read_file", input: { path: child.args.path } },
      { type: "tool_result", callId: child.callId, name: "read_file", ok: true, output: "File access completed" }
    ]);
  }
  expect(children.every(r => r.parentCallId === "parent" && r.toolName === "memmate_read_path")).toBe(true);
});
it.each(["list_dir", "find_files", "grep"])("%s preserves authorized results before and after a denied file", async name => {
  const { workspace, run, requests, events } = await fixture(name, async request => request.args.path.endsWith("private.txt") ? "deny" : "allow");
  await fs.writeFile(path.join(workspace, "nested", "a-allowed.txt"), "needle allowed");
  await fs.writeFile(path.join(workspace, "nested", "z-target.txt"), "needle target");
  const read = vi.spyOn(fs, "readFile");
  const result = (await run())[0];
  expect(result.event.status).toBe("ok");
  expect(result.result).toContain("Partial results: skipped 1 denied path(s)");
  expect(result.result).toContain("counts are not the directory total");
  expect(result.result).toContain("a-allowed.txt");
  expect(result.result).toContain("z-target.txt");
  expect(result.result).not.toContain("private.txt");
  expect(result.result).not.toContain("needle secret");
  expect(read.mock.calls.some(args => String(args[0]).endsWith("private.txt"))).toBe(false);
  const deniedRequests = requests.filter(request => request.args.path.endsWith("private.txt"));
  expect(deniedRequests).toHaveLength(1);
  expect(events.find(event => event.callId === deniedRequests[0].callId && event.type === "tool_result")).toMatchObject({ ok: false });
});
it.each(["list_dir", "find_files", "grep"])("%s skips a denied subtree without opening it or discarding siblings", async name => {
  const { workspace, run, requests } = await fixture(name, async request => request.args.path.endsWith("nested") ? "deny" : "allow");
  await fs.mkdir(path.join(workspace, "z-public"));
  await fs.writeFile(path.join(workspace, "z-public", "target.txt"), "needle target");
  const readdir = vi.spyOn(fs, "readdir");
  const result = (await run())[0];
  expect(result.event.status).toBe("ok");
  expect(result.result).toContain("Partial results");
  expect(result.result).toContain("target.txt");
  expect(result.result).not.toContain("nested");
  expect(readdir.mock.calls.some(args => String(args[0]).endsWith("nested"))).toBe(false);
  expect(requests.some(request => request.args.path.endsWith("private.txt"))).toBe(false);
});
it.each(["list_dir", "find_files", "grep"])("%s stops if the requested root is denied", async name => {
  const { run } = await fixture(name, async request => request.parentCallId ? "deny" : "allow");
  const read = vi.spyOn(fs, "readdir");
  const result = (await run())[0];
  expect(result.event.status).toBe("error");
  expect(result.result).toContain("operator_rejected");
  expect(read).not.toHaveBeenCalled();
});
it.each(["approval_unavailable", "action_or_policy_changed", "policy_unavailable", "run_ended", "unknown"])("does not turn %s into partial success", async reason => {
  const { run } = await fixture("grep", async request => request.args.path.endsWith("private.txt") ? "deny" : "allow", reason);
  const result = (await run())[0];
  expect(result.event.status).toBe("error");
  expect(result.result).toContain(reason);
  expect(result.result).not.toContain("Partial results");
});
it("policy-denied children produce partial results without claiming no files exist", async () => {
  const { run } = await fixture("find_files", async request => request.args.path.endsWith("private.txt") ? "deny" : "allow", "denied_by_policy");
  const result = (await run())[0];
  expect(result.event.status).toBe("ok");
  expect(result.result).toMatch(/^Partial results:/);
  expect(result.result).toContain("authorized paths only");
});
it("directory denial does not prevent a separate authorized target read", async () => {
  const { workspace, run, scope } = await fixture("list_dir", async request => request.args.path.endsWith("private.txt") ? "deny" : "allow");
  const target = await writeDocx(workspace, "VERIFIED: target employment");
  expect((await run())[0].result).toContain("Partial results");
  const tool = new ReadFileTool({ workspace });
  const results = await withMemmatePermission(scope, () => new AgentRunner().executeTools(new AgentRunSpec({
    workspace, tools: { get: () => tool, prepareCall: (_name: string, args: any) => [tool, args, null] } as any
  }), [new ToolCallRequest({ id: "read-target", name: "read_file", arguments: { path: target } })]));
  expect(results[0].event.status).toBe("ok");
  expect(results[0].result).toContain("VERIFIED: target employment");
});
it.each(["allow", "deny"])("grep cannot resume cancelled access even when approval returns %s", async decision => {
  let reply!: (value: string) => void;
  const { run, scope } = await fixture("grep", async request => request.args.path.endsWith("private.txt") ? new Promise(resolve => { reply = resolve; }) : "allow");
  const read = vi.spyOn(fs, "readFile"); const pending = run();
  await vi.waitFor(() => expect(reply).toBeDefined()); expect(read).not.toHaveBeenCalled();
  scope.active = false; reply(decision);
  expect((await pending)[0].event.status).toBe("error"); expect(read).not.toHaveBeenCalled();
});
it("managed traversal called outside its approved tool scope cannot enumerate files", async () => {
  const { tool, workspace } = await fixture("find_files");
  expect(await tool.execute({ path: workspace })).toContain("file access context is missing");
});

it.each(["pdf", "docx"])("reads approved %s text using the existing parser and never parses on denial", async ext => {
  let decision = "deny";
  const { workspace, requests, run } = await fixture("read_file", async () => decision);
  const file = ext === "pdf" ? await writePdf(workspace, 1) : await writeDocx(workspace, "VERIFIED: 权威 工作经历");
  const read = vi.spyOn(fsSync, "readFileSync");
  expect((await run({ path: file }))[0].event.status).toBe("error");
  expect(read.mock.calls.filter(args => String(args[0]) === file)).toHaveLength(0);
  decision = "allow";
  const result = (await run({ path: file }))[0];
  expect(result.event.status).toBe("ok"); expect(result.result).toContain("VERIFIED:");
  expect(requests.every(request => request.fileAccessProtocol === 1)).toBe(true);
});
it("managed grep searches extracted PDF and DOCX text instead of skipping them as binary", async () => {
  const { workspace, run } = await fixture("grep");
  await writePdf(workspace, 1); await writeDocx(workspace, "VERIFIED: 权威 工作经历");
  const result = (await run({ path: workspace, pattern: "VERIFIED:", output_mode: "files_with_matches" }))[0];
  expect(result.event.status).toBe("ok");
  expect(result.result).toContain("synthetic-report.pdf"); expect(result.result).toContain("synthetic-report.docx");
  expect(result.result).not.toContain("binary");
});
it("denied document search never calls the parser", async () => {
  const { workspace, run } = await fixture("grep", async request => request.args.path.endsWith(".docx") ? "deny" : "allow");
  const file = await writeDocx(workspace, "PRIVATE-RESUME");
  const read = vi.spyOn(fsSync, "readFileSync");
  const result = (await run({ path: file, pattern: "PRIVATE" }))[0];
  expect(result.event.status).toBe("error");
  expect(read.mock.calls.filter(args => String(args[0]) === file)).toHaveLength(0);
});

it("path outcome follows the actual access and reports access errors", async () => {
  const { workspace, scope, events } = await fixture("grep");
  let finish!: () => void;
  const pending = withMemmatePermission(scope, () => withMemmateFileCall("parent", () =>
    withMemmateReadPath(workspace, () => new Promise<void>(resolve => { finish = resolve; }))));
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(events.map(event => event.type)).toEqual(["tool_call"]);
  finish(); await pending;
  expect(events[1]).toMatchObject({ type: "tool_result", ok: true, callId: events[0].callId });
  await expect(withMemmatePermission(scope, () => withMemmateFileCall("parent", () =>
    withMemmateReadPath(workspace, async () => { throw new Error("read failed"); })))).rejects.toThrow("read failed");
  expect(events[3]).toMatchObject({ type: "tool_result", ok: false, callId: events[2].callId, output: "Error: read failed" });
});

it("all denied directory entries are incomplete, not an empty directory", async () => {
  const { workspace, run } = await fixture("list_dir", async request => request.args.path.endsWith("private.txt") ? "deny" : "allow");
  const result = (await run({ path: path.join(workspace, "nested"), recursive: true }))[0];
  expect(result.event.status).toBe("ok");
  expect(result.result).toContain("Partial results");
  expect(result.result).toContain("no authorized entries returned");
  expect(result.result).not.toContain("empty directory");
});

it.each(["pdf", "docx"])("grep skips a denied %s without parsing it and still parses the next document", async ext => {
  const { workspace, run } = await fixture("grep", async request => request.args.path.endsWith(`a-denied.${ext}`) ? "deny" : "allow");
  const source = ext === "pdf" ? await writePdf(workspace, 1) : await writeDocx(workspace, "VERIFIED: allowed document");
  const denied = path.join(workspace, `a-denied.${ext}`);
  const allowed = path.join(workspace, `z-allowed.${ext}`);
  await fs.copyFile(source, denied); await fs.rename(source, allowed);
  const read = vi.spyOn(fsSync, "readFileSync");
  const result = (await run({ path: workspace, pattern: "VERIFIED:", output_mode: "files_with_matches" }))[0];
  expect(result.event.status).toBe("ok");
  expect(result.result).toContain("Partial results");
  expect(result.result).toContain(`z-allowed.${ext}`);
  expect(result.result).not.toContain(`a-denied.${ext}`);
  expect(read.mock.calls.some(args => String(args[0]) === denied)).toBe(false);
});
it("denying one independent read does not prevent the next read's approval and execution", async () => {
  const { workspace, scope, tool, requests } = await fixture("read_file", async request => request.args.path.endsWith("private.txt") ? "deny" : "allow");
  const allowed = path.join(workspace, "allowed.txt"); await fs.writeFile(allowed, "ALLOWED_CONTENT");
  const results = await withMemmatePermission(scope, () => new AgentRunner().executeTools(new AgentRunSpec({
    workspace, tools: { get: () => tool, prepareCall: (_name: string, args: any) => [tool, args, null] } as any
  }), [
    new ToolCallRequest({ id: "denied-read", name: "read_file", arguments: { path: path.join(workspace, "nested", "private.txt") } }),
    new ToolCallRequest({ id: "allowed-read", name: "read_file", arguments: { path: allowed } })
  ]));
  expect(results.map(result => result.event.status)).toEqual(["error", "ok"]);
  expect(results[1].result).toContain("ALLOWED_CONTENT");
  expect(requests.map(request => request.callId)).toEqual(["denied-read", "allowed-read"]);
});
