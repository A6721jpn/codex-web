import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexWebApp } from "../../src/server/app.ts";
import { applyMigrations, openDatabase, type CodexWebDatabase } from "../../src/server/db.ts";
import { ChatRuntime, FakeAppServerRuntime } from "../../src/server/chat-runtime.ts";
import { ThreadIndexStore } from "../../src/server/thread-index.ts";
import { WorkspaceStore } from "../../src/server/workspace.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-m3-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

async function withDb<T>(fn: (db: CodexWebDatabase, dir: string) => Promise<T>): Promise<T> {
  return await withTempDir(async (dir) => {
    const db = openDatabase(join(dir, "m3.sqlite"));
    applyMigrations(db);
    try {
      return await fn(db, dir);
    } finally {
      db.close();
    }
  });
}

test("M3 migrations keep SQLite metadata-only and add app-server runtime state without body columns", async () => {
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
    assert(columns.some((column) => column.table_name === "app_server_runtime"));
    assert.deepEqual(
      columns.filter((column) => /prompt|agent_message|reasoning|command_output|diff|raw_payload|body|content/i.test(column.column_name)),
      [],
    );
  });
});

test("ChatRuntime refresh follows app-server pagination and stores thread metadata only", async () => {
  await withDb(async (db) => {
    const appServer = new FakeAppServerRuntime({
      threadListPages: [
        {
          data: [
            {
              cwd: "C:\\repo",
              ephemeral: false,
              id: "t1",
              name: "Safe title",
              preview: "USER PROMPT SHOULD NOT PERSIST",
              source: "appServer",
              turns: [{ items: [{ content: "AGENT MESSAGE SHOULD NOT PERSIST" }] }],
              updatedAt: 100,
            },
          ],
          nextCursor: "page-2",
        },
        {
          data: [
            {
              cwd: "C:\\repo",
              ephemeral: true,
              id: "t2",
              name: null,
              preview: "reasoning command_output diff raw_payload",
              source: "cli",
              turns: [],
              updatedAt: 200,
            },
          ],
        },
      ],
    });
    const runtime = new ChatRuntime({
      appServer,
      threads: new ThreadIndexStore(db, { now: () => 5_000 }),
      workspaces: new WorkspaceStore(db, { now: () => 5_000 }),
    });

    const result = await runtime.refreshThreads({ pageSize: 1 });

    assert.equal(result.upserted, 2);
    assert.deepEqual(appServer.threadListCalls.map((call) => call.sourceKinds), [
      ["appServer", "cli", "vscode"],
      ["appServer", "cli", "vscode"],
    ]);
    assert.deepEqual(appServer.threadListCalls.map((call) => call.cursor), [undefined, "page-2"]);
    assert.deepEqual(
      new ThreadIndexStore(db).list({ limit: 10 }).items.map((thread) => ({
        id: thread.id,
        sourceKind: thread.sourceKind,
        status: thread.status,
        title: thread.title,
      })),
      [
        { id: "t2", sourceKind: "cli", status: "ephemeral", title: undefined },
        { id: "t1", sourceKind: "appServer", status: "active", title: "Safe title" },
      ],
    );
    const snapshot = JSON.stringify(db.prepare("SELECT * FROM thread_index").all());
    for (const forbidden of ["USER PROMPT", "AGENT MESSAGE", "reasoning", "command_output", "diff", "raw_payload"]) {
      assert(!snapshot.includes(forbidden), `${forbidden} should not be persisted`);
    }
  });
});

test("ChatRuntime builds start/resume/turn/interrupt calls from server-side workspace metadata", async () => {
  await withDb(async (db, dir) => {
    const workspacePath = join(dir, "repo");
    await mkdir(workspacePath);
    const workspaces = new WorkspaceStore(db, { now: () => 10 });
    const workspace = await workspaces.open(workspacePath);
    const appServer = new FakeAppServerRuntime();
    const runtime = new ChatRuntime({ appServer, threads: new ThreadIndexStore(db), workspaces });

    const started = await runtime.startThread({ prompt: "hello", workspaceId: workspace.id });
    const resumed = await runtime.resumeThread({ threadId: "thread-1", workspaceId: workspace.id });
    const turn = await runtime.startTurn({ input: "next", threadId: "thread-1", workspaceId: workspace.id });
    await runtime.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });

    assert.equal(started.thread.id, "thread-1");
    assert.equal(resumed.thread.id, "thread-1");
    assert.equal(turn.turn.id, "turn-1");
    assert.equal(appServer.threadStartCalls[0]?.cwd, workspace.canonicalPath);
    assert.equal(appServer.threadStartCalls[0]?.experimentalRawEvents, false);
    assert.equal(appServer.threadStartCalls[0]?.persistExtendedHistory, false);
    assert.equal(appServer.threadResumeCalls[0]?.excludeTurns, true);
    assert.equal(appServer.threadResumeCalls[0]?.history, undefined);
    assert.equal(appServer.turnStartCalls[0]?.input[0]?.type, "text");
    assert.equal(appServer.turnInterruptCalls[0]?.turnId, "turn-1");
  });
});

test("ChatRuntime maps workspace auto_review permission policy into app-server calls", async () => {
  await withDb(async (db, dir) => {
    const workspacePath = join(dir, "repo");
    await mkdir(workspacePath);
    const workspaces = new WorkspaceStore(db, { now: () => 10 });
    const workspace = await workspaces.open(workspacePath);
    db.prepare("UPDATE workspace_policy SET default_permission_preset = ? WHERE workspace_id = ?").run("auto_review", workspace.id);

    const appServer = new FakeAppServerRuntime();
    const runtime = new ChatRuntime({ appServer, threads: new ThreadIndexStore(db), workspaces });

    await runtime.startThread({ prompt: undefined, workspaceId: workspace.id });
    await runtime.resumeThread({ threadId: "thread-1", workspaceId: workspace.id });
    await runtime.startTurn({ input: "next", threadId: "thread-1", workspaceId: workspace.id });

    assert.equal(appServer.threadStartCalls[0]?.approvalPolicy, "on-request");
    assert.equal(appServer.threadStartCalls[0]?.approvalsReviewer, "auto_review");
    assert.equal(appServer.threadResumeCalls[0]?.approvalsReviewer, "auto_review");
    assert.equal(appServer.turnStartCalls[0]?.approvalsReviewer, "auto_review");
  });
});

test("thread/read and thread/turns/list return runtime data without saving bodies to SQLite", async () => {
  await withDb(async (db) => {
    const appServer = new FakeAppServerRuntime({
      threadReadResult: { thread: { id: "t1", preview: "USER PROMPT BODY", turns: [{ items: [{ text: "AGENT MESSAGE" }] }] } },
      turnsListResult: { data: [{ id: "turn1", items: [{ reasoning: "SECRET REASONING", diff: "SECRET DIFF" }] }], nextCursor: null },
    });
    const runtime = new ChatRuntime({
      appServer,
      threads: new ThreadIndexStore(db),
      workspaces: new WorkspaceStore(db),
    });

    assert.deepEqual(await runtime.readThread({ threadId: "t1" }), appServer.threadReadResult);
    assert.deepEqual(await runtime.listTurns({ threadId: "t1" }), appServer.turnsListResult);

    const snapshot = JSON.stringify(db.prepare("SELECT * FROM sqlite_master").all()) + JSON.stringify(db.prepare("SELECT * FROM runtime_events").all());
    for (const forbidden of ["USER PROMPT BODY", "AGENT MESSAGE", "SECRET REASONING", "SECRET DIFF"]) {
      assert(!snapshot.includes(forbidden), `${forbidden} should not be persisted`);
    }
  });
});

test("M3 browser routes are semantic, authenticated, active-lease gated, and CSRF protected", async () => {
  await withTempDir(async (dir) => {
    const appServer = new FakeAppServerRuntime();
    const app = await createCodexWebApp({
      appServer,
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const unauthenticated = await app.fetch(new Request("http://localhost:8787/api/threads/refresh", { method: "POST" }));
      assert.equal(unauthenticated.status, 401);

      const { cookie, csrfToken, lease } = await loginAndAcquireLease(app);
      const leaseHeaders = {
        cookie,
        "x-codex-connection-id": lease.connectionId,
        "x-codex-connection-epoch": String(lease.epoch),
        "x-codex-fencing-token": lease.fencingToken,
      };

      const missingLease = await app.fetch(
        new Request("http://localhost:8787/api/threads/refresh", {
          headers: { cookie, "x-csrf-token": csrfToken },
          method: "POST",
        }),
      );
      assert.equal(missingLease.status, 403);

      const staleLease = await app.fetch(
        new Request("http://localhost:8787/api/threads/refresh", {
          headers: { ...leaseHeaders, "x-codex-connection-epoch": String(lease.epoch - 1), "x-csrf-token": csrfToken },
          method: "POST",
        }),
      );
      assert.equal(staleLease.status, 403);

      const missingCsrf = await app.fetch(
        new Request("http://localhost:8787/api/threads/refresh", {
          headers: leaseHeaders,
          method: "POST",
        }),
      );
      assert.equal(missingCsrf.status, 403);

      const refreshed = await app.fetch(
        new Request("http://localhost:8787/api/threads/refresh", {
          headers: { ...leaseHeaders, "x-csrf-token": csrfToken },
          method: "POST",
        }),
      );
      assert.equal(refreshed.status, 200);

      for (const path of ["/api/rpc", "/api/json-rpc", "/api/app-server", "/api/threads/rpc"]) {
        const response = await app.fetch(
          new Request(`http://localhost:8787${path}`, {
            body: JSON.stringify({ method: "thread/list", params: {} }),
            headers: { ...leaseHeaders, "x-csrf-token": csrfToken },
            method: "POST",
          }),
        );
        assert.equal(response.status, 404, path);
      }
    } finally {
      await app.close();
    }
  });
});

test("M3 semantic routes drive fake app-server start/resume/turn/interrupt integration", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "repo");
    await mkdir(workspacePath);
    const appServer = new FakeAppServerRuntime();
    const app = await createCodexWebApp({
      appServer,
      env: {
        CODEX_WEB_DB_PATH: join(dir, "runtime.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const { cookie, csrfToken, lease } = await loginAndAcquireLease(app);
      const headers = {
        cookie,
        "content-type": "application/json",
        "x-codex-connection-id": lease.connectionId,
        "x-codex-connection-epoch": String(lease.epoch),
        "x-codex-fencing-token": lease.fencingToken,
        "x-csrf-token": csrfToken,
      };
      const opened = await app.fetch(
        new Request("http://localhost:8787/api/workspaces/open", {
          body: JSON.stringify({ path: workspacePath }),
          headers,
          method: "POST",
        }),
      );
      const workspace = (await opened.json()) as { id: number };

      const start = await app.fetch(
        new Request("http://localhost:8787/api/threads/start", {
          body: JSON.stringify({ prompt: "hello", workspaceId: workspace.id, method: "thread/shellCommand" }),
          headers,
          method: "POST",
        }),
      );
      assert.equal(start.status, 200);
      const startBody = (await start.json()) as { thread: { id: string } };

      const resume = await app.fetch(
        new Request(`http://localhost:8787/api/threads/${startBody.thread.id}/resume`, {
          body: JSON.stringify({ workspaceId: workspace.id }),
          headers,
          method: "POST",
        }),
      );
      assert.equal(resume.status, 200);

      const turn = await app.fetch(
        new Request(`http://localhost:8787/api/threads/${startBody.thread.id}/turns`, {
          body: JSON.stringify({ input: "continue", params: { raw: true }, workspaceId: workspace.id }),
          headers,
          method: "POST",
        }),
      );
      assert.equal(turn.status, 200);
      const turnBody = (await turn.json()) as { turn: { id: string } };

      const interrupt = await app.fetch(
        new Request(`http://localhost:8787/api/turns/${turnBody.turn.id}/interrupt`, {
          body: JSON.stringify({ threadId: startBody.thread.id }),
          headers,
          method: "POST",
        }),
      );
      assert.equal(interrupt.status, 200);

      assert.equal(appServer.threadStartCalls[0]?.cwd, workspacePath);
      assert.equal(appServer.threadStartCalls[0]?.method, undefined);
      const explicitTurn = appServer.turnStartCalls.at(-1);
      assert.equal(explicitTurn?.input[0]?.text, "continue");
      assert.equal((explicitTurn as { params?: unknown } | undefined)?.params, undefined);
      assert.equal(appServer.turnInterruptCalls[0]?.turnId, turnBody.turn.id);
    } finally {
      await app.close();
    }
  });
});

async function loginAndAcquireLease(app: { fetch: (request: Request) => Promise<Response> }): Promise<{
  cookie: string;
  csrfToken: string;
  lease: { connectionId: string; epoch: number; fencingToken: string };
}> {
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
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const takeover = await app.fetch(
    new Request("http://localhost:8787/api/connection/takeover", {
      body: JSON.stringify({ password: "pw-123456789" }),
      headers: { cookie, "x-csrf-token": loginBody.csrfToken },
      method: "POST",
    }),
  );
  return {
    cookie,
    csrfToken: loginBody.csrfToken,
    lease: (await takeover.json()) as { connectionId: string; epoch: number; fencingToken: string },
  };
}
