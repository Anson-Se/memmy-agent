import { describe, expect, it } from "vitest";
import { appActions as a } from "../app-actions.js";
import { appReducer as reduce, createInitialAppState } from "../app-reducer.js";
const version = (sequence: number, generation = 1) => ({ generation, sequence });
const progress = (sequence: number, phase: "scan" | "stopped" = "scan", attemptId = "a") => ({ version: version(sequence), jobId: "job", attemptId, sourceId: "all", phase, current: 1, total: 10 });
const completion = (sequence: number, attemptId = "a") => ({ version: version(sequence), jobId: "job", attemptId, sourceId: "all", succeeded: true, completedAt: "2026-10-21T00:00:00Z" });
const running = () => reduce(createInitialAppState(), a.agentSourceScanProgressReceived(progress(1)));
describe("authoritative scan order", () => {
  it("1/4: pause rejects old running; resume rejects old pause", () => {
    let state = running();
    state = reduce(state, a.agentSourceScanControl("pause", "p"));
    expect(state.agentSources.scanProgress?.phase).toBe("scan");
    state = reduce(state, a.agentSourceScanProgressReceived(progress(3, "stopped")));
    expect(reduce(state, a.agentSourceScanProgressReceived(progress(2)))).toBe(state);
    state = reduce(state, a.agentSourceScanProgressReceived(progress(4)));
    expect(reduce(state, a.agentSourceScanProgressReceived(progress(3, "stopped")))).toBe(state);
  });
  it("2: cancel retains execution and rejects delayed progress/completion", () => {
    let state = reduce(running(), a.agentSourceScanProgressReceived(progress(2, "stopped")));
    state = reduce(state, a.agentSourceScanStatusReceived({ version: version(3), status: "cancelled", execution: { jobId: "job", attemptId: "a" }, active: false, progress: null }));
    expect(state.agentSources.scanProgress).toBeNull();
    expect(state.agentSources.scanStamp?.attemptId).toBe("a");
    expect(reduce(state, a.agentSourceScanProgressReceived(progress(1)))).toBe(state);
    expect(reduce(state, a.agentSourceScanCompleted(completion(2)))).toBe(state);
    expect(state.agentSources.recentScanCompletions).toEqual([]);
  });
  it("3: completion wins over pending pause, is accepted once, and releases controls", () => {
    let state = reduce(running(), a.agentSourceScanControl("pause", "p"));
    state = reduce(state, a.agentSourceScanCompleted(completion(2)));
    expect(state.agentSources.scanControl).toBeNull();
    expect(state.agentSources.scanProgress).toBeNull();
    expect(state.agentSources.recentScanCompletions).toHaveLength(1);
    expect(reduce(state, a.agentSourceScanCompleted(completion(2)))).toBe(state);
    const duplicate = reduce(state, a.agentSourceScanCompleted(completion(3)));
    expect(duplicate.agentSources.scanStamp?.version).toEqual(version(3));
    expect(duplicate.agentSources.recentScanCompletions).toBe(state.agentSources.recentScanCompletions);
  });
  it("advances restored completion versions after restart without replaying feedback", () => {
    let state = reduce(running(), a.agentSourceScanCompleted(completion(2)));
    state = reduce(state, a.agentSourceScanCompletionExpired("job", "a"));
    state = reduce(state, a.agentSourceScanCompleted({ ...completion(0), version: version(0, 2) }));
    expect(state.agentSources.scanStamp?.version).toEqual(version(0, 2));
    expect(state.agentSources.recentScanCompletions).toEqual([]);
    state = reduce(state, a.agentSourceScanProgressReceived({ ...progress(1, "scan", "b"), version: version(1, 2) }));
    expect(state.agentSources.isScanning).toBe(true);
  });
  it("5/6: old idle and source-list results cannot clear a new scan", () => {
    let state = reduce(createInitialAppState(), a.agentSourceScanStarted());
    state = reduce(state, a.agentSourceScanProgressReceived(progress(2)));
    expect(reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null, version: version(1), status: "idle" }, 0))).toBe(state);
    expect(reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null }, 0))).toBe(state);
    state = reduce(state, a.agentSourcesLoaded([]));
    state = reduce(state, a.agentSourcesFailed("list failed"));
    expect(state.agentSources.scanProgress).toEqual(progress(2));
    expect(state.agentSources.isScanning).toBe(true);
  });
  it("accepts legacy cancellation only for the pending control and its execution", () => {
    const legacy = { ...progress(1), version: undefined };
    let state = reduce(createInitialAppState(), a.agentSourceScanProgressReceived(legacy));
    state = reduce(state, a.agentSourceScanControl("cancel", "cancel-a"));
    const idle = { active: false, progress: null };
    expect(reduce(state, a.agentSourceScanStatusReceived(idle))).toBe(state);
    expect(reduce(state, a.agentSourceScanStatusReceived(idle, undefined, { ...legacy, token: "old" }))).toBe(state);
    const confirmed = a.agentSourceScanStatusReceived(idle, undefined, { ...legacy, token: "cancel-a" });
    const newer = reduce(state, a.agentSourceScanProgressReceived({ ...legacy, jobId: "new-job", attemptId: "b" }));
    expect(reduce(newer, confirmed)).toBe(newer);
    state = reduce(state, confirmed);
    expect(state.agentSources.isScanning).toBe(false);
    expect(state.agentSources.scanProgress).toBeNull();
    expect(state.agentSources.scanControl).toBeNull();
    expect(reduce(state, a.agentSourceScanProgressReceived(legacy))).toBe(state);
    expect(reduce(state, a.agentSourceScanCompleted({ ...completion(2), version: undefined }))).toBe(state);
  });
  it("accepts newer terminal results from a query issued before control", () => {
    let state = reduce(running(), a.agentSourceScanControl("pause", "p"));
    state = reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null, version: version(4), status: "cancelled", execution: { jobId: "job", attemptId: "a" } }, 0));
    expect(state.agentSources.scanProgress).toBeNull();
  });
  it("recovery uses generation even if the wall clock moved backwards", () => {
    let state = reduce(createInitialAppState(), a.agentSourceScanProgressReceived({ ...progress(9), attemptStartedAt: "2026-10-21" }));
    state = reduce(state, a.agentSourceScanProgressReceived({ ...progress(0), version: version(0, 2), attemptId: "b", attemptStartedAt: "2026-10-20" }));
    expect(state.agentSources.scanProgress?.attemptId).toBe("b");
    expect(reduce(state, a.agentSourceScanProgressReceived(progress(100)))).toBe(state);
  });
  it("old attempt expiry/finally cannot clear new feedback/control", () => {
    let state = reduce(running(), a.agentSourceScanCompleted(completion(2)));
    state = reduce(state, a.agentSourceScanProgressReceived(progress(3, "scan", "b")));
    state = reduce(state, a.agentSourceScanCompleted(completion(4, "b")));
    state = reduce(state, a.agentSourceScanCompletionExpired("job", "a"));
    expect(state.agentSources.recentScanCompletions[0]?.attemptId).toBe("b");
    state = reduce(state, a.agentSourceScanControl("start", "new"));
    expect(reduce(state, a.agentSourceScanControl(null, "old"))).toBe(state);
    state = reduce(state, a.agentSourceScanCompletionExpired("job", "b"));
    expect(state.agentSources.recentScanCompletions).toEqual([]);
  });
});
