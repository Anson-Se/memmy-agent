import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), accessSync: vi.fn(), realpathSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ constants: { X_OK: 1 }, accessSync: mocks.accessSync, realpathSync: mocks.realpathSync }));
vi.mock('../src/main/memmy-screen-permission.js', () => ({
  computerUseAgentEnvironment: () => ({ OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: 'fixture-app' }),
}));
import { stopComputerUseAgentForPermissionRestart } from '../src/main/computer-use-agent-restart.js';

const binary = '/isolated/Memmy Computer Use (Dev).app/Contents/MacOS/MemmyComputerUse';
class FakeChild extends EventEmitter {
  kill = vi.fn((_signal: string) => true);
  unref = vi.fn();
}
let children: FakeChild[];
function begin() {
  let settled = false;
  const promise = stopComputerUseAgentForPermissionRestart(false, '', binary).then(() => { settled = true; });
  return { promise, settled: () => settled };
}
function closeAll() { for (const child of children) child.emit('close', 0); }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); children = [];
  mocks.realpathSync.mockImplementation(path => path);
  mocks.accessSync.mockImplementation(() => {});
  mocks.spawn.mockImplementation(() => { const child = new FakeChild(); children.push(child); return child; });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('bounded native history agent shutdown', () => {
  it('preserves both namespace identities and the full normal 4 second window without killing a healthy helper', async () => {
    vi.stubEnv('OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE', 'inherited-wrong-namespace');
    const pending = begin();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.spawn.mock.calls.map(call => call[1])).toEqual([
      ['__memmy-history', '--stop-agent'], ['__memmy-history', '--stop-agent'],
    ]);
    expect(mocks.spawn.mock.calls[0][2].env.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE).toBe('fixture-app');
    expect(mocks.spawn.mock.calls[1][2].env).not.toHaveProperty('OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE');
    await vi.advanceTimersByTimeAsync(3_999);
    expect(pending.settled()).toBe(false);
    for (const child of children) expect(child.kill).not.toHaveBeenCalled();
    closeAll(); await pending.promise;
    expect(vi.getTimerCount()).toBe(0);
    for (const child of children) { expect(child.kill).not.toHaveBeenCalled(); expect(child.listenerCount('close')).toBe(0); expect(child.listenerCount('error')).toBe(0); }
  });

  it('settles a spawn error and clears the other helper normally', async () => {
    const pending = begin(); children[0].emit('error', new Error('spawn failed')); children[1].emit('close', 0);
    await pending.promise;
    expect(vi.getTimerCount()).toBe(0);
    for (const child of children) expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['before-timeout', 'during-kill'] as const)('safely absorbs another error before close after an error %s', async timing => {
    const pending = begin();
    children[1].emit('close', 0);
    if (timing === 'before-timeout') children[0].emit('error', new Error('initial spawn error'));
    else {
      children[0].kill.mockImplementation(() => { children[0].emit('error', new Error('initial kill error')); return false; });
      await vi.advanceTimersByTimeAsync(4_000);
    }
    await pending.promise;
    expect(vi.getTimerCount()).toBe(0);
    expect(() => children[0].emit('error', new Error('late error before close'))).not.toThrow();
    expect(() => children[0].emit('error', new Error('another late error before close'))).not.toThrow();
    expect(children[0].unref).toHaveBeenCalledOnce();
    children[0].emit('close', 0);
    expect(children[0].listenerCount('close')).toBe(0);
    expect(children[0].listenerCount('error')).toBe(0);
  });

  it('escalates a helper that ignores SIGTERM and settles even without a close event', async () => {
    const pending = begin();
    await vi.advanceTimersByTimeAsync(4_000);
    for (const child of children) expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(pending.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(pending.settled()).toBe(true);
    await pending.promise;
    expect(vi.getTimerCount()).toBe(0);
    for (const child of children) { expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]); expect(child.unref).toHaveBeenCalledOnce(); }
  });

  it('does not send SIGKILL when SIGTERM closes the helper during the grace period', async () => {
    const pending = begin();
    await vi.advanceTimersByTimeAsync(4_000);
    closeAll(); await pending.promise;
    await vi.advanceTimersByTimeAsync(500);
    for (const child of children) expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave a grace timer if closing synchronously while sending SIGTERM', async () => {
    const pending = begin();
    for (const child of children) child.kill.mockImplementation(() => { child.emit('close', 0); return true; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pending.settled()).toBe(true); await pending.promise;
    expect(vi.getTimerCount()).toBe(0);
    for (const child of children) expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  it.each(['false', 'throw'] as const)('settles when SIGTERM returns %s without waiting for close', async mode => {
    const pending = begin();
    for (const child of children) child.kill.mockImplementation(() => { if (mode === 'throw') throw new Error('kill failed'); return false; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pending.settled()).toBe(true); await pending.promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['false', 'throw'] as const)('settles when SIGKILL returns %s without waiting for close', async mode => {
    const pending = begin();
    for (const child of children) child.kill.mockImplementation(signal => { if (signal === 'SIGKILL') { if (mode === 'throw') throw new Error('kill failed'); return false; } return true; });
    await vi.advanceTimersByTimeAsync(4_250);
    expect(pending.settled()).toBe(true); await pending.promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the whole pair when just one namespace hangs', async () => {
    const pending = begin(); children[0].emit('close', 0);
    await vi.advanceTimersByTimeAsync(4_250);
    expect(pending.settled()).toBe(true); await pending.promise;
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(children[1].kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late close and error events after forced settlement and releases the remaining safety listeners on close', async () => {
    const pending = begin(); await vi.advanceTimersByTimeAsync(4_250);
    expect(pending.settled()).toBe(true); await pending.promise;
    for (const child of children) {
      expect(() => child.emit('error', new Error('late kill error'))).not.toThrow();
      child.emit('close', 0); child.emit('close', 0);
      expect(child.listenerCount('close')).toBe(0); expect(child.listenerCount('error')).toBe(0);
      expect(child.kill).toHaveBeenCalledTimes(2);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 'relative/MemmyComputerUse', '/isolated/Other.app/Contents/MacOS/MemmyComputerUse', '/isolated/Memmy Computer Use.app/Contents/MacOS/Other'])('retains binary identity validation for %s', async candidate => {
    await stopComputerUseAgentForPermissionRestart(false, '', candidate);
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not spawn an inaccessible binary or a realpath outside the allowed app identity', async () => {
    mocks.accessSync.mockImplementationOnce(() => { throw new Error('missing binary'); });
    await stopComputerUseAgentForPermissionRestart(false, '', binary);
    mocks.realpathSync.mockReturnValueOnce('/isolated/Other.app/Contents/MacOS/MemmyComputerUse');
    await stopComputerUseAgentForPermissionRestart(false, '', binary);
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the packaged binary path and namespace pair', async () => {
    const promise = stopComputerUseAgentForPermissionRestart(true, '/isolated/resources');
    expect(mocks.spawn.mock.calls.map(call => call[0])).toEqual([
      '/isolated/resources/app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse',
      '/isolated/resources/app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse',
    ]);
    closeAll(); await promise;
    expect(vi.getTimerCount()).toBe(0);
  });
});
