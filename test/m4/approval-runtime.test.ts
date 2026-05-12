import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AppServerClient, type AppServerProcess } from "../../src/server/app-server-client.ts";
import { ApprovalStore, normalizeApprovalRequest } from "../../src/server/approvals.ts";
import { applyMigrations, openDatabase, type CodexWebDatabase } from "../../src/server/db.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-m4-runtime-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

async function withDb<T>(fn: (db: CodexWebDatabase) => Promise<T>): Promise<T> {
  return await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "m4.sqlite"));
    applyMigrations(db);
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  });
}

class FakeProcess extends EventEmitter implements AppServerProcess {
  killed = false;
  pid = 1234;
  stderr = new PassThrough();
  stdin = new PassThrough();
  stdout = new PassThrough();
  writes: unknown[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      this.writes.push(JSON.parse(chunk.toString("utf8")) as unknown);
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  request(id: number, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }
}

async function startInitialized(): Promise<{ client: AppServerClient; process: FakeProcess }> {
  const process = new FakeProcess();
  const client = new AppServerClient({ codexBin: "codex", createProcess: () => process, stderrLimit: 120, timeoutMs: 1_000 });
  const started = client.start();
  await Promise.resolve();
  process.respond(1, { ok: true });
  await started;
  return { client, process };
}

test("M4 migrations add approval audit rows and keep metadata-only columns", async () => {
  await withDb(async (db) => {
    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => (row as { version: number }).version);
    assert.deepEqual(versions, [1, 2, 3, 4]);

    const columns = db
      .prepare(
        `SELECT m.name AS table_name, p.name AS column_name
         FROM sqlite_master m, pragma_table_info(m.name) p
         WHERE m.type = 'table'`,
      )
      .all() as Array<{ column_name: string; table_name: string }>;

    assert(columns.some((column) => column.table_name === "approval_events"));
    assert.deepEqual(
      columns.filter((column) => /prompt|agent_message|reasoning|command_output|diff|raw_payload|body|content/i.test(column.column_name)),
      [],
    );
  });
});

test("AppServerClient treats app-server id+method messages as server requests and can answer them", async () => {
  const { client, process } = await startInitialized();
  const requests: unknown[] = [];
  client.on("serverRequest", (request) => requests.push(request));

  process.request(77, "item/commandExecution/requestApproval", { itemId: "item-1" });
  await Promise.resolve();
  await client.respondToServerRequest({ decision: "approve", requestId: 77, scope: "turn" });

  assert.deepEqual(requests, [{ method: "item/commandExecution/requestApproval", params: { itemId: "item-1" }, requestId: 77 }]);
  assert.deepEqual(process.writes.at(-1), { id: 77, result: { decision: "approve", scope: "turn" } });
  await client.close();
});

test("command approval metadata is semantic and audit storage excludes raw command bodies", async () => {
  await withDb(async (db) => {
    const store = new ApprovalStore(db, { now: () => 10 });
    const pending = store.recordRequest({
      lease: { connectionId: "c1", epoch: 1 },
      method: "item/commandExecution/requestApproval",
      params: {
        command: "powershell -NoProfile -Command \"Write-Host SUPER_SECRET_TOKEN\"",
        cwd: "C:\\Users\\aokuni\\repo",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      requestId: 10,
    });

    assert.equal(pending.kind, "command");
    assert.equal(pending.metadata.summary.includes("powershell"), true);
    assert.equal(pending.metadata.summary.includes("SUPER_SECRET_TOKEN"), false);
    const snapshot = JSON.stringify(db.prepare("SELECT * FROM approval_events").all());
    assert(!snapshot.includes("SUPER_SECRET_TOKEN"));
    assert(!snapshot.includes("Write-Host"));
    assert(!snapshot.includes("C:\\Users\\aokuni"));
  });
});

test("file change approval metadata summarizes paths and never stores full diffs", async () => {
  await withDb(async (db) => {
    const store = new ApprovalStore(db, { now: () => 20 });
    const pending = store.recordRequest({
      lease: { connectionId: "c1", epoch: 1 },
      method: "item/fileChange/requestApproval",
      params: {
        changes: [{ path: "src/server/secret.ts", diff: "+const apiKey = 'SHOULD_NOT_PERSIST';\n-old" }],
        cwd: "C:\\repo",
        itemId: "item-2",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      requestId: 11,
    });

    assert.equal(pending.kind, "file_change");
    assert.deepEqual(pending.metadata.paths, ["src/server/secret.ts"]);
    assert.equal(pending.metadata.diffSummary, "1 file changed");
    const snapshot = JSON.stringify(db.prepare("SELECT * FROM approval_events").all());
    assert(!snapshot.includes("SHOULD_NOT_PERSIST"));
    assert(!snapshot.includes("+const apiKey"));
  });
});

test("permission approval metadata is semantic and defaults to turn scope", () => {
  const normalized = normalizeApprovalRequest("item/permissions/requestApproval", {
    permission: { id: "workspace-write", type: "profile" },
    permissions: ["write:C:\\repo", "network:https://api.example.com"],
  });

  assert.equal(normalized.kind, "permission");
  assert.equal(normalized.defaultScope, "turn");
  assert.match(normalized.metadata.summary, /workspace-write|write|network/);
  assert.deepEqual(normalized.availableDecisions, ["approve", "reject", "cancel"]);
});

test("permission summaries redact raw path-like permission metadata before audit persistence", async () => {
  await withDb(async (db) => {
    const store = new ApprovalStore(db, { now: () => 31 });
    store.recordRequest({
      lease: { connectionId: "c1", epoch: 1 },
      method: "item/permissions/requestApproval",
      params: {
        permissions: ["write:C:\\Users\\aokuni\\.ssh\\id_rsa", "network:https://api.example.com"],
      },
      requestId: "permission-path",
    });

    const snapshot = JSON.stringify(db.prepare("SELECT * FROM approval_events").all());
    assert(!snapshot.includes("C:\\Users\\aokuni"));
    assert(!snapshot.includes("id_rsa"));
    assert(snapshot.includes("<USER_HOME>"));
  });
});

test("network approval context keeps host protocol and port without raw command text", () => {
  const normalized = normalizeApprovalRequest("item/commandExecution/requestApproval", {
    command: "curl https://api.example.com/private?token=SECRET",
    networkApprovalContext: { host: "api.example.com", port: 443, protocol: "https" },
  });

  assert.equal(normalized.kind, "command");
  assert.deepEqual(normalized.metadata.network, { host: "api.example.com", port: 443, protocol: "https" });
  assert(!normalized.metadata.summary.includes("SECRET"));
});

test("unknown approval request kinds fail closed with generic metadata", () => {
  const normalized = normalizeApprovalRequest("tool/unknown/requestApproval", { prompt: "raw prompt should not show" });

  assert.equal(normalized.kind, "unknown");
  assert.equal(normalized.failClosed, true);
  assert.equal(normalized.metadata.summary.includes("raw prompt"), false);
  assert.deepEqual(normalized.availableDecisions, ["cancel"]);
});

test("approval audit rows contain redacted metadata only after request and decision", async () => {
  await withDb(async (db) => {
    const store = new ApprovalStore(db, { now: () => 30 });
    const approval = store.recordRequest({
      lease: { connectionId: "c1", epoch: 1 },
      method: "item/commandExecution/requestApproval",
      params: {
        command: "echo USER PROMPT AGENT MESSAGE SECRET_REASONING SECRET_OUTPUT",
        cwd: "C:\\repo",
        rawPayload: { diff: "FULL_DIFF" },
      },
      requestId: "req-1",
    });
    store.markDecided(approval.id, { connectionId: "c1", epoch: 1 }, { decision: "reject" });

    const snapshot = JSON.stringify(db.prepare("SELECT * FROM approval_events").all());
    for (const forbidden of ["USER PROMPT", "AGENT MESSAGE", "SECRET_REASONING", "SECRET_OUTPUT", "FULL_DIFF", "rawPayload"]) {
      assert(!snapshot.includes(forbidden), `${forbidden} should not be persisted`);
    }
    assert(snapshot.includes("approval.decision"));
  });
});

test("failed app-server approval response keeps pending approval retryable", async () => {
  await withDb(async (db) => {
    const store = new ApprovalStore(db, { now: () => 40 });
    const approval = store.recordRequest({
      lease: { connectionId: "c1", epoch: 1 },
      method: "item/commandExecution/requestApproval",
      params: { command: "echo ok" },
      requestId: "retryable",
    });

    const prepared = store.prepareDecision(approval.id, { connectionId: "c1", epoch: 1 }, { decision: "approve" });
    assert.equal(prepared.decision, "approve");
    assert.equal(store.listForLease({ connectionId: "c1", epoch: 1 }).length, 1);

    store.completeDecision(approval.id, prepared);
    assert.equal(store.listForLease({ connectionId: "c1", epoch: 1 }).length, 0);
  });
});

test("stdout and stderr diagnostic redaction/capping remains intact with approval runtime changes", async () => {
  const process = new FakeProcess();
  const client = new AppServerClient({ codexBin: "codex", createProcess: () => process, stderrLimit: 80, timeoutMs: 1_000 });
  const started = client.start();
  await Promise.resolve();
  process.stderr.write("token=SECRET prompt private body diff C:\\Users\\aokuni\\repo\n");
  process.stdout.write("{not json with command output private body}\n");
  process.respond(1, { ok: true });
  await started;

  const diagnostics = JSON.stringify(client.diagnostics());
  assert(diagnostics.length < 220);
  assert(!diagnostics.includes("SECRET"));
  assert(!diagnostics.includes("private body"));
  assert(!diagnostics.includes("C:\\Users\\aokuni"));
  await client.close();
});
