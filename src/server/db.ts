import { DatabaseSync } from "node:sqlite";

export type CodexWebDatabase = DatabaseSync;

export function openDatabase(path: string): CodexWebDatabase {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function applyMigrations(db: CodexWebDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  for (const migration of MIGRATIONS) {
    const existing = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version);
    if (existing) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

type Migration = {
  name: string;
  up: (db: CodexWebDatabase) => void;
  version: number;
};

const MIGRATIONS: Migration[] = [
  {
    name: "m1_security_baseline",
    version: 1,
    up: (db) => {
      db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id_hash TEXT NOT NULL UNIQUE,
      device_session_id_hash TEXT NOT NULL,
      csrf_token_hash TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      idle_expires_at INTEGER NOT NULL,
      absolute_expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS connection_epochs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT NOT NULL UNIQUE,
      epoch INTEGER NOT NULL,
      fencing_token_hash TEXT NOT NULL,
      device_session_id_hash TEXT NOT NULL,
      device_label TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revocation_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS active_connection (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      connection_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      device_session_id_hash TEXT NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      subject TEXT PRIMARY KEY,
      failed_count INTEGER NOT NULL,
      last_failed_at INTEGER NOT NULL,
      next_allowed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ws_tickets (
      ticket_hash TEXT PRIMARY KEY,
      session_id_hash TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
  `);
    },
  },
  {
    name: "m2_workspace_thread_index",
    version: 2,
    up: (db) => {
      db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_path TEXT NOT NULL UNIQUE,
      display_path TEXT NOT NULL,
      exists_flag INTEGER NOT NULL CHECK (exists_flag IN (0, 1)),
      real_path TEXT,
      is_symlink INTEGER NOT NULL DEFAULT 0 CHECK (is_symlink IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_policy (
      workspace_id INTEGER PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      trust_state TEXT NOT NULL CHECK (trust_state IN ('untrusted', 'trusted')),
      default_permission_preset TEXT NOT NULL CHECK (default_permission_preset IN ('default', 'auto_review')),
      last_checked_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS thread_index (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('appServer', 'cli', 'vscode')),
      status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'ephemeral', 'missing', 'deleted')),
      title TEXT,
      workspace_id INTEGER,
      workspace_path TEXT,
      updated_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      archived_at INTEGER,
      missing_at INTEGER,
      deleted_at INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_thread_index_updated ON thread_index(updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_thread_index_source ON thread_index(source_kind);
    CREATE INDEX IF NOT EXISTS idx_thread_index_status ON thread_index(status);

    CREATE TABLE IF NOT EXISTS ui_thread_state (
      thread_id TEXT PRIMARY KEY,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
      last_opened_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES thread_index(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runtime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      subject_type TEXT,
      subject_id TEXT,
      redacted_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);
    },
  },
  {
    name: "m3_app_server_runtime",
    version: 3,
    up: (db) => {
      db.exec(`
    CREATE TABLE IF NOT EXISTS app_server_runtime (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      codex_bin TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL CHECK (status IN ('idle', 'starting', 'ready', 'failed', 'exited')),
      started_at INTEGER,
      initialized_at INTEGER,
      exited_at INTEGER,
      last_error_code TEXT,
      redacted_stdout_tail TEXT NOT NULL DEFAULT '',
      redacted_stderr_tail TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `);
    },
  },
  {
    name: "m4_approval_audit",
    version: 4,
    up: (db) => {
      db.exec(`
    CREATE TABLE IF NOT EXISTS approval_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      app_request_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'permission', 'elicitation', 'unknown')),
      status TEXT NOT NULL,
      decision TEXT CHECK (decision IN ('approve', 'reject', 'cancel')),
      scope TEXT CHECK (scope IN ('turn', 'session')),
      connection_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      redacted_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approval_events_approval_id ON approval_events(approval_id, id);
    CREATE INDEX IF NOT EXISTS idx_approval_events_created ON approval_events(created_at DESC, id DESC);
  `);
    },
  },
];
