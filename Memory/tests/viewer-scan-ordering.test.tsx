// @vitest-environment happy-dom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../viewer/src/api/client";
import { AgentAccessTab } from "../viewer/src/views/SettingsView";
import { locale } from "../viewer/src/stores/i18n";
import type { AgentSourceScanState } from "../src/agent-source/runtime.js";
vi.mock("../viewer/src/api/client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const running = (sequence = 1): AgentSourceScanState => ({ version: { generation: 1, sequence }, status: "running", running: true, jobId: "job", attemptId: "a", sourceId: "codex", mode: null, progress: { sourceId: "codex", phase: "scan", current: 1, total: 10 }, startedAt: "2026-10-21T00:00:00Z", completedAt: null, error: null });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let container: HTMLDivElement;
let nextStatus: () => Promise<AgentSourceScanState>;
beforeEach(() => {
  vi.useFakeTimers(); locale.value = "zh";
  container = document.createElement("div"); document.body.append(container);
  nextStatus = async () => running();
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.endsWith("scan/status")) return nextStatus();
    if (path === "/api/v1/agent-sources") return { executorAvailable: true, sources: [] };
    return { installed: false, path: "", ok: true };
  });
});
afterEach(() => { act(() => render(null, container)); container.remove(); vi.clearAllMocks(); vi.useRealTimers(); });
const mount = async () => { await act(async () => { render(h(AgentAccessTab, { agentAccess: {}, onPatch: async () => ({}) }), container); }); await act(async () => { await Promise.resolve(); }); };
const control = (index: number) => container.querySelectorAll<HTMLButtonElement>(".agent-scan-progress__controls button")[index]!;
const card = () => container.querySelector(".agent-scan-progress");
it.each(["pause", "cancel"] as const)("7/8: %s response wins over a pre-control polling response", async (kind) => {
  await mount(); expect(card()).not.toBeNull();
  const old = deferred<AgentSourceScanState>(); nextStatus = () => old.promise;
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  const snapshot: AgentSourceScanState = { ...running(3), running: false, status: kind === "pause" ? "paused" : "cancelled", progress: kind === "pause" ? { ...running().progress!, phase: "stopped" } : null };
  vi.mocked(api.post).mockResolvedValue({ ok: true, outcome: "applied", snapshot });
  await act(async () => { control(kind === "pause" ? 0 : 1).click(); });
  expect(api.post).toHaveBeenCalledWith(`/api/v1/agent-sources/scan/${kind === "pause" ? "stop" : "cancel"}`, { expectedExecution: { jobId: "job", attemptId: "a" } });
  await act(async () => { old.resolve(running(2)); });
  if (kind === "cancel") expect(card()).toBeNull();
  else { expect(control(0).textContent).toContain("继续"); expect(control(0).disabled).toBe(false); }
});
it("completion arriving while pause is pending releases controls and expires once", async () => {
  await mount();
  const pause = deferred<unknown>(); vi.mocked(api.post).mockReturnValue(pause.promise);
  await act(async () => { control(0).click(); for (let i = 0; i < 10; i++) await Promise.resolve(); });
  expect(control(0).disabled).toBe(true);
  const done: AgentSourceScanState = { ...running(3), running: false, status: "completed", completedAt: "2026-10-21T00:01:00Z", progress: null };
  nextStatus = async () => done;
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(card()).toBeNull(); expect(container.textContent).toContain("同步完成");
  await act(async () => { pause.resolve({ snapshot: running(2) }); });
  expect(card()).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.textContent).not.toContain("同步完成");
});
it("failed control retains the authoritative running state and releases the button", async () => {
  await mount(); vi.mocked(api.post).mockRejectedValue(new Error("control unavailable"));
  await act(async () => { control(0).click(); for (let i = 0; i < 10; i++) await Promise.resolve(); });
  expect(card()).not.toBeNull(); expect(control(0).textContent).toContain("暂停"); expect(control(0).disabled).toBe(false);
});
it.each(["idle", "running", "paused", "completed"] as const)("restart synchronizes %s before enabling the first operation", async status => {
  const resumable = status === "running" || status === "paused";
  const before: AgentSourceScanState = { ...running(), running: status === "running", status, completedAt: status === "completed" ? "2026-10-21T00:01:00Z" : null, progress: resumable ? { ...running().progress!, phase: status === "paused" ? "stopped" : "scan" } : null };
  nextStatus = async () => before;
  let healthCalls = 0;
  vi.mocked(api.get).mockImplementation(async path => {
    if (path.endsWith("scan/status")) return nextStatus();
    if (path.endsWith("health")) return { ok: true, uptimeMs: ++healthCalls === 1 ? 10_000 : 10 };
    if (path === "/api/v1/agent-sources") return { executorAvailable: true, sources: [] };
    return { installed: false };
  });
  vi.mocked(api.post).mockResolvedValue({ ok: true });
  await mount();
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
  const fresh = deferred<AgentSourceScanState>(); nextStatus = () => fresh.promise;
  await act(async () => { button("重启服务").click(); for (let i = 0; i < 10; i++) await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(container.textContent).not.toContain("记忆服务已重新启动");
  if (resumable) expect(control(0).disabled).toBe(true);
  else expect(button("同步新增").disabled).toBe(true);
  const after: AgentSourceScanState = { ...before, running: false, ...(resumable ? { status: "paused", progress: { ...running().progress!, phase: "stopped" } } : {}), version: { generation: 2, sequence: 0 } };
  await act(async () => { fresh.resolve(after); for (let i = 0; i < 10; i++) await Promise.resolve(); });
  nextStatus = async () => after;
  await act(async () => { (resumable ? control(0) : button("同步新增")).click(); });
  expect(api.post).toHaveBeenLastCalledWith("/api/v1/agent-sources/scan", {
    sourceId: resumable ? "codex" : "all",
    ...(resumable ? { expectedExecution: { jobId: "job", attemptId: "a" } } : { expectedVersion: { generation: 2, sequence: 0 } })
  });
});
it("does not report restart success when the full scan-state read fails", async () => {
  let healthCalls = 0;
  vi.mocked(api.get).mockImplementation(async path => {
    if (path.endsWith("scan/status")) return nextStatus();
    if (path.endsWith("health")) return { ok: true, uptimeMs: ++healthCalls === 1 ? 10_000 : 10 };
    if (path === "/api/v1/agent-sources") return { executorAvailable: true, sources: [] };
    return { installed: false };
  });
  vi.mocked(api.post).mockResolvedValue({ ok: true });
  await mount();
  nextStatus = async () => { throw new Error("scan state unavailable"); };
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "重启服务")!.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(container.textContent).toContain("scan state unavailable");
  expect(container.textContent).not.toContain("记忆服务已重新启动");
  expect(control(0).disabled).toBe(false);
});
