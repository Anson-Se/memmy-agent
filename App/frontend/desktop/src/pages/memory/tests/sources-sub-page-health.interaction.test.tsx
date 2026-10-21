// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../../api/client-types.js";
import { AppProviders, useApiClients } from "../../../app/providers.js";
import { useAppState } from "../../../state/app-state.js";
import { appActions } from "../../../state/app-actions.js";
import { SourcesSubPage } from "../sources-sub-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stateApi: ReturnType<typeof useAppState>;
const healthy = { ok: true, storage: { ready: true } };

describe("SourcesSubPage memory service recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let restart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    restart = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: {
        restartMemoryService: restart,
        getAppInfo: async () => ({ platform: "darwin", isPackaged: true, isWindowsStore: false })
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mounted = true;
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    document.body.replaceChildren();
    Object.defineProperty(window, "memmy", { configurable: true, value: undefined });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function render(clients: AppClients) {
    await act(async () => {
      root.render(<AppProviders><ClientsHarness clients={clients} /></AppProviders>);
    });
  }

  async function advance(milliseconds: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  }

  function restartButton() {
    const button = Array.from(container.querySelectorAll("button"))
      .find((item) => item.textContent?.includes("重启"));
    if (!button) throw new Error("Memory restart action was not rendered");
    return button;
  }

  it.each(["idle", "completed"] as const)("uses the new version on the first scan after restarting from %s", async (lifecycle) => {
    const clients = createClients(async () => healthy);
    const version = { generation: 2, sequence: 0 };
    const completion = { jobId: "finished", attemptId: "attempt", sourceId: "all", succeeded: true, completedAt: "2026-10-21T00:00:00Z" };
    clients.agentSources.getScanStatus = vi.fn(async () => ({ active: false, progress: null, status: lifecycle, version,
      ...(lifecycle === "completed" ? { completion: { ...completion, version } } : {}) }));
    clients.config.updateOnboarding = vi.fn(async () => ({} as never));
    clients.agentSources.startScan = vi.fn(async (input) => {
      if (input?.expectedVersion?.generation !== version.generation) throw new Error("Scan state changed");
      clients.agentSources.getScanStatus = vi.fn(async () => ({ active: true, progress: { jobId: "new-job", attemptId: "new-attempt", sourceId: "all", phase: "scan", current: 0, total: 0, version: { generation: 2, sequence: 1 } } }));
      return { jobId: "new-job", attemptId: "new-attempt", version: { generation: 2, sequence: 1 } };
    });
    await render(clients);
    await act(async () => {
      if (lifecycle === "completed") {
        stateApi.dispatch(appActions.agentSourceScanCompleted({ ...completion, version: { generation: 1, sequence: 5 } }));
        stateApi.dispatch(appActions.agentSourceScanCompletionExpired("finished", "attempt"));
      } else {
        stateApi.dispatch(appActions.agentSourceScanStatusReceived({ active: false, progress: null, status: "idle", version: { generation: 1, sequence: 0 } }));
      }
    });
    await act(async () => { restartButton().click(); });
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(version);
    expect(container.textContent).toContain("记忆服务已重新启动");
    const scan = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "同步新增");
    expect(scan).toBeDefined();
    expect(scan?.disabled).toBe(false);
    await act(async () => { scan!.click(); });
    expect(clients.agentSources.startScan).toHaveBeenCalledTimes(1);
    expect(clients.agentSources.startScan).toHaveBeenCalledWith({ sourceId: "all", expectedVersion: version });
    expect(stateApi.state.agentSources.scanProgress?.jobId).toBe("new-job");
    expect(stateApi.state.agentSources.error).toBeNull();
  });

  it("keeps scan actions blocked until the post-restart snapshot arrives", async () => {
    const clients = createClients(async () => healthy);
    const pending = deferred<Awaited<ReturnType<AppClients["agentSources"]["getScanStatus"]>>>();
    clients.agentSources.getScanStatus = vi.fn(() => pending.promise);
    await render(clients);
    await act(async () => { restartButton().click(); });
    const scan = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "同步新增");
    expect(scan?.disabled).toBe(true);
    expect(container.textContent).not.toContain("记忆服务已重新启动");
    await act(async () => { pending.resolve({ active: false, progress: null, status: "idle", version: { generation: 2, sequence: 0 } }); });
    expect(scan?.disabled).toBe(false);
    expect(stateApi.state.agentSources.scanStamp?.version?.generation).toBe(2);
  });

  it.each(["scan", "stopped"] as const)("reconciles recovered execution before the first control after %s restart", async (phase) => {
    const clients = createClients(async () => healthy);
    const progress = { jobId: "recovered", attemptId: "attempt", sourceId: "all", phase, current: 1, total: 10, version: { generation: 2, sequence: 0 } };
    clients.agentSources.getScanStatus = vi.fn(async () => ({ active: phase === "scan", progress, version: progress.version }));
    clients.agentSources.cancelScan = vi.fn(async () => ({ ok: true, snapshot: { active: false, progress: null, status: "cancelled", version: { generation: 2, sequence: 1 }, execution: { jobId: progress.jobId, attemptId: progress.attemptId } } }));
    await render(clients);
    await act(async () => { restartButton().click(); });
    expect(stateApi.state.agentSources.scanProgress).toEqual(progress);
    const cancel = [...container.querySelectorAll("button")].find(button => button.getAttribute("aria-label")?.includes("停止"));
    expect(cancel?.disabled).toBe(false);
    await act(async () => { cancel!.click(); });
    expect(clients.agentSources.cancelScan).toHaveBeenCalledWith({ expectedExecution: { jobId: "recovered", attemptId: "attempt" } });
    expect(stateApi.state.agentSources.scanProgress).toBeNull();
  });

  it("does not announce success when health is ready but scan status is unavailable", async () => {
    const clients = createClients(async () => healthy);
    clients.agentSources.getScanStatus = vi.fn(async () => ({ active: false, progress: null, unavailable: { code: "memory_layer_unavailable" as const, message: "offline" } }));
    await render(clients);
    await act(async () => { restartButton().click(); });
    expect(container.textContent).not.toContain("记忆服务已重新启动");
    expect(stateApi.state.agentSources.scanUnavailable).toBeTruthy();
    expect(restartButton().disabled).toBe(false);
  });

  it("does not overwrite a newer execution with a delayed restart snapshot", async () => {
    const clients = createClients(async () => healthy);
    const pending = deferred<Awaited<ReturnType<AppClients["agentSources"]["getScanStatus"]>>>();
    clients.agentSources.getScanStatus = vi.fn(() => pending.promise);
    await render(clients);
    await act(async () => { restartButton().click(); });
    const progress = { jobId: "other-page", attemptId: "new-attempt", sourceId: "all", phase: "scan" as const, current: 1, total: 10, version: { generation: 2, sequence: 1 } };
    await act(async () => { stateApi.dispatch(appActions.agentSourceScanProgressReceived(progress)); });
    await act(async () => { pending.resolve({ active: false, progress: null, status: "idle", version: { generation: 2, sequence: 0 } }); });
    expect(stateApi.state.agentSources.scanProgress).toEqual(progress);
    expect(stateApi.state.agentSources.isScanning).toBe(true);
  });

  it("recovers automatically when Memory becomes ready after the first connection failure", async () => {
    const health = vi.fn().mockRejectedValueOnce(new Error("memory layer network error")).mockResolvedValue(healthy);
    await render(createClients(health));
    expect(container.textContent).toContain("暂不可用");
    expect(container.textContent).toContain("正在自动重试");
    expect(container.textContent).toContain("memory layer network error");
    expect(container.textContent).not.toContain("已停止");

    await advance(5_000);
    expect(health).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("暂不可用");
    expect(container.textContent).not.toContain("正在自动重试");
    expect(container.textContent).not.toContain("memory layer network error");
  });

  it("does not overlap probes while a health request is still pending", async () => {
    const pending = deferred<typeof healthy>();
    const health = vi.fn().mockResolvedValueOnce(healthy).mockReturnValueOnce(pending.promise).mockResolvedValue(healthy);
    await render(createClients(health));
    await advance(5_000);
    await advance(5_000);
    expect(health).toHaveBeenCalledTimes(2);

    await act(async () => { pending.resolve(healthy); });
    await advance(5_000);
    expect(health).toHaveBeenCalledTimes(3);
  });

  it("aborts a timed out probe and resumes polling without waiting for its promise", async () => {
    const nextProbe = deferred<typeof healthy>();
    let firstSignal: AbortSignal | undefined;
    const health = vi.fn()
      .mockImplementationOnce((signal?: AbortSignal) => {
        firstSignal = signal;
        return new Promise(() => undefined);
      })
      .mockReturnValue(nextProbe.promise);
    await render(createClients(health));
    await advance(9_999);
    expect(firstSignal?.aborted).toBe(false);
    expect(health).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(firstSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("记忆服务连接超时");
    await advance(5_000);
    expect(health).toHaveBeenCalledTimes(2);

    await act(async () => { nextProbe.resolve(healthy); });
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("记忆服务连接超时");
  });

  it("ignores the old client's late health failure after switching clients", async () => {
    const oldProbe = deferred<typeof healthy>();
    const oldHealth = vi.fn(() => oldProbe.promise);
    const currentHealth = vi.fn(async () => healthy);
    await render(createClients(oldHealth));
    await render(createClients(currentHealth));
    expect(container.textContent).toContain("运行中");

    await act(async () => { oldProbe.reject(new Error("old client failure")); });
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("old client failure");
    await advance(5_000);
    expect(oldHealth).toHaveBeenCalledTimes(1);
    expect(currentHealth).toHaveBeenCalledTimes(2);
  });

  it("stops polling on unmount and ignores a late response", async () => {
    const pending = deferred<typeof healthy>();
    const health = vi.fn(() => pending.promise);
    await render(createClients(health));
    act(() => root.unmount());
    mounted = false;
    await act(async () => { pending.reject(new Error("late unmounted failure")); });
    await advance(10_000);
    expect(health).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });

  it("keeps restart pending despite an older failed probe and rechecks after restart", async () => {
    const oldProbe = deferred<typeof healthy>();
    const restarting = deferred<{ ok: true }>();
    const health = vi.fn().mockReturnValueOnce(oldProbe.promise).mockResolvedValue(healthy);
    restart.mockReturnValue(restarting.promise);
    await render(createClients(health));

    await act(async () => { restartButton().click(); });
    expect(restartButton().disabled).toBe(true);
    expect(restartButton().textContent).toContain("重启中");
    await act(async () => { oldProbe.reject(new Error("probe from before restart")); });
    await advance(10_000);
    expect(health).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("probe from before restart");
    expect(container.textContent).not.toContain("暂不可用");
    expect(restartButton().disabled).toBe(true);

    await act(async () => { restarting.resolve({ ok: true }); });
    expect(health).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).toContain("记忆服务已重新启动");
    expect(restartButton().disabled).toBe(false);
  });

  it("aborts a never settling old probe and completes a fresh health check after restart", async () => {
    let firstSignal: AbortSignal | undefined;
    const health = vi.fn()
      .mockImplementationOnce((signal?: AbortSignal) => {
        firstSignal = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValue(healthy);
    await render(createClients(health));
    await act(async () => { restartButton().click(); });

    expect(firstSignal?.aborted).toBe(true);
    expect(health).toHaveBeenCalledTimes(2);
    expect(restartButton().disabled).toBe(false);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).toContain("记忆服务已重新启动");
    expect(container.textContent).not.toContain("暂不可用");
  });

  it("bounds the fresh probe after restart so its timeout releases the restart button", async () => {
    let restartSignal: AbortSignal | undefined;
    const health = vi.fn()
      .mockResolvedValueOnce(healthy)
      .mockImplementationOnce((signal?: AbortSignal) => {
        restartSignal = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValue(healthy);
    await render(createClients(health));
    await act(async () => { restartButton().click(); });
    expect(restartButton().disabled).toBe(true);

    await advance(10_000);
    expect(restartSignal?.aborted).toBe(true);
    expect(restartButton().disabled).toBe(false);
    await advance(5_000);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("重启中");
  });

  it("releases restart controls on failure and subsequently recovers through polling", async () => {
    const health = vi.fn().mockRejectedValueOnce(new Error("connection refused")).mockResolvedValue(healthy);
    restart.mockRejectedValue(new Error("Memory is still starting; try again shortly"));
    await render(createClients(health));
    await act(async () => { restartButton().click(); });
    expect(restartButton().disabled).toBe(false);
    expect(container.textContent).toContain("记忆服务重启失败");
    expect(container.textContent).toContain("暂不可用");

    await advance(5_000);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("记忆服务重启失败");
    expect(container.textContent).not.toContain("暂不可用");
  });

  it("ignores an old restart result when a new client's health is already available", async () => {
    const restarting = deferred<{ ok: true }>();
    restart.mockReturnValue(restarting.promise);
    const oldHealth = vi.fn(async () => healthy);
    const currentHealth = vi.fn(async () => healthy);
    await render(createClients(oldHealth));
    await act(async () => { restartButton().click(); });
    await render(createClients(currentHealth));
    await act(async () => { restarting.reject(new Error("old restart failure")); });
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("old restart failure");
    expect(restartButton().disabled).toBe(false);
    expect(oldHealth).toHaveBeenCalledTimes(1);
  });
});

function ClientsHarness(props: { clients: AppClients }) {
  const { setClients } = useApiClients();
  stateApi = useAppState();
  useEffect(() => { setClients(props.clients); }, [props.clients, setClients]);
  return <SourcesSubPage />;
}

function createClients(health: (signal?: AbortSignal) => Promise<unknown>): AppClients {
  return {
    runtimeConfig: {
      baseUrl: "http://127.0.0.1:18100",
      localToken: "test-token",
      memory: { baseUrl: "http://127.0.0.1:18960" }
    },
    localData: { getPath: async () => ({ ok: true, dataPath: "/test/memory" }) },
    agentSources: { listSources: async () => [], getScanStatus: async () => ({ running: false, jobId: null, progress: null, unavailable: null }) },
    config: {
      getScanPreferences: async () => ({ autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false })
    },
    memoryRuntime: { health }
  } as unknown as AppClients;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
