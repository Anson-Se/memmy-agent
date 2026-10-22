import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";

type PermissionScope = { url: string; token: string; active: boolean; signal: AbortSignal; onEvent?: (event: Record<string, unknown>) => void };
const scopes = new AsyncLocalStorage<PermissionScope>();
const fileCalls = new AsyncLocalStorage<string>();

export function withMemmateFileCall<T>(callId: string, run: () => T): T {
  return fileCalls.run(callId, run);
}

/** Traversal grants never cover descendants: check every path before returning or reading it. */
export async function withMemmateReadPath<T>(path: string, read: () => Promise<T>): Promise<T> {
  if (!memmatePermissionRequired()) return read();
  const parentCallId = fileCalls.getStore();
  if (!parentCallId) throw new Error("MemMate file access context is missing");
  const callId = randomUUID();
  emitMemmateToolEvent({ type: "tool_call", callId, name: "read_file", input: { path } });
  try {
    await authorizeMemmateTool("memmate_read_path", { path }, undefined, callId, parentCallId);
    const result = await read();
    const scope = scopes.getStore();
    if (!scope?.active || scope.signal.aborted) throw new Error("MemMate run has ended");
    emitMemmateToolEvent({ type: "tool_result", callId, name: "read_file", ok: true, output: "File access completed" });
    return result;
  } catch (error) {
    emitMemmateToolEvent({ type: "tool_result", callId, name: "read_file", ok: false,
      output: `Error: ${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}

export function memmatePermissionRequired(): boolean {
  return process.env.MEMMATE_PERMISSION_REQUIRED === "1";
}

export function authenticateMemmateRuntime(request: Request): boolean {
  const expected = process.env.MEMMATE_RUNTIME_TOKEN ?? "";
  const actual = request.headers.get("x-memmate-runtime-token") ?? "";
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expected.length >= 32 && actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

export function createMemmatePermissionScope(value: unknown, signal: AbortSignal): PermissionScope {
  if (!value || typeof value !== "object") throw new Error("MemMate approval connection is required");
  const input = value as { url?: unknown; token?: unknown };
  if (typeof input.url !== "string" || typeof input.token !== "string" || !/^[a-f0-9]{64}$/u.test(input.token)) {
    throw new Error("Invalid MemMate approval connection");
  }
  const url = new URL(input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.pathname !== "/authorize" || url.username || url.password || url.search || url.hash) {
    throw new Error("MemMate approval connection must be local");
  }
  return { url: url.href, token: input.token, active: true, signal };
}

export function withMemmatePermission<T>(scope: PermissionScope | undefined, run: () => T): T {
  return scope ? scopes.run(scope, run) : run();
}

/** Outside the authenticated request scope, managed runtimes cannot execute tools. */
export async function authorizeMemmateTool(name: string, args: unknown, signal?: AbortSignal | null, callId: string = randomUUID(), parentCallId?: string): Promise<{ args: unknown; result?: string }> {
  const scope = scopes.getStore();
  if (!scope) {
    if (memmatePermissionRequired()) throw new Error("MemMate approval context is missing");
    return { args };
  }
  if (!scope.active || scope.signal.aborted || signal?.aborted) throw new Error("MemMate run has ended");
  // A detached copy prevents a hook or parallel caller from changing approved parameters.
  const approvedArgs = JSON.parse(JSON.stringify(args));
  if (!parentCallId) emitMemmateToolEvent({ type: "tool_call", callId, name, input: approvedArgs });
  const response = await fetch(scope.url, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${scope.token}` },
    body: JSON.stringify({ callId, toolName: name, args: approvedArgs,
      ...(["read_file", "list_dir", "find_files", "grep", "memmate_read_path"].includes(name) ? { fileAccessProtocol: 1 } : {}),
      ...(parentCallId ? { parentCallId } : {}) }),
    signal: AbortSignal.any([scope.signal, ...(signal ? [signal] : []), AbortSignal.timeout(125_000)])
  });
  if (!response.ok) throw new Error("MemMate approval service is unavailable");
  const result = await response.json() as { decision?: string; reason?: string; result?: unknown };
  if (result.decision !== "allow") throw new Error(`MemMate denied this operation: ${result.reason ?? "denied"}`);
  if (!scope.active || scope.signal.aborted || signal?.aborted) throw new Error("MemMate run has ended");
  if (name === "web_fetch" && typeof result.result !== "string") throw new Error("MemMate web execution result is missing");
  return { args: approvedArgs, ...(typeof result.result === "string" ? { result: result.result } : {}) };
}

export function emitMemmateToolEvent(event: Record<string, unknown>): void {
  const scope = scopes.getStore();
  if (scope?.active && !scope.signal.aborted) scope.onEvent?.(event);
}
