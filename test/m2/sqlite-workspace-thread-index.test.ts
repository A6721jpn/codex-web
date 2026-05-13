import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexWebApp } from "../../src/server/app.ts";
import { applyMigrations, openDatabase } from "../../src/server/db.ts";
import {
  canonicalizeWorkspacePath,
  validateWorkspacePath,
  WorkspaceStore,
} from "../../src/server/workspace.ts";
import {
  FakeThreadListAdapter,
  syncThreadIndex,
  THREAD_SOURCE_KINDS,
  ThreadIndexStore,
} from "../../src/server/thread-index.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-m2-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

test("M2 migrations are idempotent and preserve M1 tables", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "m2.sqlite"));
    applyMigrations(db);
    applyMigrations(db);

    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => (row as { version: number }).version);
    assert.deepEqual(versions, [1, 2, 3, 4]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const table of ["settings", "device_sessions", "workspaces", "workspace_policy", "thread_index", "ui_thread_state", "runtime_events"]) {
      assert(tables.includes(table), `${table} should exist`);
    }
    db.close();
  });
});

test("SQLite connections enable WAL, busy_timeout, and foreign_keys", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "pragma.sqlite"));
    applyMigrations(db);

    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase(), "wal");
    assert.equal((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    db.close();
  });
});

test("SQLite foreign keys reject orphan workspace policy rows", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "fk.sqlite"));
    applyMigrations(db);

    assert.throws(() => {
      db.prepare(
        "INSERT INTO workspace_policy (workspace_id, canonical_path, trust_state, default_permission_preset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(123, "C:\\missing", "untrusted", "default", 1, 1);
    }, /constraint/i);
    db.close();
  });
});

test("SQLite busy_timeout lets a second connection wait for a short write lock", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "busy.sqlite");
    const first = openDatabase(path);
    const second = openDatabase(path);
    applyMigrations(first);
    applyMigrations(second);

    first.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    assert.throws(() => {
      second.prepare("INSERT INTO runtime_events (event_type, redacted_metadata_json, created_at) VALUES (?, ?, ?)").run("locked", "{}", Date.now());
    }, /busy|locked/i);
    assert(Date.now() - started >= 100);
    first.exec("ROLLBACK");
    first.close();
    second.close();
  });
});

test("workspace canonicalization normalizes relative paths, drive casing, separators, spaces, and Japanese names", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "Project With Spaces", "日本語");
    await mkdir(root, { recursive: true });
    const lowerDrive = root.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    const relative = join(root, "..", "日本語", ".");

    const canonical = await canonicalizeWorkspacePath(relative);
    const same = await canonicalizeWorkspacePath(`${lowerDrive}\\`);
    assert.equal(canonical.canonicalPath, same.canonicalPath);
    assert.match(canonical.canonicalPath, /^[A-Z]:\\/);
    assert(!canonical.canonicalPath.endsWith("\\"));
    assert.equal(canonical.exists, true);
  });
});

test("workspace canonicalization records missing paths without creating them", async () => {
  await withTempDir(async (dir) => {
    const missing = join(dir, "missing-workspace");
    const canonical = await canonicalizeWorkspacePath(missing);

    assert.equal(canonical.exists, false);
    assert.equal(canonical.realPath, undefined);
    assert.equal(canonical.canonicalPath.endsWith("missing-workspace"), true);
  });
});

test("workspace path policy blocks conservative Windows-dangerous paths", () => {
  for (const blocked of [
    "\\\\server\\share\\repo",
    "\\\\?\\C:\\repo",
    "C:\\Windows",
    "C:\\Windows\\System32",
    "C:\\",
    "C:\\repo\\CON",
    "C:\\repo\\file.txt:secret",
    "C:\\Users\\aokuni\\.ssh",
  ]) {
    assert.equal(validateWorkspacePath(blocked).ok, false, blocked);
  }
});

test("workspace store persists canonical metadata and redacted audit skeleton", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "repo");
    await mkdir(root);
    const db = openDatabase(join(dir, "workspace.sqlite"));
    applyMigrations(db);
    try {
      const store = new WorkspaceStore(db, { now: () => 10 });

      const opened = await store.open(root);
      assert.equal(opened.exists, true);
      assert.equal(store.list().length, 1);

      const audit = db.prepare("SELECT event_type, redacted_metadata_json FROM runtime_events").all() as Array<{
        event_type: string;
        redacted_metadata_json: string;
      }>;
      assert.equal(audit[0].event_type, "workspace.opened");
      assert(!JSON.stringify(audit).includes(root));
    } finally {
      db.close();
    }
  });
});

test("thread source kinds are explicit and stable", () => {
  assert.deepEqual(THREAD_SOURCE_KINDS, ["appServer", "cli", "vscode"]);
});

test("thread index sync requests explicit sourceKinds and follows pagination cursors", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "threads.sqlite"));
    applyMigrations(db);
    const adapter = new FakeThreadListAdapter([
      {
        data: [{ id: "t1", title: "first", sourceKind: "appServer", updatedAt: 100, status: "active" }],
        nextCursor: "page-2",
      },
      {
        data: [{ id: "t2", title: "second", sourceKind: "cli", updatedAt: 200, status: "archived" }],
      },
    ]);

    const result = await syncThreadIndex(new ThreadIndexStore(db, { now: () => 1_000 }), adapter, { pageSize: 1 });
    assert.equal(result.upserted, 2);
    assert.deepEqual(adapter.calls.map((call) => call.sourceKinds), [THREAD_SOURCE_KINDS, THREAD_SOURCE_KINDS]);
    assert.deepEqual(adapter.calls.map((call) => call.cursor), [undefined, "page-2"]);
    db.close();
  });
});

test("thread index stores metadata states without body content", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "metadata.sqlite"));
    applyMigrations(db);
    const store = new ThreadIndexStore(db, { now: () => 2_000 });

    store.upsertMany([
      { id: "a", sourceKind: "appServer", status: "active", title: "Active", updatedAt: 1 },
      { id: "e", sourceKind: "vscode", status: "ephemeral", title: "Ephemeral", updatedAt: 2 },
      { id: "m", sourceKind: "cli", status: "missing", title: "Missing", updatedAt: 3 },
      { id: "d", sourceKind: "cli", status: "deleted", title: "Deleted", updatedAt: 4 },
    ]);

    assert.deepEqual(
      store.list({ limit: 10 }).items.map((thread) => thread.status),
      ["deleted", "missing", "ephemeral", "active"],
    );
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM thread_index").all()).includes("prompt"), false);
    db.close();
  });
});

test("thread list pagination returns cursor windows from local index", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "list.sqlite"));
    applyMigrations(db);
    const store = new ThreadIndexStore(db, { now: () => 3_000 });
    store.upsertMany([
      { id: "t1", sourceKind: "appServer", status: "active", title: "one", updatedAt: 10 },
      { id: "t2", sourceKind: "appServer", status: "active", title: "two", updatedAt: 20 },
      { id: "t3", sourceKind: "appServer", status: "active", title: "three", updatedAt: 30 },
    ]);

    const first = store.list({ limit: 2 });
    assert.deepEqual(first.items.map((thread) => thread.id), ["t3", "t2"]);
    assert.equal(typeof first.nextCursor, "string");
    const second = store.list({ cursor: first.nextCursor, limit: 2 });
    assert.deepEqual(second.items.map((thread) => thread.id), ["t1"]);
    assert.equal(second.nextCursor, undefined);
    db.close();
  });
});

test("ui thread state persists pinned collapsed and last-opened metadata only", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "ui.sqlite"));
    applyMigrations(db);
    const store = new ThreadIndexStore(db, { now: () => 4_000 });
    store.upsertMany([{ id: "t1", sourceKind: "appServer", status: "active", title: "one", updatedAt: 10 }]);
    store.setUiState("t1", { collapsed: true, lastOpenedAt: 5_000, pinned: true });

    assert.deepEqual(store.getUiState("t1"), { collapsed: true, lastOpenedAt: 5_000, pinned: true });
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('ui_thread_state')")
      .all()
      .map((row) => (row as { name: string }).name);
    assert(!columns.some((name) => /prompt|message|reasoning|output|diff|payload/i.test(name)));
    db.close();
  });
});

test("SQLite schema does not contain body, reasoning, command output, diff, or raw payload columns", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "privacy.sqlite"));
    applyMigrations(db);
    const columns = db
      .prepare(
        `SELECT m.name AS table_name, p.name AS column_name
         FROM sqlite_master m, pragma_table_info(m.name) p
         WHERE m.type = 'table'`,
      )
      .all() as Array<{ column_name: string; table_name: string }>;
    assert.deepEqual(
      columns.filter((column) => /prompt|agent_message|reasoning|command_output|diff|raw_payload|body|content/i.test(column.column_name)),
      [],
    );
    db.close();
  });
});

test("workspace API is authenticated, active-lease gated, CSRF protected, and semantic", async () => {
  await withTempDir(async (dir) => {
    const app = await createCodexWebApp({
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const unauthenticated = await app.fetch(new Request("http://localhost:8787/api/workspaces"));
      assert.equal(unauthenticated.status, 401);

      await app.fetch(
        new Request("http://localhost:8787/api/auth/setup", {
          body: JSON.stringify({ password: "pw-123456789" }),
          headers: { origin: "http://localhost:8787", "x-csrf-token": "preauth" },
          method: "POST",
        }),
      );
      const login = await app.fetch(
        new Request("http://localhost:8787/api/auth/login", {
          body: JSON.stringify({ password: "pw-123456789" }),
          headers: { origin: "http://localhost:8787", "x-csrf-token": "preauth" },
          method: "POST",
        }),
      );
      const loginBody = (await login.json()) as { csrfToken: string };
      const cookie = login.headers.get("set-cookie")!.split(";")[0];

      const nonActive = await app.fetch(new Request("http://localhost:8787/api/workspaces", { headers: { cookie } }));
      assert.equal(nonActive.status, 403);

      const takeover = await app.fetch(
        new Request("http://localhost:8787/api/connection/takeover", {
          body: JSON.stringify({ password: "pw-123456789" }),
          headers: { cookie, "x-csrf-token": loginBody.csrfToken },
          method: "POST",
        }),
      );
      const lease = (await takeover.json()) as { connectionId: string; epoch: number; fencingToken: string };
      const leaseHeaders = {
        cookie,
        "x-codex-connection-id": lease.connectionId,
        "x-codex-connection-epoch": String(lease.epoch),
        "x-codex-fencing-token": lease.fencingToken,
      };

      const okList = await app.fetch(new Request("http://localhost:8787/api/workspaces", { headers: leaseHeaders }));
      assert.equal(okList.status, 200);
      assert.deepEqual((await okList.json()) as unknown[], []);

      const threadList = await app.fetch(new Request("http://localhost:8787/api/threads?limit=2", { headers: leaseHeaders }));
      assert.equal(threadList.status, 200);
      assert.deepEqual(await threadList.json(), { items: [] });

      const missingCsrf = await app.fetch(
        new Request("http://localhost:8787/api/workspaces/open", {
          body: JSON.stringify({ path: dir }),
          headers: { ...leaseHeaders, "content-type": "application/json" },
          method: "POST",
        }),
      );
      assert.equal(missingCsrf.status, 403);

      const opened = await app.fetch(
        new Request("http://localhost:8787/api/workspaces/open", {
          body: JSON.stringify({ path: dir }),
          headers: { ...leaseHeaders, "content-type": "application/json", "x-csrf-token": loginBody.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(opened.status, 200);

      const rawRpc = await app.fetch(new Request("http://localhost:8787/api/rpc", { headers: leaseHeaders, method: "POST" }));
      assert.equal(rawRpc.status, 404);
    } finally {
      await app.close();
    }
  });
});
