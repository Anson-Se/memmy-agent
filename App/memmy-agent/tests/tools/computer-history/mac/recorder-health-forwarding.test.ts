import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { nativeRecorderDiagnostic, recorderHealthReporter } from "../../../../src/tools/computer-history/mac/recorder-health.js";

const fixture = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../../../src/tools/computer-history/mac/native-helper.js", () => ({
  historyNativeCommand: async () => ({ binary: "/synthetic/history-helper", args: [], managed: false }),
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: async () => ({
    stdout: JSON.stringify({ inputMonitoring: true, screenRecording: false, accessibility: true,
      mainDisplayWidth: 100, mainDisplayHeight: 100 }), stderr: "",
  }) });
  return { ...actual, execFile, spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { this.killed = true; return true; },
    });
    setImmediate(async () => {
      for (const line of fixture.lines) {
        child.stdout.write(line + "\n");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      child.stdout.end();
      child.emit("exit", 0, null); child.emit("close", 0, null);
    });
    return child;
  } };
});
import { recordingStep, run } from "../../../../src/tools/computer-history/mac/record-human-history.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let directory: string;
let signalListeners: Map<string, ((...args: unknown[]) => unknown)[]>;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-health-fixture-"));
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  signalListeners = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, process.listeners(signal)]));
});
afterEach(() => {
  for (const [signal, original] of signalListeners) for (const listener of process.listeners(signal)) {
    if (!original.includes(listener)) process.removeListener(signal, listener);
  }
  Object.defineProperty(process, "platform", platform);
  fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("content-free recorder health", () => {
  test("projects only allowed codes, UTC times and positive counters", () => {
    assert.deepEqual(nativeRecorderDiagnostic({ type: "recorder.diagnostic", code: "observer_unavailable",
      timestamp: "2026-10-09T12:00:00Z", count: 2, app: "Private app", url: "https://private.invalid", text: "Private data" }), {
      code: "observer_unavailable", timestamp: "2026-10-09T12:00:00.000Z", count: 2,
    });
    for (const value of [null, [], { type: "recorder.diagnostic", code: "event_recorded", timestamp: "2026-10-09T12:00:00Z" },
      { type: "recorder.diagnostic", code: "Private data", timestamp: "2026-10-09T12:00:00Z" },
      { type: "recorder.diagnostic", code: "heartbeat", timestamp: "invalid" },
      { type: "recorder.diagnostic", code: "privacy_unknown", timestamp: "2026-10-09T12:00:00Z", count: 0 }]) {
      assert.equal(nativeRecorderDiagnostic(value), null);
    }
  });

  test("throttles per code, sums batches, and retains the last successful write time through Stop", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    const output: string[] = [];
    const health = recorderHealthReporter((line) => output.push(line));
    health.report("event_recorded"); health.report("observer_unavailable");
    vi.advanceTimersByTime(2_000);
    health.report("event_recorded"); health.report("observer_unavailable", { count: 2 });
    vi.advanceTimersByTime(2_000); health.report("observer_unavailable", { count: 3 });
    assert.equal(output.length, 2);
    vi.advanceTimersByTime(6_000);
    const signals = output.map((line) => JSON.parse(line.slice("[recorder-health] ".length)));
    assert.equal(signals[2].timestamp, "2026-10-09T12:00:02.000Z");
    assert.equal(signals[3].count, 5);
    assert.equal(signals[3].timestamp, "2026-10-09T12:00:04.000Z");
    vi.advanceTimersByTime(1_000); health.report("event_recorded");
    health.close(); health.report("observer_unavailable");
    assert.equal(output.length, 5);
    assert.equal(JSON.parse(output[4].slice("[recorder-health] ".length)).timestamp, "2026-10-09T12:00:11.000Z");
    assert.equal(vi.getTimerCount(), 0);
  });

  test("forwards native health without writing it to history and exposes unknown coverage without private content", async () => {
    const app = { name: "Synthetic Notes", bundleIdentifier: "com.example.Notes" };
    fixture.lines = [
      JSON.stringify({ type: "recorder.diagnostic", code: "heartbeat", timestamp: "2026-10-09T12:00:00Z", text: "Private diagnostic" }),
      JSON.stringify({ type: "recorder.diagnostic", code: "observer_unavailable", timestamp: "2026-10-09T12:00:00Z", count: 2, url: "https://private.invalid" }),
      JSON.stringify({ kind: "mouse.click", app: { bundleIdentifier: "com.google.Chrome" },
        window: { browser: true, privateBrowsingUnknown: true, url: "https://private.invalid" },
        mouse: { target: { title: "Private target" } } }),
      JSON.stringify({ kind: "mouse.click", app: { bundleIdentifier: "com.google.Chrome" },
        window: { browser: true, privateBrowsing: true }, mouse: { target: { title: "Private target" } } }),
      "Malformed Private helper data",
      JSON.stringify({ kind: "mouse.click", app, mouse: { target: { role: "AXButton", title: "Allowed control" } } }),
    ];
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const output = path.join(directory, "events.jsonl");
    await run(["node", "synthetic", "--out", output, "--no-screenshots"]);
    const signals = logs.mock.calls.filter(([line]) => String(line).startsWith("[recorder-health] "))
      .map(([line]) => JSON.parse(String(line).slice("[recorder-health] ".length)));
    assert.deepEqual(signals.find((signal) => signal.code === "observer_unavailable"), {
      code: "observer_unavailable", timestamp: "2026-10-09T12:00:00.000Z", count: 2,
    });
    assert.equal(signals.filter((signal) => signal.code === "privacy_unknown").length, 1);
    assert.ok(signals.some((signal) => signal.code === "helper_parse_error"));
    assert.ok(signals.some((signal) => signal.code === "event_recorded"));
    assert.doesNotMatch(JSON.stringify(signals), /Private|private\.invalid|Synthetic Notes|Allowed control/u);
    const raw = fs.readFileSync(output, "utf8");
    assert.doesNotMatch(raw, /recorder\.diagnostic|observer_unavailable|Private|private\.invalid/u);
    assert.match(raw, /Allowed control/u);
  });

  test("policy exclusions alone do not claim a capture fault or successful event write", async () => {
    fixture.lines = [JSON.stringify({ kind: "mouse.click", app: { bundleIdentifier: "com.example.Excluded" },
      mouse: { target: { title: "Excluded" } } }), JSON.stringify({ kind: "mouse.click", app: { bundleIdentifier: "com.example.Excluded" },
      window: { browser: true, privateBrowsingUnknown: true }, mouse: { target: { title: "Excluded private state" } } })];
    const settings = path.join(directory, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe",
      rules: [{ scope: "app", bundleID: "com.example.Excluded", behavior: "do_not_observe" }] } }));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["node", "synthetic", "--out", path.join(directory, "events.jsonl"), "--no-screenshots", "--observation-settings", settings]);
    assert.equal(logs.mock.calls.filter(([line]) => String(line).startsWith("[recorder-health] ")).length, 0);
  });

  test("an isolated processing failure emits a signal and subsequent events still run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn(), fatal = vi.fn();
    const step = recordingStep(fatal, onFailure);
    await step(async () => { throw new Error("Private failure text"); })();
    const next = vi.fn(); await step(async () => { next(); })();
    assert.equal(onFailure.mock.calls.length, 1); assert.equal(next.mock.calls.length, 1); assert.equal(fatal.mock.calls.length, 0);
  });
});
