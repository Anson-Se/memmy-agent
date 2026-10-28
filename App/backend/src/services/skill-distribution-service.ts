/** Skill distribution service module. */
import { join } from "node:path";
import { readAgentSkillInventory } from "@memmy/agent-source-core";
import { renderMemmyDefaultSkillManifest } from "../adapters/outbound/skill-writer/templates/memmy-default.js";
import type { MemoryPluginConflict } from "../adapters/outbound/skill-writer/types.js";
import type { SkillTargetRegistry } from "../adapters/outbound/skill-writer/target-registry.js";
import { AgentSourceUnavailableError } from "./runtime-errors.js";

export interface ScannedAgentSkill {
  sourceAgentId: string;
  sourceSkillId: string;
  sourceSkillPath: string;
  sourceSkillVersion: string;
  sourceContentHash: string;
  title: string;
  content: string;
  updatedAt: string;
  description?: string;
  disableModelInvocation?: boolean;
  allowImplicitInvocation?: boolean;
  hasSupportingFiles?: boolean;
  frontmatterError?: string;
  policyError?: string;
}

/** Skills found under one Agent root; `complete` is false when any file could not be read. */
export interface AgentSkillScan {
  complete: boolean;
  skills: ScannedAgentSkill[];
  errors: Array<{ path: string; reason: string }>;
}

/** Contract for skill distribution service. */
export interface SkillDistributionService {
  listSkills?(sourceId: string): Promise<ScannedAgentSkill[]>;
  scanSkills?(sourceId: string): Promise<AgentSkillScan>;
  install(sourceId: string): Promise<void>;
  uninstall(sourceId: string): Promise<void>;
  installPlugin(sourceId: string): Promise<void>;
  uninstallPlugin(sourceId: string): Promise<void>;
  isInstalledHookCurrent?(sourceId: string): Promise<boolean>;
  detectMemoryPluginConflicts?(): Promise<MemoryPluginConflict[]>;
}

/** Contract for create skill distribution service options. */
export interface CreateSkillDistributionServiceOptions {
  targetRegistry: SkillTargetRegistry;
}

/** Creates create skill distribution service. */
export function createSkillDistributionService(
  options: CreateSkillDistributionServiceOptions
): SkillDistributionService {
  async function scanSkills(sourceId: string): Promise<AgentSkillScan> {
    const target = options.targetRegistry.get(sourceId);
    const root = await target?.resolveRootDirectory();
    if (!root) return { complete: true, skills: [], errors: [] };

    const inventory = await readAgentSkillInventory(join(root, "skills"));
    return {
      complete: inventory.complete,
      errors: inventory.errors,
      skills: inventory.items.map((item) => ({
        sourceAgentId: sourceId,
        sourceSkillId: item.sourceSkillId,
        sourceSkillPath: item.sourceSkillPath,
        sourceSkillVersion: item.version ?? item.contentHash,
        sourceContentHash: item.contentHash,
        title: item.name ?? item.sourceSkillId,
        content: item.content,
        updatedAt: item.modifiedAt,
        ...(item.description ? { description: item.description } : {}),
        disableModelInvocation: item.disableModelInvocation,
        ...(item.allowImplicitInvocation === undefined ? {} : { allowImplicitInvocation: item.allowImplicitInvocation }),
        hasSupportingFiles: item.hasSupportingFiles,
        ...(item.frontmatterError ? { frontmatterError: item.frontmatterError } : {}),
        ...(item.policyError ? { policyError: item.policyError } : {})
      }))
    };
  }

  return {
    async listSkills(sourceId) {
      return (await scanSkills(sourceId)).skills;
    },

    scanSkills,

    async install(sourceId) {
      const target = options.targetRegistry.require(sourceId);
      if (!(await target.resolveRootDirectory())) {
        throw new AgentSourceUnavailableError(target.displayName);
      }

      await target.install(renderMemmyDefaultSkillManifest(sourceId));
    },

    async uninstall(sourceId) {
      const target = options.targetRegistry.require(sourceId);
      await target.uninstall(sourceId);
    },

    async installPlugin(sourceId) {
      const target = options.targetRegistry.require(sourceId);
      if (!target.installPlugin) {
        throw new Error(`Native plugin installation is not supported for ${target.displayName}`);
      }
      if (!(await target.resolveRootDirectory())) {
        throw new AgentSourceUnavailableError(target.displayName);
      }

      await target.installPlugin(sourceId);
    },

    async uninstallPlugin(sourceId) {
      const target = options.targetRegistry.require(sourceId);
      if (!target.uninstallPlugin) {
        throw new Error(`Native plugin uninstallation is not supported for ${target.displayName}`);
      }

      await target.uninstallPlugin(sourceId);
      await target.uninstall(sourceId);
    },

    async isInstalledHookCurrent(sourceId) {
      const target = options.targetRegistry.get(sourceId);
      if (!target?.isInstalledHookCurrent) return true;
      return target.isInstalledHookCurrent();
    },

    async detectMemoryPluginConflicts() {
      const conflicts: MemoryPluginConflict[] = [];
      for (const target of options.targetRegistry.list()) {
        const conflict = await target.detectMemoryPluginConflict?.();
        if (conflict) {
          conflicts.push(conflict);
        }
      }
      return conflicts;
    }
  };
}
