import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexWebApp } from "../../src/server/app.ts";
import { AuthService } from "../../src/server/auth.ts";
import { ConnectionLeaseManager } from "../../src/server/connection-lease.ts";
import { getConfig } from "../../src/server/config.ts";
import { applyMigrations, openDatabase } from "../../src/server/db.ts";
import { runPreflightChecks } from "../../src/server/preflight.ts";
import { validateCsrf } from "../../src/server/security.ts";
import { WebSocketTicketStore } from "../../src/server/ws-ticket.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-m1-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runtime config applies defaults and initializes data directories", async () => {
  await withTempDir(async (dir) => {
    const config = await getConfig({
      CODEX_WEB_DB_PATH: join(dir, "data", "codex-web.sqlite"),
      CODEX_WEB_SESSION_SECRET: "x".repeat(32),
    });

    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8787);
    assert.equal(config.publicOrigin, "http://localhost:8787");
    assert.match(config.dbPath, /codex-web\.sqlite$/);
  });
});

test("SQLite migrations preserve M1 metadata tables", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "m1.sqlite"));
    applyMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const table of [
      "active_connection",
      "connection_epochs",
      "device_sessions",
      "login_attempts",
      "schema_migrations",
      "settings",
      "ws_tickets",
    ]) {
      assert(tables.includes(table), `${table} should exist`);
    }
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('settings')")
      .all()
      .map((row) => (row as { name: string }).name);
    assert(!columns.some((name) => /prompt|reasoning|output|diff|conversation|message/i.test(name)));
    db.close();
  });
});

test("first-run setup stores a scrypt password hash and never plaintext", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "auth.sqlite"));
    applyMigrations(db);
    const auth = new AuthService(db, { sessionSecret: "s".repeat(32), now: () => 1_000 });

    assert.equal(auth.needsSetup(), true);
    await auth.setupPassword("correct horse battery staple");

    assert.equal(auth.needsSetup(), false);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get() as { value: string };
    assert.match(row.value, /^scrypt\$/);
    assert(!row.value.includes("correct horse battery staple"));
    assert.equal(await auth.verifyPassword("correct horse battery staple"), true);
    assert.equal(await auth.verifyPassword("wrong password"), false);
    db.close();
  });
});

test("login rotates signed HttpOnly sessions and logout revokes reuse", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "session.sqlite"));
    applyMigrations(db);
    const auth = new AuthService(db, { sessionSecret: "s".repeat(32), now: () => 10_000 });
    await auth.setupPassword("pw-123456789");

    const first = await auth.login("pw-123456789", { userAgent: "phone", ip: "127.0.0.1" });
    const second = await auth.login("pw-123456789", { userAgent: "phone", ip: "127.0.0.1" });

    assert.notEqual(first.cookieValue, second.cookieValue);
    assert.match(second.setCookie, /HttpOnly/);
    assert.match(second.setCookie, /SameSite=Lax/);
    assert.equal(auth.readSession(second.cookieValue)?.deviceSessionId.length, 64);
    auth.logout(second.cookieValue);
    assert.equal(auth.readSession(second.cookieValue), undefined);
    db.close();
  });
});

test("failed login attempts record backoff metadata", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "attempts.sqlite"));
    applyMigrations(db);
    const auth = new AuthService(db, { sessionSecret: "s".repeat(32), now: () => 100_000 });
    await auth.setupPassword("pw-123456789");

    await assert.rejects(() => auth.login("bad", { userAgent: "mac", ip: "10.0.0.2" }), /Invalid password/);
    const row = db.prepare("SELECT failed_count, next_allowed_at FROM login_attempts WHERE subject = ?").get("10.0.0.2") as {
      failed_count: number;
      next_allowed_at: number;
    };
    assert.equal(row.failed_count, 1);
    assert(row.next_allowed_at > 100_000);
    db.close();
  });
});

test("CSRF rejects unsafe requests with missing token, wrong token, cross origin, and cross-site metadata", () => {
  const base = {
    method: "POST",
    publicOrigin: "http://localhost:8787",
    expectedToken: "csrf-a",
  };

  assert.equal(validateCsrf({ ...base, headers: { origin: "http://localhost:8787", "x-csrf-token": "csrf-a" } }).ok, true);
  assert.equal(validateCsrf({ ...base, headers: { origin: "http://localhost:8787" } }).ok, false);
  assert.equal(validateCsrf({ ...base, headers: { origin: "http://localhost:8787", "x-csrf-token": "csrf-b" } }).ok, false);
  assert.equal(validateCsrf({ ...base, headers: { origin: "http://evil.test", "x-csrf-token": "csrf-a" } }).ok, false);
  assert.equal(
    validateCsrf({
      ...base,
      headers: { origin: "http://localhost:8787", "x-csrf-token": "csrf-a", "sec-fetch-site": "cross-site" },
    }).ok,
    false,
  );
});

test("WebSocket tickets are short-lived, one-time, and session-bound", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "tickets.sqlite"));
    applyMigrations(db);
    const store = new WebSocketTicketStore(db, { now: () => 1_000, ttlMs: 30_000, secret: "t".repeat(32) });

    const ticket = store.issue("session-a");
    assert.equal(store.consume(ticket, "session-b"), undefined);
    assert.equal(store.consume(ticket, "session-a")?.sessionId, "session-a");
    assert.equal(store.consume(ticket, "session-a"), undefined);

    const expired = new WebSocketTicketStore(db, { now: () => 1_000, ttlMs: 1, secret: "t".repeat(32) }).issue("session-a");
    const late = new WebSocketTicketStore(db, { now: () => 1_002, ttlMs: 1, secret: "t".repeat(32) });
    assert.equal(late.consume(expired, "session-a"), undefined);
    db.close();
  });
});

test("single active connection lease gates privileged actions and supports password takeover", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "lease.sqlite"));
    applyMigrations(db);
    const auth = new AuthService(db, { sessionSecret: "s".repeat(32), now: () => 1_000 });
    await auth.setupPassword("takeover-pw");
    const lease = new ConnectionLeaseManager(db, { now: () => 5_000, leaseTtlMs: 60_000 });

    const first = lease.acquire("device-a", "Phone", "ua-a");
    assert.equal(first.state, "active");
    if (first.state !== "active") {
      throw new Error("first lease should be active");
    }
    const busy = lease.acquire("device-b", "Mac", "ua-b");
    assert.equal(busy.state, "busy");
    assert.equal(lease.canUse(first.connectionId, first.epoch, first.fencingToken), true);
    assert.equal(lease.canUse("other", first.epoch, first.fencingToken), false);

    const taken = await lease.takeover({
      deviceSessionId: "device-b",
      deviceLabel: "Mac",
      userAgent: "ua-b",
      password: "takeover-pw",
      auth,
    });
    assert.equal(taken.state, "active");
    assert.equal(taken.revokedConnectionId, first.connectionId);
    assert.equal(taken.epoch, first.epoch + 1);
    assert.equal(lease.canUse(first.connectionId, first.epoch, first.fencingToken), false);
    assert.equal(lease.canUse(taken.connectionId, taken.epoch, taken.fencingToken), true);
    db.close();
  });
});

test("stale epochs and expired heartbeats lose privileged action access", async () => {
  await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "stale.sqlite"));
    applyMigrations(db);
    const lease = new ConnectionLeaseManager(db, { now: () => 1_000, leaseTtlMs: 10 });
    const active = lease.acquire("device-a", "Phone", "ua-a");
    if (active.state !== "active") {
      throw new Error("lease should be active");
    }
    assert.equal(lease.canUse(active.connectionId, active.epoch - 1, active.fencingToken), false);

    const expiredLease = new ConnectionLeaseManager(db, { now: () => 2_000, leaseTtlMs: 10 });
    assert.equal(expiredLease.canUse(active.connectionId, active.epoch, active.fencingToken), false);
    db.close();
  });
});

test("browser-facing app exposes semantic routes but no raw JSON-RPC proxy", async () => {
  await withTempDir(async (dir) => {
    const app = await createCodexWebApp({
      env: {
        CODEX_WEB_DB_PATH: join(dir, "app.sqlite"),
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
      },
    });

    const rawRpc = await app.fetch(new Request("http://localhost:8787/api/rpc", { method: "POST" }));
    const jsonRpc = await app.fetch(new Request("http://localhost:8787/api/json-rpc", { method: "POST" }));
    const status = await app.fetch(new Request("http://localhost:8787/api/status"));

    assert.equal(rawRpc.status, 404);
    assert.equal(jsonRpc.status, 404);
    assert.equal(status.status, 200);
    await app.close();
  });
});

test("preflight detects codex help/version failures, shell probe Error 1385, and redacts output", async () => {
  const result = await runPreflightChecks({
    codexBin: "codex",
    runCommand: async (command, args) => {
      const joined = [command, ...args].join(" ");
      if (joined === "codex --version") {
        return { ok: true, stdout: "codex-cli 0.130.0-alpha.5\n", stderr: "" };
      }
      if (joined === "codex app-server --help") {
        return { ok: true, stdout: "Usage: codex app-server --listen <transport>\n", stderr: "" };
      }
      return { ok: false, stdout: "private body", stderr: "windows sandbox: CreateProcessWithLogonW failed: 1385" };
    },
  });

  assert.equal(result.codexVersion.ok, true);
  assert.equal(result.appServerHelp.ok, true);
  assert.equal(result.shellProbe.ok, false);
  assert.equal(result.shellProbe.errorCode, "WINDOWS_LOGON_RIGHT_1385");
  assert(!JSON.stringify(result).includes("private body"));
});
