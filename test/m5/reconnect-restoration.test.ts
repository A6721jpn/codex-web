import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";

import { AppServerClient, type AppServerProcess } from "../../src/server/app-server-client.ts";
import { createCodexWebApp } from "../../src/server/app.ts";
import { FakeAppServerRuntime } from "../../src/server/chat-runtime.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-m5-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

function leaseHeaders(input: {
  cookie: string;
  lease: { connectionId: string; epoch: number; fencingToken: string };
}): Record<string, string> {
  return {
    cookie: input.cookie,
    "x-codex-connection-id": input.lease.connectionId,
    "x-codex-connection-epoch": String(input.lease.epoch),
    "x-codex-fencing-token": input.lease.fencingToken,
  };
}

async function setupPassword(app: { fetch: (request: Request) => Promise<Response> }): Promise<void> {
  await app.fetch(
    new Request("http://localhost:8787/api/auth/setup", {
      body: JSON.stringify({ password: "pw-123456789" }),
      headers: { origin: "http://localhost:8787", "x-csrf-token": "preauth" },
      method: "POST",
    }),
  );
}

async function login(app: { fetch: (request: Request) => Promise<Response> }, userAgent = "test-browser"): Promise<{
  cookie: string;
  csrfToken: string;
}> {
  const response = await app.fetch(
    new Request("http://localhost:8787/api/auth/login", {
      body: JSON.stringify({ password: "pw-123456789" }),
      headers: { origin: "http://localhost:8787", "user-agent": userAgent, "x-csrf-token": "preauth" },
      method: "POST",
    }),
  );
  const body = (await response.json()) as { csrfToken: string };
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, csrfToken: body.csrfToken };
}

async function reconnect(app: { fetch: (request: Request) => Promise<Response> }, session: { cookie: string; csrfToken: string }): Promise<Response> {
  return await app.fetch(
    new Request("http://localhost:8787/api/connection/reconnect", {
      headers: { cookie: session.cookie, origin: "http://localhost:8787", "x-csrf-token": session.csrfToken },
      method: "POST",
    }),
  );
}

async function loginAndAcquireLease(app: { fetch: (request: Request) => Promise<Response> }): Promise<{
  cookie: string;
  csrfToken: string;
  lease: { connectionId: string; epoch: number; fencingToken: string };
}> {
  await setupPassword(app);
  const session = await login(app);
  const response = await reconnect(app, session);
  return { ...session, lease: (await response.json()) as { connectionId: string; epoch: number; fencingToken: string } };
}

class MemorySocket extends Duplex {
  endedByServer = false;
  writes: Buffer[] = [];

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  override end(callback?: () => void): this;
  override end(chunk: unknown, callback?: () => void): this;
  override end(chunk: unknown, encoding: BufferEncoding, callback?: () => void): this;
  override end(chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void): this {
    this.endedByServer = true;
    if (typeof encodingOrCallback === "function") {
      return super.end(chunk, encodingOrCallback);
    }
    return encodingOrCallback ? super.end(chunk, encodingOrCallback, callback) : super.end(chunk, callback);
  }
}

function websocketKey(): string {
  return Buffer.from("codex-web-test-key").toString("base64");
}

function maskedClientFrame(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = payload.length <= 125 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}

test("same-device reload reacquires the active lease through semantic reconnect", async () => {
  await withTempDir(async (dir) => {
    const app = await createCodexWebApp({
      appServer: new FakeAppServerRuntime(),
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const session = await loginAndAcquireLease(app);
      const reloaded = await reconnect(app, session);
      assert.equal(reloaded.status, 200);
      const lease = (await reloaded.json()) as { connectionId: string; epoch: number; fencingToken: string; state: string };
      assert.equal(lease.state, "active");
      assert.notEqual(lease.connectionId, session.lease.connectionId);
      assert.equal(lease.epoch, session.lease.epoch + 1);
    } finally {
      await app.close();
    }
  });
});

test("same-device reconnect revokes the previous websocket connection", async () => {
  await withTempDir(async (dir) => {
    const app = await createCodexWebApp({
      appServer: new FakeAppServerRuntime(),
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      await setupPassword(app);
      const session = await login(app);
      const ticketResponse = await app.fetch(
        new Request("http://localhost:8787/api/ws-ticket", {
          headers: { cookie: session.cookie, origin: "http://localhost:8787", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
      const socket = new MemorySocket();
      await app.handleUpgrade(
        new Request(`http://localhost:8787/ws?ticket=${encodeURIComponent(ticket)}`, {
          headers: {
            cookie: session.cookie,
            host: "localhost:8787",
            origin: "http://localhost:8787",
            "sec-websocket-key": websocketKey(),
            "user-agent": "same-device",
          },
        }),
        socket,
      );

      assert.equal(socket.endedByServer, false);
      const reconnected = await reconnect(app, session);
      assert.equal(reconnected.status, 200);
      assert.equal(socket.endedByServer, true);
      assert(Buffer.concat(socket.writes).includes(Buffer.from("connection.revoked")));
    } finally {
      await app.close();
    }
  });
});

test("websocket heartbeat messages receive an acknowledgement", async () => {
  await withTempDir(async (dir) => {
    const app = await createCodexWebApp({
      appServer: new FakeAppServerRuntime(),
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      await setupPassword(app);
      const session = await login(app);
      const ticketResponse = await app.fetch(
        new Request("http://localhost:8787/api/ws-ticket", {
          headers: { cookie: session.cookie, origin: "http://localhost:8787", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
      const socket = new MemorySocket();
      await app.handleUpgrade(
        new Request(`http://localhost:8787/ws?ticket=${encodeURIComponent(ticket)}`, {
          headers: {
            cookie: session.cookie,
            host: "localhost:8787",
            origin: "http://localhost:8787",
            "sec-websocket-key": websocketKey(),
          },
        }),
        socket,
      );
      const readyText = Buffer.concat(socket.writes).toString("utf8");
      const connectionId = readyText.match(/"connectionId":"([^"]+)"/)?.[1];
      const epoch = Number(readyText.match(/"epoch":(\d+)/)?.[1]);
      const fencingToken = readyText.match(/"fencingToken":"([^"]+)"/)?.[1];
      assert(connectionId);
      assert(Number.isInteger(epoch));
      assert(fencingToken);

      socket.push(maskedClientFrame({ connectionId, epoch, fencingToken, type: "connection.heartbeat" }));
      await new Promise((resolve) => setImmediate(resolve));
      assert(Buffer.concat(socket.writes).includes(Buffer.from("connection.heartbeat.ack")));
    } finally {
      await app.close();
    }
  });
});

test("websocket socket errors are contained and do not crash the server", async () => {
  await withTempDir(async (dir) => {
    const app = await createCodexWebApp({
      appServer: new FakeAppServerRuntime(),
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      await setupPassword(app);
      const session = await login(app);
      const ticketResponse = await app.fetch(
        new Request("http://localhost:8787/api/ws-ticket", {
          headers: { cookie: session.cookie, origin: "http://localhost:8787", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
      const socket = new MemorySocket();
      await app.handleUpgrade(
        new Request(`http://localhost:8787/ws?ticket=${encodeURIComponent(ticket)}`, {
          headers: {
            cookie: session.cookie,
            host: "localhost:8787",
            origin: "http://localhost:8787",
            "sec-websocket-key": websocketKey(),
          },
        }),
        socket,
      );

      assert.doesNotThrow(() => socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
    } finally {
      await app.close();
    }
  });
});

test("different device reconnect sees busy state instead of privileged data", async () => {
  await withTempDir(async (dir) => {
    const app = await createCodexWebApp({
      appServer: new FakeAppServerRuntime(),
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const first = await loginAndAcquireLease(app);
      const second = await login(app, "second-device");
      const busy = await reconnect(app, second);
      assert.equal(busy.status, 409);
      const body = (await busy.json()) as { state: string };
      assert.equal(body.state, "busy");
      const blocked = await app.fetch(new Request("http://localhost:8787/api/workspaces", { headers: { cookie: second.cookie } }));
      assert.equal(blocked.status, 403);
      assert.equal((await app.fetch(new Request("http://localhost:8787/api/workspaces", { headers: leaseHeaders(first) }))).status, 200);
    } finally {
      await app.close();
    }
  });
});

test("state restoration refreshes workspaces, threads, active UI state, and pending approvals", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "repo");
    await mkdir(workspacePath);
    const appServer = new FakeAppServerRuntime({
      threadListPages: [{ data: [{ cwd: workspacePath, id: "thread-restore", name: "Restore me", source: "appServer", updatedAt: 123 }] }],
    });
    const app = await createCodexWebApp({
      appServer,
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const session = await loginAndAcquireLease(app);
      const opened = await app.fetch(
        new Request("http://localhost:8787/api/workspaces/open", {
          body: JSON.stringify({ path: workspacePath }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      const workspace = (await opened.json()) as { id: number };
      await app.fetch(
        new Request("http://localhost:8787/api/ui/active", {
          body: JSON.stringify({ threadId: "thread-restore", workspaceId: workspace.id }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      appServer.emitServerRequest("approval-restore", "item/commandExecution/requestApproval", { command: "echo SECRET", threadId: "thread-restore" });

      const reconnected = await reconnect(app, session);
      const restoredLease = (await reconnected.json()) as { connectionId: string; epoch: number; fencingToken: string };
      const state = await app.fetch(new Request("http://localhost:8787/api/state", { headers: leaseHeaders({ ...session, lease: restoredLease }) }));
      assert.equal(state.status, 200);
      const body = (await state.json()) as {
        activeThreadId?: string;
        activeWorkspaceId?: number;
        approvals: Array<{ id: string; metadata: { summary: string } }>;
        threads: { items: Array<{ id: string; title?: string }> };
        workspaces: Array<{ id: number }>;
      };
      assert.equal(body.activeWorkspaceId, workspace.id);
      assert.equal(body.activeThreadId, "thread-restore");
      assert.deepEqual(body.workspaces.map((item) => item.id), [workspace.id]);
      assert.equal(body.threads.items[0]?.title, "Restore me");
      assert.equal(body.approvals[0]?.id, "approval-restore");
      assert(!JSON.stringify(body).includes("SECRET"));
    } finally {
      await app.close();
    }
  });
});

test("takeover rejects old epoch workspace thread approval and turn operations", async () => {
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
      const old = await loginAndAcquireLease(app);
      appServer.emitServerRequest("approval-stale", "item/commandExecution/requestApproval", { command: "echo stale" });
      const next = await login(app, "takeover-device");
      const takeover = await app.fetch(
        new Request("http://localhost:8787/api/connection/takeover", {
          body: JSON.stringify({ password: "pw-123456789" }),
          headers: { cookie: next.cookie, origin: "http://localhost:8787", "x-csrf-token": next.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(takeover.status, 200);

      const staleHeaders = { ...leaseHeaders(old), "content-type": "application/json", "x-csrf-token": old.csrfToken };
      for (const request of [
        new Request("http://localhost:8787/api/workspaces/open", { body: JSON.stringify({ path: dir }), headers: staleHeaders, method: "POST" }),
        new Request("http://localhost:8787/api/threads/refresh", { headers: staleHeaders, method: "POST" }),
        new Request("http://localhost:8787/api/approvals/approval-stale/decision", {
          body: JSON.stringify({ decision: "cancel" }),
          headers: staleHeaders,
          method: "POST",
        }),
        new Request("http://localhost:8787/api/threads/t1/turns", {
          body: JSON.stringify({ input: "delayed", workspaceId: 1 }),
          headers: staleHeaders,
          method: "POST",
        }),
      ]) {
        assert.equal((await app.fetch(request)).status, 403);
      }
    } finally {
      await app.close();
    }
  });
});

test("pending approvals remain visible to the same active lease after reload but stale decisions are rejected", async () => {
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
      const session = await loginAndAcquireLease(app);
      appServer.emitServerRequest("approval-reload", "item/permissions/requestApproval", { permission: { id: "workspace-write" } });
      const reloaded = (await (await reconnect(app, session)).json()) as { connectionId: string; epoch: number; fencingToken: string };
      const current = { ...session, lease: reloaded };

      const listed = await app.fetch(new Request("http://localhost:8787/api/approvals", { headers: leaseHeaders(current) }));
      assert.equal(listed.status, 200);
      assert.equal(((await listed.json()) as { approvals: unknown[] }).approvals.length, 1);

      const staleDecision = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-reload/decision", {
          body: JSON.stringify({ decision: "approve" }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(staleDecision.status, 403);
    } finally {
      await app.close();
    }
  });
});

test("ownerless approval request fail-closes with cancel response", async () => {
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
      appServer.emitServerRequest("approval-no-owner", "item/commandExecution/requestApproval", { command: "echo no-owner" });
      await Promise.resolve();
      assert.deepEqual(appServer.approvalResponses, [{ decision: "cancel", requestId: "approval-no-owner", scope: "turn" }]);
    } finally {
      await app.close();
    }
  });
});

test("thread unsubscribe route is semantic and calls app-server unsubscribe", async () => {
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
      const session = await loginAndAcquireLease(app);
      const response = await app.fetch(
        new Request("http://localhost:8787/api/threads/thread-1/unsubscribe", {
          headers: { ...leaseHeaders(session), "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(appServer.threadUnsubscribeCalls, [{ threadId: "thread-1" }]);
    } finally {
      await app.close();
    }
  });
});

test("thread unsubscribe requires auth active lease and CSRF", async () => {
  await withTempDir(async (dir) => {
    const app = await createCodexWebApp({
      appServer: new FakeAppServerRuntime(),
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      assert.equal((await app.fetch(new Request("http://localhost:8787/api/threads/t1/unsubscribe", { method: "POST" }))).status, 401);
      const session = await loginAndAcquireLease(app);
      assert.equal(
        (
          await app.fetch(
            new Request("http://localhost:8787/api/threads/t1/unsubscribe", {
              headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
              method: "POST",
            }),
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await app.fetch(
            new Request("http://localhost:8787/api/threads/t1/unsubscribe", {
              headers: leaseHeaders(session),
              method: "POST",
            }),
          )
        ).status,
        403,
      );
    } finally {
      await app.close();
    }
  });
});

test("safe read retries once after transient app-server unavailable", async () => {
  await withTempDir(async (dir) => {
    class TransientReadFailureRuntime extends FakeAppServerRuntime {
      readAttempts = 0;
      override async threadRead(params: { includeTurns?: boolean; threadId: string }): Promise<unknown> {
        this.readAttempts += 1;
        if (this.readAttempts === 1) {
          throw new Error("app-server unavailable");
        }
        return await super.threadRead(params);
      }
    }
    const appServer = new TransientReadFailureRuntime({ threadReadResult: { thread: { id: "thread-retry" } } });
    const app = await createCodexWebApp({
      appServer,
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const session = await loginAndAcquireLease(app);
      const response = await app.fetch(new Request("http://localhost:8787/api/threads/thread-retry", { headers: leaseHeaders(session) }));
      assert.equal(response.status, 200);
      assert.equal(appServer.readAttempts, 2);
    } finally {
      await app.close();
    }
  });
});

test("side-effecting turn start is not replayed after app-server unavailable", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "repo");
    await mkdir(workspacePath);
    class FailingTurnRuntime extends FakeAppServerRuntime {
      override async turnStart(params: Record<string, unknown> & { input: Array<{ text?: string; type: string }> }): Promise<unknown> {
        this.turnStartCalls.push(params);
        throw new Error("app-server unavailable");
      }
    }
    const appServer = new FailingTurnRuntime();
    const app = await createCodexWebApp({
      appServer,
      env: {
        CODEX_WEB_DB_PATH: join(dir, "api.sqlite"),
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const session = await loginAndAcquireLease(app);
      const opened = await app.fetch(
        new Request("http://localhost:8787/api/workspaces/open", {
          body: JSON.stringify({ path: workspacePath }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      const workspace = (await opened.json()) as { id: number };
      const response = await app.fetch(
        new Request("http://localhost:8787/api/threads/thread-1/turns", {
          body: JSON.stringify({ input: "do not replay", workspaceId: workspace.id }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(response.status, 400);
      assert.equal(appServer.turnStartCalls.length, 1);
    } finally {
      await app.close();
    }
  });
});

test("runtime and audit events still avoid raw prompt output diff payload persistence", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "api.sqlite");
    const appServer = new FakeAppServerRuntime();
    const app = await createCodexWebApp({
      appServer,
      env: {
        CODEX_WEB_DB_PATH: dbPath,
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      const session = await loginAndAcquireLease(app);
      appServer.emitServerRequest("approval-persist", "item/fileChange/requestApproval", {
        changes: [{ diff: "SECRET_DIFF", path: "src/secret.ts" }],
        commandOutput: "SECRET_OUTPUT",
        prompt: "SECRET_PROMPT",
        reasoning: "SECRET_REASONING",
        rawPayload: { body: "SECRET_BODY" },
      });
      await app.fetch(new Request("http://localhost:8787/api/state", { headers: leaseHeaders(session) }));
    } finally {
      await app.close();
    }
    const { applyMigrations, openDatabase } = await import("../../src/server/db.ts");
    const db = openDatabase(dbPath);
    try {
      applyMigrations(db);
      const snapshot = JSON.stringify(db.prepare("SELECT * FROM runtime_events").all()) + JSON.stringify(db.prepare("SELECT * FROM approval_events").all());
      for (const forbidden of ["SECRET_DIFF", "SECRET_OUTPUT", "SECRET_PROMPT", "SECRET_REASONING", "SECRET_BODY", "rawPayload"]) {
        assert(!snapshot.includes(forbidden), `${forbidden} should not be persisted`);
      }
    } finally {
      db.close();
    }
  });
});

test("stdout and stderr redaction and caps survive reconnect recovery work", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  class FakeProcess extends EventEmitter implements AppServerProcess {
    pid = 123;
    stderr = new PassThrough();
    stdin = new PassThrough();
    stdout = new PassThrough();
    kill(): boolean {
      this.emit("exit", 0, null);
      return true;
    }
  }
  const process = new FakeProcess();
  const client = new AppServerClient({ codexBin: "codex", createProcess: () => process, stderrLimit: 60, timeoutMs: 1_000 });
  const started = client.start();
  await Promise.resolve();
  process.stderr.write("token=SECRET prompt private body diff C:\\Users\\aokuni\\repo\n");
  process.stdout.write("{not json with command output private body}\n");
  process.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
  await started;

  const diagnostics = JSON.stringify(client.diagnostics());
  assert(diagnostics.length < 180);
  assert(!diagnostics.includes("SECRET"));
  assert(!diagnostics.includes("private body"));
  assert(!diagnostics.includes("C:\\Users\\aokuni"));
  await client.close();
});
