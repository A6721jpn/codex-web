import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { CodexWebDatabase } from "./db.ts";

export type CanonicalWorkspacePath = {
  canonicalPath: string;
  exists: boolean;
  isSymlink: boolean;
  realPath?: string;
};

export type WorkspaceRecord = CanonicalWorkspacePath & {
  id: number;
  lastOpenedAt: number;
  trustState: "trusted" | "untrusted";
};

export type WorkspacePathValidation =
  | { ok: true }
  | { ok: false; reason: string };

const RESERVED_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export async function canonicalizeWorkspacePath(inputPath: string): Promise<CanonicalWorkspacePath> {
  const absolutePath = path.resolve(inputPath);
  const normalized = normalizeWindowsPath(absolutePath);
  let stats;
  try {
    stats = await lstat(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return {
      canonicalPath: normalized,
      exists: false,
      isSymlink: false,
    };
  }

  const resolved = normalizeWindowsPath(await realpath(normalized));
  return {
    canonicalPath: resolved,
    exists: true,
    isSymlink: stats.isSymbolicLink(),
    realPath: resolved,
  };
}

export function validateWorkspacePath(inputPath: string): WorkspacePathValidation {
  const normalized = normalizeWindowsPath(path.resolve(inputPath));
  const upper = normalized.toUpperCase();
  if (inputPath.startsWith("\\\\") || upper.startsWith("\\\\?\\") || upper.startsWith("\\\\.\\") || upper.startsWith("//")) {
    return { ok: false, reason: "UNC and device paths are blocked" };
  }
  if (/^[A-Z]:\\?$/.test(upper)) {
    return { ok: false, reason: "Drive roots are blocked" };
  }
  if (upper === "C:\\WINDOWS" || upper.startsWith("C:\\WINDOWS\\")) {
    return { ok: false, reason: "Windows system roots are blocked" };
  }
  const home = normalizeWindowsPath(homedir()).toUpperCase();
  for (const sensitive of [".SSH", ".GNUPG", ".AWS", ".AZURE", ".KUBE"]) {
    if (upper === `${home}\\${sensitive}` || upper.startsWith(`${home}\\${sensitive}\\`)) {
      return { ok: false, reason: "Sensitive user profile roots are blocked" };
    }
  }
  if (hasReservedDeviceName(normalized)) {
    return { ok: false, reason: "Reserved Windows device names are blocked" };
  }
  if (hasAlternateDataStreamShape(normalized)) {
    return { ok: false, reason: "Alternate data stream-like paths are blocked" };
  }
  return { ok: true };
}

export class WorkspaceStore {
  #db: CodexWebDatabase;
  #now: () => number;

  constructor(db: CodexWebDatabase, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  async open(inputPath: string): Promise<WorkspaceRecord> {
    const policy = validateWorkspacePath(inputPath);
    if (!policy.ok) {
      throw new Error(policy.reason);
    }
    const canonical = await canonicalizeWorkspacePath(inputPath);
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO workspaces (
          canonical_path, display_path, exists_flag, real_path, is_symlink, created_at, updated_at, last_opened_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_path) DO UPDATE SET
          display_path = excluded.display_path,
          exists_flag = excluded.exists_flag,
          real_path = excluded.real_path,
          is_symlink = excluded.is_symlink,
          updated_at = excluded.updated_at,
          last_opened_at = excluded.last_opened_at`,
      )
      .run(
        canonical.canonicalPath,
        canonical.canonicalPath,
        canonical.exists ? 1 : 0,
        canonical.realPath ?? null,
        canonical.isSymlink ? 1 : 0,
        now,
        now,
        now,
      );
    const row = this.#db
      .prepare("SELECT id FROM workspaces WHERE canonical_path = ?")
      .get(canonical.canonicalPath) as { id: number };
    this.#db
      .prepare(
        `INSERT INTO workspace_policy (
          workspace_id, canonical_path, trust_state, default_permission_preset, last_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          canonical_path = excluded.canonical_path,
          last_checked_at = excluded.last_checked_at,
          updated_at = excluded.updated_at`,
      )
      .run(row.id, canonical.canonicalPath, "untrusted", "default", now, now, now);
    this.#db
      .prepare("INSERT INTO runtime_events (event_type, subject_type, subject_id, redacted_metadata_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace.opened", "workspace", String(row.id), JSON.stringify({ exists: canonical.exists, isSymlink: canonical.isSymlink }), now);
    return {
      ...canonical,
      id: row.id,
      lastOpenedAt: now,
      trustState: "untrusted",
    };
  }

  list(): WorkspaceRecord[] {
    return this.#db
      .prepare(
        `SELECT w.id, w.canonical_path, w.exists_flag, w.real_path, w.is_symlink, w.last_opened_at, p.trust_state
         FROM workspaces w
         JOIN workspace_policy p ON p.workspace_id = w.id
         ORDER BY w.last_opened_at DESC, w.id DESC`,
      )
      .all()
      .map((row) => this.#toRecord(row as unknown as WorkspaceRow));
  }

  getById(id: number): WorkspaceRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT w.id, w.canonical_path, w.exists_flag, w.real_path, w.is_symlink, w.last_opened_at, p.trust_state
         FROM workspaces w
         JOIN workspace_policy p ON p.workspace_id = w.id
         WHERE w.id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row ? this.#toRecord(row) : undefined;
  }

  #toRecord(row: WorkspaceRow): WorkspaceRecord {
    return {
      canonicalPath: row.canonical_path,
      exists: Boolean(row.exists_flag),
      id: row.id,
      isSymlink: Boolean(row.is_symlink),
      lastOpenedAt: row.last_opened_at,
      realPath: row.real_path,
      trustState: row.trust_state,
    };
  }
}

type WorkspaceRow = {
  canonical_path: string;
  exists_flag: number;
  id: number;
  is_symlink: number;
  last_opened_at: number;
  real_path?: string;
  trust_state: "trusted" | "untrusted";
};

function normalizeWindowsPath(inputPath: string): string {
  let normalized = path.normalize(inputPath).replaceAll("/", "\\");
  normalized = normalized.replace(/\\+$/, "");
  normalized = normalized.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  if (/^[A-Z]:$/.test(normalized)) {
    return `${normalized}\\`;
  }
  return normalized;
}

function hasReservedDeviceName(inputPath: string): boolean {
  return inputPath.split("\\").some((segment) => {
    const stem = segment.split(".")[0]?.toUpperCase();
    return stem ? RESERVED_DEVICE_NAMES.has(stem) : false;
  });
}

function hasAlternateDataStreamShape(inputPath: string): boolean {
  const withoutDrive = inputPath.replace(/^[A-Z]:\\/i, "");
  return withoutDrive.includes(":");
}
