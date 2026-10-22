import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMemmatePermissionScope, withMemmatePermission } from "../../../src/core/agent-runtime/memmate-permission.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { ToolCallRequest } from "../../../src/providers/base.js";
import { ListDirTool } from "../../../src/core/agent-runtime/tools/filesystem.js";
import { FindFilesTool, GrepTool } from "../../../src/core/agent-runtime/tools/search.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(name: string, decide: (input: any) => Promise<string> = async () => "allow") {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "memmate-files-"))); roots.push(workspace);
  await fs.mkdir(path.join(workspace, "nested"));
  await fs.writeFile(path.join(workspace, "nested", "private.txt"), "needle secret");
  const tool = name === "list_dir" ? new ListDirTool({ workspace }) : name === "grep" ? new GrepTool({ workspace }) : new FindFilesTool({ workspace });
  const requests: any[] = [];
  vi.stubEnv("MEMMATE_PERMISSION_REQUIRED", "1");
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    return Response.json({ decision: await decide(request), reason: "test_policy" });
  }));
  const scope = createMemmatePermissionScope({ url: "http://127.0.0.1:12345/authorize", token: "a".repeat(64) }, new AbortController().signal);
  const run = () => withMemmatePermission(scope, () => new AgentRunner().executeTools(new AgentRunSpec({
    workspace, tools: { get: () => tool, prepareCall: (_name: string, args: any) => [tool, args, null] } as any
  }), [new ToolCallRequest({ id: "parent", name, arguments: { path: ".", recursive: true, pattern: "needle" } })]));
  return { workspace, requests, run, scope, tool };
}
it.each(["list_dir", "find_files", "grep"])("%s checks every visited path and preserves the parent call id", async name => {
  const { workspace, requests, run } = await fixture(name);
  const results = await run();
  expect(results[0].event.status).toBe("ok"); expect(results[0].result).toContain("private.txt");
  expect(requests[0]).toMatchObject({ callId: "parent", fileAccessProtocol: 1, args: { path: workspace } });
  const children = requests.slice(1);
  expect(children.map(r => r.args.path)).toEqual([workspace, path.join(workspace, "nested"), path.join(workspace, "nested", "private.txt")]);
  expect(children.every(r => r.parentCallId === "parent" && r.toolName === "memmate_read_path")).toBe(true);
});
it.each(["list_dir", "find_files", "grep"])("%s stops on a denied descendant without leaking partial results", async name => {
  const { run } = await fixture(name, async request => request.args.path.endsWith("private.txt") ? "deny" : "allow");
  const read = vi.spyOn(fs, "readFile");
  const results = await run();
  expect(results[0].event.status).toBe("error"); expect(results[0].result).toContain("test_policy");
  expect(results[0].result).not.toContain("needle secret"); expect(read).not.toHaveBeenCalled();
});
it("grep waits for confirmation before reading and cancellation cannot resume access", async () => {
  let reply!: (value: string) => void;
  const { run, scope } = await fixture("grep", async request => request.args.path.endsWith("private.txt") ? new Promise(resolve => { reply = resolve; }) : "allow");
  const read = vi.spyOn(fs, "readFile"); const pending = run();
  await vi.waitFor(() => expect(reply).toBeDefined()); expect(read).not.toHaveBeenCalled();
  scope.active = false; reply("allow");
  expect((await pending)[0].event.status).toBe("error"); expect(read).not.toHaveBeenCalled();
});
it("managed traversal called outside its approved tool scope cannot enumerate files", async () => {
  const { tool, workspace } = await fixture("find_files");
  expect(await tool.execute({ path: workspace })).toContain("file access context is missing");
});
