import { describe, expect, it } from "vitest";
import { MEMORY_WORKER_JOB_TYPES } from "@memmy/agent-source-core";
import {
  JOB_POLICY_VERSION, JobPolicyRegistry, REGISTERED_JOB_TYPES, UnknownJobPolicyError
} from "../../../src/service/worker/job-policy-registry.js";

const registry = new JobPolicyRegistry();

describe("job policy registry", () => {
  it("covers every shared worker type, locally scheduled idle flush, and the retry adapter", () => {
    const types = [...MEMORY_WORKER_JOB_TYPES, "work_memory_idle_flush", "embedding_retry"];
    expect(new Set(REGISTERED_JOB_TYPES)).toEqual(new Set(types));
    for (const jobType of types) {
      expect(registry.resolve({ jobType }).policyVersion).toBe(JOB_POLICY_VERSION);
    }
  });

  it("keeps unknown and inherited property names explicit errors", () => {
    for (const jobType of ["unregistered_task", "toString", "__proto__", ""]) {
      expect(() => registry.resolve({ jobType })).toThrow(UnknownJobPolicyError);
    }
  });

  it("separates normal historical import, startup bulk repair, and user retry", () => {
    expect(registry.resolve({ jobType: "import_summary" }).queueLane).toBe("import");
    for (const source of ["startup.processing_repair", "startup.placeholder_summary_repair"]) {
      expect(registry.resolve({ jobType: "import_summary", payload: { source } }).queueLane).toBe("maintenance");
    }
    expect(registry.resolve({
      jobType: "import_summary", payload: { source: "memory.processing.manual_retry" }
    }).queueLane).toBe("repair_retry");
    expect(registry.resolve({
      jobType: "import_summary", payload: { source: "memory.processing.lifecycle_retry" }
    }).queueLane).toBe("import");
  });

  it("recognizes the actual startup embedding reason and observation backfill producers", () => {
    for (const reason of ["startup.processing_repair", "startup.retrieval_document_v2"]) {
      expect(registry.resolve({ jobType: "embedding", payload: { reason }, target: { memoryLayer: "L1" } }).queueLane)
        .toBe("maintenance");
    }
    expect(registry.resolve({ jobType: "observation_extract", payload: { source: "startup.observation_backfill" } }).queueLane)
      .toBe("maintenance");
    expect(registry.resolve({
      jobType: "embedding", payload: { reason: "startup.processing_repair" }, target: { agentId: "memmy-onboarding" }
    }).queueLane).toBe("interactive");
  });

  it("classifies historical summaries by origin without demoting fresh Computer History", () => {
    for (const jobType of ["trace_summary", "import_summary", "observation_extract"]) {
      expect(registry.resolve({ jobType, target: { tags: ["agent-source"] } }).queueLane).toBe("import");
      expect(registry.resolve({ jobType, payload: { source: "agent_source.scan.summary_stage" } }).queueLane).toBe("import");
    }
    expect(registry.resolve({
      jobType: "embedding", payload: { reason: "import.summary.updated" }
    }).queueLane).toBe("import");
    expect(registry.resolve({
      jobType: "observation_extract", payload: { source: "evidence.sync" }, target: { tags: ["external-evidence", "computer_history"] }
    }).queueLane).toBe("interactive");
  });

  it.each([
    { agentId: "Memmy-Onboarding" },
    { tags: ["First-Encounter-Report"] },
    { tags: ["ONBOARDING-REPORT"] }
  ])("retains first-report urgency through import and startup repair: %j", (target) => {
    const policy = registry.resolve({
      jobType: "import_summary", target,
      payload: { source: "startup.placeholder_summary_repair" }
    });
    expect(policy).toMatchObject({ queueLane: "interactive", basePriority: -100 });
    // The report's later reflection is background evolution, not a first-report result.
    expect(registry.resolve({ jobType: "reflection", target }).queueLane).toBe("evolution");
  });

  it("classifies embedding from a narrow memory projection without reading the content", () => {
    expect(registry.resolve({ jobType: "embedding", target: { memoryLayer: "L1" } }).queueLane).toBe("interactive");
    for (const target of [
      { memoryLayer: "L1", tags: ["Agent-Source"] },
      { memoryLayer: "L1", pluginAlgorithm: "memory.add.import_async.v2" }
    ]) {
      expect(registry.resolve({ jobType: "embedding", target }).queueLane).toBe("import");
    }
    expect(registry.resolve({ jobType: "embedding", target: { memoryLayer: "L2" } }).queueLane).toBe("evolution");
    expect(registry.resolve({ jobType: "embedding_retry" }).queueLane).toBe("repair_retry");
    expect(registry.resolve({ jobType: "user_memory_embedding" }).queueLane).toBe("interactive");
  });

  it("accepts explicit operation modes without trusting arbitrary payload fields", () => {
    expect(registry.resolve({ jobType: "embedding", operationMode: "historical_import" }).queueLane).toBe("import");
    expect(registry.resolve({ jobType: "embedding_retry", operationMode: "maintenance" }).queueLane).toBe("maintenance");
    expect(registry.resolve({ jobType: "embedding", operationMode: "manual_retry" }).queueLane).toBe("repair_retry");
    expect(registry.resolve({ jobType: "import_summary", operationMode: "onboarding_first_report" }).queueLane).toBe("interactive");
    expect(registry.resolve({ jobType: "reflection", payload: { queueLane: "interactive" } }).queueLane).toBe("evolution");
  });

  it("describes actual model/resource families and scoped work without changing execution", () => {
    expect(registry.resolve({ jobType: "work_memory_extract" })).toMatchObject({
      queueLane: "evolution", resourceClass: "summary",
      concurrency: { providerRoles: ["summary", "embedding"], scope: "user_project", batchable: false }
    });
    expect(registry.resolve({ jobType: "l3_world_model_update" })).toMatchObject({
      resourceClass: "evolution_llm", concurrency: { scope: "user_project" }
    });
    expect(registry.resolve({ jobType: "project_environment_profile" }).queueLane).toBe("maintenance");
    expect(registry.resolve({ jobType: "decision_repair" }).queueLane).toBe("repair_retry");
    expect(registry.resolve({ jobType: "negative_experience" }).concurrency.providerRoles).toContain("evolution");
    expect(registry.resolve({ jobType: "episode_idle_close" }).concurrency.providerRoles).toEqual([]);
  });

  it("retains current lease durations and keeps batch size independent from request admission", () => {
    const main = registry.resolve({ jobType: "embedding" });
    const retry = registry.resolve({ jobType: "embedding_retry" });
    expect(main.lease).toEqual({ durationSec: 60, heartbeatMs: 20_000 });
    expect(retry.lease).toEqual({ durationSec: 300, heartbeatMs: 20_000 });
    expect(main.concurrency.batchable).toBe(true);
    expect(retry.concurrency.batchable).toBe(true);
    expect(Object.isFrozen(main)).toBe(true);
    expect(Object.isFrozen(main.concurrency.providerRoles)).toBe(true);
  });
});
