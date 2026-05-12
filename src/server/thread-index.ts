import type { CodexWebDatabase } from "./db.ts";

export const THREAD_SOURCE_KINDS = ["appServer", "cli", "vscode"] as const;

export type ThreadSourceKind = (typeof THREAD_SOURCE_KINDS)[number];
export type ThreadStatus = "active" | "archived" | "deleted" | "ephemeral" | "missing";

export type ThreadIndexEntry = {
  id: string;
  lastOpenedAt?: number;
  sourceKind: ThreadSourceKind;
  status: ThreadStatus;
  title?: string;
  updatedAt: number;
  workspaceId?: number;
  workspacePath?: string;
};

export type ThreadListPage = {
  data: ThreadIndexEntry[];
  nextCursor?: string;
};

export type ThreadListRequest = {
  cursor?: string;
  pageSize: number;
  sourceKinds: readonly ThreadSourceKind[];
};

export interface ThreadListAdapter {
  listThreads(request: ThreadListRequest): Promise<ThreadListPage>;
}

export type ThreadIndexListResult = {
  items: ThreadIndexEntry[];
  nextCursor?: string;
};

export type UiThreadState = {
  collapsed: boolean;
  lastOpenedAt?: number;
  pinned: boolean;
};

export class ThreadIndexStore {
  #db: CodexWebDatabase;
  #now: () => number;

  constructor(db: CodexWebDatabase, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  upsertMany(entries: ThreadIndexEntry[]): void {
    const now = this.#now();
    const statement = this.#db.prepare(
      `INSERT INTO thread_index (
        id, source_kind, status, title, workspace_id, workspace_path, updated_at, indexed_at,
        archived_at, missing_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_kind = excluded.source_kind,
        status = excluded.status,
        title = excluded.title,
        workspace_id = excluded.workspace_id,
        workspace_path = excluded.workspace_path,
        updated_at = excluded.updated_at,
        indexed_at = excluded.indexed_at,
        archived_at = excluded.archived_at,
        missing_at = excluded.missing_at,
        deleted_at = excluded.deleted_at`,
    );
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        statement.run(
          entry.id,
          entry.sourceKind,
          entry.status,
          entry.title ?? null,
          entry.workspaceId ?? null,
          entry.workspacePath ?? null,
          entry.updatedAt,
          now,
          entry.status === "archived" ? now : null,
          entry.status === "missing" ? now : null,
          entry.status === "deleted" ? now : null,
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  list(input: { cursor?: string; limit: number; search?: string }): ThreadIndexListResult {
    const limit = Math.max(1, Math.min(input.limit, 100));
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const search = input.search?.trim();
    const searchPattern = search ? `%${escapeLike(search)}%` : undefined;
    const rows = (
      cursor && searchPattern
        ? this.#db
            .prepare(
              `SELECT t.id, t.source_kind, t.status, t.title, t.workspace_id, t.workspace_path, t.updated_at, u.last_opened_at
               FROM thread_index t
               LEFT JOIN ui_thread_state u ON u.thread_id = t.id
               WHERE (t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))
                 AND (t.id LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\' OR t.workspace_path LIKE ? ESCAPE '\\')
               ORDER BY t.updated_at DESC, t.id DESC
               LIMIT ?`,
            )
            .all(cursor.updatedAt, cursor.updatedAt, cursor.id, searchPattern, searchPattern, searchPattern, limit + 1)
        : cursor
        ? this.#db
            .prepare(
              `SELECT t.id, t.source_kind, t.status, t.title, t.workspace_id, t.workspace_path, t.updated_at, u.last_opened_at
               FROM thread_index t
               LEFT JOIN ui_thread_state u ON u.thread_id = t.id
               WHERE t.updated_at < ? OR (t.updated_at = ? AND t.id < ?)
               ORDER BY t.updated_at DESC, t.id DESC
               LIMIT ?`,
            )
            .all(cursor.updatedAt, cursor.updatedAt, cursor.id, limit + 1)
        : searchPattern
          ? this.#db
              .prepare(
                `SELECT t.id, t.source_kind, t.status, t.title, t.workspace_id, t.workspace_path, t.updated_at, u.last_opened_at
                 FROM thread_index t
                 LEFT JOIN ui_thread_state u ON u.thread_id = t.id
                 WHERE t.id LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\' OR t.workspace_path LIKE ? ESCAPE '\\'
                 ORDER BY t.updated_at DESC, t.id DESC
                 LIMIT ?`,
              )
              .all(searchPattern, searchPattern, searchPattern, limit + 1)
        : this.#db
            .prepare(
              `SELECT t.id, t.source_kind, t.status, t.title, t.workspace_id, t.workspace_path, t.updated_at, u.last_opened_at
               FROM thread_index t
               LEFT JOIN ui_thread_state u ON u.thread_id = t.id
               ORDER BY t.updated_at DESC, t.id DESC
               LIMIT ?`,
            )
            .all(limit + 1)
    ) as ThreadIndexRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(fromRow),
      nextCursor: rows.length > limit && last ? encodeCursor({ id: last.id, updatedAt: last.updated_at }) : undefined,
    };
  }

  setUiState(threadId: string, state: UiThreadState): void {
    this.#db
      .prepare(
        `INSERT INTO ui_thread_state (thread_id, pinned, collapsed, last_opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           pinned = excluded.pinned,
           collapsed = excluded.collapsed,
           last_opened_at = excluded.last_opened_at,
           updated_at = excluded.updated_at`,
      )
      .run(threadId, state.pinned ? 1 : 0, state.collapsed ? 1 : 0, state.lastOpenedAt ?? null, this.#now());
  }

  getUiState(threadId: string): UiThreadState | undefined {
    const row = this.#db.prepare("SELECT pinned, collapsed, last_opened_at FROM ui_thread_state WHERE thread_id = ?").get(threadId) as
      | { collapsed: number; last_opened_at: number | null; pinned: number }
      | undefined;
    return row
      ? {
          collapsed: Boolean(row.collapsed),
          lastOpenedAt: row.last_opened_at ?? undefined,
          pinned: Boolean(row.pinned),
        }
      : undefined;
  }
}

export async function syncThreadIndex(
  store: ThreadIndexStore,
  adapter: ThreadListAdapter,
  options: { pageSize: number },
): Promise<{ upserted: number }> {
  let cursor: string | undefined;
  let upserted = 0;
  do {
    const page = await adapter.listThreads({
      cursor,
      pageSize: options.pageSize,
      sourceKinds: THREAD_SOURCE_KINDS,
    });
    store.upsertMany(page.data);
    upserted += page.data.length;
    cursor = page.nextCursor;
  } while (cursor);
  return { upserted };
}

export class FakeThreadListAdapter implements ThreadListAdapter {
  calls: ThreadListRequest[] = [];
  #pages: ThreadListPage[];

  constructor(pages: ThreadListPage[]) {
    this.#pages = pages;
  }

  async listThreads(request: ThreadListRequest): Promise<ThreadListPage> {
    this.calls.push({ ...request, sourceKinds: [...request.sourceKinds] });
    return this.#pages.shift() ?? { data: [] };
  }
}

type ThreadIndexRow = {
  id: string;
  last_opened_at: number | null;
  source_kind: ThreadSourceKind;
  status: ThreadStatus;
  title: string | null;
  updated_at: number;
  workspace_id: number | null;
  workspace_path: string | null;
};

function fromRow(row: ThreadIndexRow): ThreadIndexEntry {
  return {
    id: row.id,
    lastOpenedAt: row.last_opened_at ?? undefined,
    sourceKind: row.source_kind,
    status: row.status,
    title: row.title ?? undefined,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function encodeCursor(cursor: { id: string; updatedAt: number }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { id: string; updatedAt: number } {
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown; updatedAt?: unknown };
  if (typeof decoded.id !== "string" || typeof decoded.updatedAt !== "number") {
    throw new Error("Invalid thread cursor");
  }
  return { id: decoded.id, updatedAt: decoded.updatedAt };
}
