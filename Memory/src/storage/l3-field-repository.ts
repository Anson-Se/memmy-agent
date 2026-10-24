import type Database from "better-sqlite3";
import { canonicalJson, sha256Hex } from "../contracts/index.js";
import type {
  L3ItemEvidence,
  L3ItemKind,
  L3ItemRecord,
  L3UnitKind,
  L3UnitRecord,
  L3UserProject,
  ProjectIdentitySource,
  ResolvedProject
} from "../service/l3-field/types.js";
import type { MemoryRow } from "../types.js";
import { newId } from "../utils/id.js";
import { parseJson, toJson } from "../utils/json.js";
import { nowIso } from "../utils/time.js";
import type { MemoryRepository } from "./repositories.js";

const SNAPSHOT_SOURCE = "worker.l3_field.v1";

interface SqlUnitRow {
  unit_key: string;
  user_id: string;
  machine_id: string;
  kind: L3UnitKind;
  project_identity: string | null;
  display_name: string | null;
  identity_source: ProjectIdentitySource | null;
  checkout_root: string | null;
  profile_text: string | null;
  profile_fingerprint: string | null;
  snapshot_memory_id: string | null;
  deleted_at: string | null;
  next_seq: number;
  created_at: string;
  updated_at: string;
}

interface SqlItemRow {
  id: string;
  unit_key: string;
  kind: L3ItemKind;
  content: string;
  evidence_json: string;
  evidence_at: string;
  last_confirmed_at: string;
  status: "active" | "inactive";
  replaced_by: string | null;
  removed_evidence_at: string | null;
  inactive_at: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export function l3UnitKey(input: {
  userId: string;
  machineId: string;
  kind: L3UnitKind;
  identity: string | null;
}): string {
  return `l3u:${sha256Hex(canonicalJson({
    userId: input.userId,
    machineId: input.machineId,
    kind: input.kind,
    identity: input.identity
  }))}`;
}

export function l3UnitSnapshotMemoryKey(unitKey: string): string {
  return `world_model:l3_field:${unitKey}`;
}

export { isL3FieldSnapshotMemory, l3FieldSnapshotUnitKey } from "../service/l3-field/snapshot-memory.js";

/** Renders one unit (profile plus active items) as the text stored in its snapshot memory. */
export function renderL3UnitSnapshot(unit: L3UnitRecord, items: readonly L3ItemRecord[]): string {
  const facts = items.filter((item) => item.kind === "env_fact");
  const constraints = items.filter((item) => item.kind === "project_constraint");
  const sections: string[] = [];
  if (unit.profileText?.trim()) sections.push(`## 环境画像\n${unit.profileText.trim()}`);
  if (facts.length) sections.push(`## 环境事实\n${facts.map((item) => `- ${item.content}`).join("\n")}`);
  if (constraints.length) sections.push(`## 项目约束\n${constraints.map((item) => `- ${item.content}`).join("\n")}`);
  return sections.join("\n\n");
}

export class L3FieldRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly memories: MemoryRepository
  ) {}

  getUnit(unitKey: string): L3UnitRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM l3_units WHERE unit_key = ?`).get(unitKey) as SqlUnitRow | undefined;
    return row ? unitFromSql(row) : undefined;
  }

  ensureMachineUnit(input: { userId: string; machineId: string; at?: string }): L3UnitRecord {
    const unitKey = l3UnitKey({ userId: input.userId, machineId: input.machineId, kind: "machine", identity: null });
    const at = input.at ?? nowIso();
    this.db.prepare(
      `INSERT INTO l3_units (unit_key, user_id, machine_id, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'machine', ?, ?)
       ON CONFLICT(unit_key) DO NOTHING`
    ).run(unitKey, input.userId, input.machineId, at, at);
    return this.getUnit(unitKey)!;
  }

  ensureProjectUnit(input: {
    userId: string;
    machineId: string;
    project: ResolvedProject;
    at?: string;
  }): L3UnitRecord {
    const unitKey = l3UnitKey({
      userId: input.userId,
      machineId: input.machineId,
      kind: "project",
      identity: input.project.identity
    });
    const at = input.at ?? nowIso();
    this.db.prepare(
      `INSERT INTO l3_units (
         unit_key, user_id, machine_id, kind, project_identity, display_name,
         identity_source, checkout_root, created_at, updated_at
       ) VALUES (?, ?, ?, 'project', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(unit_key) DO UPDATE SET
         display_name = excluded.display_name,
         identity_source = excluded.identity_source,
         checkout_root = excluded.checkout_root,
         updated_at = CASE
           WHEN l3_units.display_name IS excluded.display_name
            AND l3_units.identity_source IS excluded.identity_source
            AND l3_units.checkout_root IS excluded.checkout_root
           THEN l3_units.updated_at ELSE excluded.updated_at END`
    ).run(
      unitKey,
      input.userId,
      input.machineId,
      input.project.identity,
      input.project.displayName,
      input.project.source,
      input.project.checkoutRoot,
      at,
      at
    );
    return this.getUnit(unitKey)!;
  }

  activeItems(unitKey: string): L3ItemRecord[] {
    return (this.db.prepare(
      `SELECT * FROM l3_items WHERE unit_key = ? AND status = 'active'
       ORDER BY created_at ASC, id ASC`
    ).all(unitKey) as SqlItemRow[]).map(itemFromSql);
  }

  getItem(id: string): L3ItemRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM l3_items WHERE id = ?`).get(id) as SqlItemRow | undefined;
    return row ? itemFromSql(row) : undefined;
  }

  insertItem(input: {
    unitKey: string;
    kind: L3ItemKind;
    content: string;
    evidence: L3ItemEvidence;
    evidenceAt: string;
    batchId?: string;
    at?: string;
  }): L3ItemRecord {
    const id = newId("l3item");
    const at = input.at ?? nowIso();
    this.db.prepare(
      `INSERT INTO l3_items (
         id, unit_key, kind, content, evidence_json, evidence_at, last_confirmed_at,
         status, batch_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    ).run(
      id,
      input.unitKey,
      input.kind,
      input.content,
      toJson(input.evidence),
      input.evidenceAt,
      input.evidenceAt,
      input.batchId ?? null,
      at,
      at
    );
    return this.getItem(id)!;
  }

  /**
   * `removedEvidenceAt` is when the evidence that removed it happened (a delete or replace op);
   * evictions and unit resets leave it empty.
   */
  inactivateItem(id: string, input: { replacedBy?: string; removedEvidenceAt?: string; at?: string }): void {
    const at = input.at ?? nowIso();
    this.db.prepare(
      `UPDATE l3_items
       SET status = 'inactive', replaced_by = ?, removed_evidence_at = ?, inactive_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`
    ).run(input.replacedBy ?? null, input.removedEvidenceAt ?? null, at, at, id);
  }

  /** Moves the last-confirmed time forward only; an older confirmation never rewinds it. */
  confirmItem(id: string, confirmedAt: string, at = nowIso()): void {
    this.db.prepare(
      `UPDATE l3_items
       SET last_confirmed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND last_confirmed_at < ?`
    ).run(confirmedAt, at, id, confirmedAt);
  }

  /**
   * Creates or updates the snapshot memory for one unit. A change to a machine
   * unit also bumps the snapshot version of every project on the same machine,
   * because session context renders the machine together with the project.
   */
  refreshSnapshot(unitKey: string, at = nowIso()): MemoryRow {
    const unit = this.getUnit(unitKey);
    if (!unit) throw new Error(`L3 unit not found: ${unitKey}`);
    const saved = this.writeSnapshot(unit, at);
    if (unit.kind === "machine") {
      const projects = (this.db.prepare(
        `SELECT * FROM l3_units
         WHERE user_id = ? AND machine_id = ? AND kind = 'project'
           AND snapshot_memory_id IS NOT NULL AND deleted_at IS NULL`
      ).all(unit.userId, unit.machineId) as SqlUnitRow[]).map(unitFromSql);
      for (const project of projects) this.writeSnapshot(project, at);
    }
    return saved;
  }

  /**
   * Deleting a unit's L3 resets it rather than disabling it: items become
   * inactive, the profile and snapshot link are cleared, and `deleted_at`
   * records when, so work queued before the reset is discarded while later
   * conversations build the unit up again.
   */
  markUnitDeleted(unitKey: string, at = nowIso()): void {
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE l3_units
         SET deleted_at = ?, snapshot_memory_id = NULL, profile_text = NULL, profile_fingerprint = NULL, updated_at = ?
         WHERE unit_key = ?`
      ).run(at, at, unitKey);
      this.db.prepare(
        `UPDATE l3_items
         SET status = 'inactive', inactive_at = ?, updated_at = ?
         WHERE unit_key = ? AND status = 'active'`
      ).run(at, at, unitKey);
    })();
  }

  /** Deletes items that became inactive before `before`; active items are never touched. */
  purgeInactive(before: string): number {
    return this.db.prepare(
      `DELETE FROM l3_items WHERE status = 'inactive' AND inactive_at < ?`
    ).run(before).changes;
  }

  listUserProjects(userId: string): L3UserProject[] {
    return (this.db.prepare(
      `SELECT root_path, name FROM l3_user_projects WHERE user_id = ? ORDER BY root_path ASC`
    ).all(userId) as Array<{ root_path: string; name: string }>)
      .map((row) => ({ rootPath: row.root_path, name: row.name }));
  }

  /** Replaces the whole list; the latest push wins. */
  replaceUserProjects(userId: string, projects: readonly L3UserProject[], at = nowIso()): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM l3_user_projects WHERE user_id = ?`).run(userId);
      const insert = this.db.prepare(
        `INSERT INTO l3_user_projects (user_id, root_path, name, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, root_path) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
      );
      for (const project of projects) insert.run(userId, project.rootPath, project.name, at);
    })();
  }

  /** Profile text comes only from code probes (machine) or scan summaries (project). */
  setProfile(unitKey: string, profile: { text: string | null; fingerprint: string }, at = nowIso()): void {
    this.db.prepare(
      `UPDATE l3_units SET profile_text = ?, profile_fingerprint = ?, updated_at = ? WHERE unit_key = ?`
    ).run(profile.text, profile.fingerprint, at, unitKey);
  }

  /** Throwaway task roots Memmy itself creates (they are never projects); stored with the project list. */
  getStandaloneRoots(userId: string): string[] {
    const row = this.db.prepare(`SELECT value_json FROM runtime_kv WHERE key = ?`)
      .get(standaloneRootsKey(userId)) as { value_json: string } | undefined;
    const value = row ? parseJson<unknown>(row.value_json, []) : [];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  setStandaloneRoots(userId: string, roots: readonly string[], at = nowIso()): void {
    this.db.prepare(
      `INSERT INTO runtime_kv (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(standaloneRootsKey(userId), toJson([...roots]), at);
  }

  private writeSnapshot(unit: L3UnitRecord, at: string): MemoryRow {
    const items = this.activeItems(unit.unitKey);
    const memoryValue = renderL3UnitSnapshot(unit, items);
    const existing = unit.snapshotMemoryId ? this.memories.get(unit.snapshotMemoryId) : undefined;
    const title = unit.kind === "machine" ? "本机场域认知" : `项目场域认知：${unit.displayName ?? unit.projectIdentity}`;
    const tags = ["world_model", "l3_field", `scope:${unit.kind}`];
    const info: Record<string, unknown> = { l3_field_unit_key: unit.unitKey };
    // Rewriting a snapshot keeps the user's archive; only the user unarchives it.
    const status = existing?.status === "archived" ? "archived" as const : "activated" as const;
    const bullets = (kind: L3ItemKind) => {
      const lines = items.filter((item) => item.kind === kind).map((item) => `- ${item.content}`);
      return lines.length ? lines.join("\n") : null;
    };
    // Shape the desktop "world model" page already understands (it only reads schema-2 fields).
    const legacyFields = {
      general_rules_and_safety_constraints: null,
      project_environment_profile: unit.profileText?.trim() ? unit.profileText.trim() : null,
      project_contract: bullets("project_constraint"),
      domain_knowledge: bullets("env_fact")
    };
    const memory: MemoryRow = {
      id: existing?.id ?? newId("memory"),
      timeline: existing?.timeline ?? at,
      userId: unit.userId,
      memoryType: "LongTermMemory",
      status,
      visibility: "private",
      memoryKey: l3UnitSnapshotMemoryKey(unit.unitKey),
      memoryValue,
      tags,
      info,
      properties: {
        memory_type: "LongTermMemory",
        status,
        tags,
        info: { ...info },
        internal_info: {
          memory_layer: "L3",
          memory_kind: "world_model",
          schema_version: 3,
          source: SNAPSHOT_SOURCE,
          title,
          summary: [...memoryValue.replace(/\s+/gu, " ").trim()].slice(0, 240).join(""),
          body: memoryValue,
          l3_field: {
            unit_key: unit.unitKey,
            kind: unit.kind,
            display_name: unit.displayName ?? null,
            identity_source: unit.identitySource ?? null,
            legacy_fields: legacyFields
          }
        }
      },
      memoryLayer: "L3",
      contentHash: sha256Hex(memoryValue),
      version: existing?.version ?? 1,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      deletedAt: null
    };
    const saved = existing ? this.memories.update(memory) : this.memories.insert(memory);
    if (!existing) {
      this.db.prepare(
        `UPDATE l3_units SET snapshot_memory_id = ?, updated_at = ? WHERE unit_key = ?`
      ).run(saved.id, at, unit.unitKey);
    }
    this.db.prepare(
      `INSERT INTO memory_change_log (
         memory_id, namespace_id, kind, op, entity_id, user_id,
         change_type, version, before_json, after_json, source, created_at
       ) VALUES (?, ?, 'world_model', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      saved.id,
      unit.unitKey,
      existing ? "updated" : "created",
      saved.id,
      unit.userId,
      existing ? "l3_field_snapshot_update" : "l3_field_snapshot_create",
      saved.version,
      existing ? toJson(existing) : null,
      toJson(saved),
      SNAPSHOT_SOURCE,
      at
    );
    return saved;
  }
}

function standaloneRootsKey(userId: string): string {
  return `l3_field.standalone_roots:${userId}`;
}

function unitFromSql(row: SqlUnitRow): L3UnitRecord {
  return {
    unitKey: row.unit_key,
    userId: row.user_id,
    machineId: row.machine_id,
    kind: row.kind,
    projectIdentity: row.project_identity ?? undefined,
    displayName: row.display_name ?? undefined,
    identitySource: row.identity_source ?? undefined,
    checkoutRoot: row.checkout_root ?? undefined,
    profileText: row.profile_text ?? undefined,
    profileFingerprint: row.profile_fingerprint ?? undefined,
    snapshotMemoryId: row.snapshot_memory_id ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    nextSeq: row.next_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function itemFromSql(row: SqlItemRow): L3ItemRecord {
  const evidence = parseJson<Partial<L3ItemEvidence>>(row.evidence_json, {});
  return {
    id: row.id,
    unitKey: row.unit_key,
    kind: row.kind,
    content: row.content,
    evidence: {
      fragmentIds: Array.isArray(evidence.fragmentIds) ? evidence.fragmentIds : [],
      l1MemoryIds: Array.isArray(evidence.l1MemoryIds) ? evidence.l1MemoryIds : []
    },
    evidenceAt: row.evidence_at,
    lastConfirmedAt: row.last_confirmed_at,
    status: row.status,
    replacedBy: row.replaced_by ?? undefined,
    removedEvidenceAt: row.removed_evidence_at ?? undefined,
    inactiveAt: row.inactive_at ?? undefined,
    batchId: row.batch_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
