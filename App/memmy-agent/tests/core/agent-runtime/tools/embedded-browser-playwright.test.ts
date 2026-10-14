import { expect, it, vi } from 'vitest';
import { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';

const leaseId = 'a'.repeat(32);
const identity = { connectionId: 'memmy-webview:fixture', tabId: 9 };

it('polls only the selected tab and current lease, forwards ordered events, and aborts on unsubscribe', async () => {
  const bridge = new EmbeddedBrowserBridge();
  const received = vi.fn();
  let polls = 0;
  let pollingSignal: AbortSignal | undefined;
  const request = vi.fn(async (command: string, _args?: Record<string, any>, _tabId?: number, signal?: AbortSignal) => {
    if (command === 'listTabs') return { browserId: 'fixture', selectedTabId: 9,
      tabs: [{ tabId: 9, title: 'fixture', url: 'https://example.test/' }] };
    if (command !== 'playwrightEvents') return {};
    polls++;
    if (polls === 1) return { events: [
      { sequence: 1, leaseId: 'b'.repeat(32), method: 'Runtime.executionContextCreated', params: { private: true } },
      { sequence: 2, leaseId, method: 'Runtime.executionContextCreated', params: { context: { id: 7 } } },
    ] };
    pollingSignal = signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('canceled')), { once: true }));
  });
  (bridge as any).request = request;
  try {
    await bridge.refresh();
    const stop = bridge.subscribePlaywright(identity, received);
    await bridge.command(identity, 'playwrightStart', { leaseId, approvedOrigin: 'https://example.test' });
    await vi.waitFor(() => expect(polls).toBe(2));
    expect(received).toHaveBeenCalledExactlyOnceWith({ sequence: 2, leaseId,
      method: 'Runtime.executionContextCreated', params: { context: { id: 7 } } });
    expect(request).toHaveBeenLastCalledWith('playwrightEvents', {
      leaseId, approvedOrigin: 'https://example.test', afterSequence: 2, waitMs: 250,
    }, 9, expect.any(AbortSignal));
    stop();
    expect(pollingSignal?.aborted).toBe(true);
    expect(received).toHaveBeenCalledTimes(1);
  } finally { bridge.close(); }
});

it('revokes a waiting executor when the desktop rejects the lease', async () => {
  const bridge = new EmbeddedBrowserBridge();
  const received = vi.fn();
  (bridge as any).request = vi.fn(async (command: string) => {
    if (command === 'listTabs') return { browserId: 'fixture', selectedTabId: 9,
      tabs: [{ tabId: 9, title: 'fixture', url: 'https://example.test/' }] };
    if (command === 'playwrightEvents') throw new Error('Browser document changed');
    return {};
  });
  try {
    await bridge.refresh(); bridge.subscribePlaywright(identity, received);
    await bridge.command(identity, 'playwrightStart', { leaseId, approvedOrigin: 'https://example.test' });
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ leaseId, method: 'Memmy.executorRevoked', params: {} }));
  } finally { bridge.close(); }
});

it('keeps upload approval pending beyond 30 seconds and sends IPC cancellation when it times out', async () => {
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send');
  const send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => callback?.(null));
  Object.defineProperty(process, 'send', { configurable: true, value: send });
  vi.useFakeTimers();
  const bridge = new EmbeddedBrowserBridge();
  (bridge as any).browserId = 'fixture';
  (bridge as any).claims.set(9, { ...identity, browser: 'memmy', title: 'fixture', url: 'https://example.test/' });
  try {
    const pending = bridge.command(identity, 'playwrightStart', { leaseId, approvedOrigin: 'https://example.test',
      uploadPaths: ['/approved/file.txt'] });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000 - 30_001);
    await assertion;
    expect(send.mock.calls[1][0]).toEqual({ type: 'memmy:embedded-browser:cancel',
      requestId: (send.mock.calls[0][0] as { requestId: string }).requestId });
  } finally {
    bridge.close(); vi.useRealTimers();
    if (previousSend) Object.defineProperty(process, 'send', previousSend);
    else delete (process as { send?: unknown }).send;
  }
});
