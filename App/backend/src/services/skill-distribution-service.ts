/** Skill distribution service module. */
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  readAgentSkillInventory,
  readClaudeCodePluginSkills,
  readCodexPluginSkills,
  sharedSkillRootsForAgent,
  type AgentSkillInventoryItem
} from "@memmy/agent-source-core";
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

/** A skill shipped in an enabled plugin of the Agent; only its identity is read. */
export interface ScannedPluginSkill {
  sourceSkillId: string;
  sourceSkillPath: string;
  name: string;
  pluginId: string;
}

/**
 * Skills found for one Agent: its own skills directory plus shared skill
 * directories it loads. `complete` is false when any file could not be read.
 * `registrations` lists enabled plugin skills (Claude Code and Codex only).
 */
export interface AgentSkillScan {
  /** The Agent's root directory exists, so its skills are reconciled even when none are found. */
  rootFound?: boolean;
  complete: boolean;
  skills: ScannedAgentSkill[];
  errors: Array<{ path: string; reason: string }>;
  registrations?: ScannedPluginSkill[];
  registrationsComplete?: boolean;
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
  /** Home directory used to find shared skill directories; defaults to the user's home. */
  homeDirectory?: () => string;
}

/** Creates create skill distribution service. */
export function createSkillDistributionService(
  options: CreateSkillDistributionServiceOptions
): SkillDistributionService {
  async function scanSkills(sourceId: string): Promise<AgentSkillScan> {
    const target = options.targetRegistry.get(sourceId);
    const root = await target?.resolveRootDirectory();
    if (!root) return { rootFound: false, complete: true, skills: [], errors: [] };

    const inventories = [{ prefix: "", inventory: await readAgentSkillInventory(join(root, "skills")) }];
    // Skills from a shared directory belong to every Agent that loads it.
    for (const shared of sharedSkillRootsForAgent(sourceId, (options.homeDirectory ?? homedir)())) {
      inventories.push({ prefix: `shared:${shared.id}/`, inventory: await readAgentSkillInventory(shared.root) });
    }
    const plugins = sourceId === "claude_code"
      ? await readClaudeCodePluginSkills(root)
      : sourceId === "codex" ? await readCodexPluginSkills(root) : undefined;
    return {
      rootFound: true,
      complete: inventories.every(({ inventory }) => inventory.complete),
      errors: [...inventories.flatMap(({ inventory }) => inventory.errors), ...(plugins?.errors ?? [])],
      skills: inventories.flatMap(({ prefix, inventory }) => inventory.items.map((item) => scannedSkill(sourceId, prefix, item))),
      ...(plugins ? {
        registrations: plugins.items.map((plugin) => ({
          sourceSkillId: `plugin:${plugin.pluginId}/${basename(dirname(plugin.sourceSkillPath))}`,
          sourceSkillPath: plugin.sourceSkillPath,
          name: plugin.name,
          pluginId: plugin.pluginId
        })),
        registrationsComplete: plugins.complete
      } : {})
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

function scannedSkill(sourceId: string, prefix: string, item: AgentSkillInventoryItem): ScannedAgentSkill {
  return {
    sourceAgentId: sourceId,
    sourceSkillId: `${prefix}${item.sourceSkillId}`,
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
  };
}
