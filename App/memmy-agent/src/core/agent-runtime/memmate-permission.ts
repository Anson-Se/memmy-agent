import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";

type PermissionScope = { url: string; token: string; active: boolean; signal: AbortSignal };
const scopes = new AsyncLocalStorage<PermissionScope>();

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
export async function authorizeMemmateTool(name: string, args: unknown, signal?: AbortSignal | null): Promise<unknown> {
  const scope = scopes.getStore();
  if (!scope) {
    if (memmatePermissionRequired()) throw new Error("MemMate approval context is missing");
    return args;
  }
  if (!scope.active || scope.signal.aborted || signal?.aborted) throw new Error("MemMate run has ended");
  // A detached copy prevents a hook or parallel caller from changing approved parameters.
  const approvedArgs = JSON.parse(JSON.stringify(args));
  const response = await fetch(scope.url, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${scope.token}` },
    body: JSON.stringify({ callId: randomUUID(), toolName: name, args: approvedArgs }),
    signal: AbortSignal.any([scope.signal, ...(signal ? [signal] : []), AbortSignal.timeout(125_000)])
  });
  if (!response.ok) throw new Error("MemMate approval service is unavailable");
  const result = await response.json() as { decision?: string; reason?: string };
  if (result.decision !== "allow") throw new Error(`MemMate denied this operation: ${result.reason ?? "denied"}`);
  if (!scope.active || scope.signal.aborted || signal?.aborted) throw new Error("MemMate run has ended");
  return approvedArgs;
}
