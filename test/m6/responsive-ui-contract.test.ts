import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexWebApp } from "../../src/server/app.ts";
import { FakeAppServerRuntime } from "../../src/server/chat-runtime.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-m6-"));
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

async function loginAndReconnect(app: { fetch: (request: Request) => Promise<Response> }): Promise<{
  cookie: string;
  csrfToken: string;
  lease: { connectionId: string; epoch: number; fencingToken: string };
}> {
  const session = await login(app);
  const response = await app.fetch(
    new Request("http://localhost:8787/api/connection/reconnect", {
      headers: { cookie: session.cookie, origin: "http://localhost:8787", "x-csrf-token": session.csrfToken },
      method: "POST",
    }),
  );
  return { ...session, lease: (await response.json()) as { connectionId: string; epoch: number; fencingToken: string } };
}

test("thread search term is handled by semantic thread route and filters server-side metadata", async () => {
  await withTempDir(async (dir) => {
    const appServer = new FakeAppServerRuntime({
      threadListPages: [
        {
          data: [
            { id: "alpha", name: "Alpha build", source: "appServer", updatedAt: 10 },
            { id: "beta", name: "Beta restore", source: "cli", updatedAt: 20 },
          ],
        },
      ],
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
      await setupPassword(app);
      const session = await loginAndReconnect(app);
      await app.fetch(
        new Request("http://localhost:8787/api/threads/refresh", {
          headers: { ...leaseHeaders(session), "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      const response = await app.fetch(new Request("http://localhost:8787/api/threads?search=restore", { headers: leaseHeaders(session) }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as { items: Array<{ id: string; title?: string }> };
      assert.deepEqual(body.items.map((thread) => thread.id), ["beta"]);
      assert(!JSON.stringify(body).includes("method"));
      assert(!JSON.stringify(body).includes("params"));
    } finally {
      await app.close();
    }
  });
});

test("last opened workspace and thread metadata is saved and restored", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "repo");
    await mkdir(workspacePath);
    const appServer = new FakeAppServerRuntime({
      threadListPages: [{ data: [{ cwd: workspacePath, id: "thread-last", name: "Last opened", source: "appServer", updatedAt: 42 }] }],
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
      await setupPassword(app);
      const session = await loginAndReconnect(app);
      const opened = await app.fetch(
        new Request("http://localhost:8787/api/workspaces/open", {
          body: JSON.stringify({ path: workspacePath }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      const workspace = (await opened.json()) as { id: number };
      await app.fetch(
        new Request("http://localhost:8787/api/threads/refresh", {
          headers: { ...leaseHeaders(session), "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      const before = Date.now();
      const active = await app.fetch(
        new Request("http://localhost:8787/api/ui/active", {
          body: JSON.stringify({ threadId: "thread-last", workspaceId: workspace.id }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(active.status, 200);

      const state = await app.fetch(new Request("http://localhost:8787/api/state", { headers: leaseHeaders(session) }));
      const body = (await state.json()) as {
        activeThreadId?: string;
        activeWorkspaceId?: number;
        threads: { items: Array<{ id: string; lastOpenedAt?: number }> };
        workspaces: Array<{ id: number; lastOpenedAt: number }>;
      };
      assert.equal(body.activeWorkspaceId, workspace.id);
      assert.equal(body.activeThreadId, "thread-last");
      assert((body.threads.items.find((thread) => thread.id === "thread-last")?.lastOpenedAt ?? 0) >= before);
      assert((body.workspaces.find((item) => item.id === workspace.id)?.lastOpenedAt ?? 0) >= before);
    } finally {
      await app.close();
    }
  });
});

test("non-active lease cannot read history or workspaces", async () => {
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
      await loginAndReconnect(app);
      const second = await login(app, "second-device");
      for (const path of ["/api/workspaces", "/api/threads", "/api/threads/thread-1", "/api/state"]) {
        const response = await app.fetch(new Request(`http://localhost:8787${path}`, { headers: { cookie: second.cookie } }));
        assert.equal(response.status, 403, path);
      }
    } finally {
      await app.close();
    }
  });
});

test("busy takeover UI state has a semantic API contract without lease secrets", async () => {
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
      const active = await loginAndReconnect(app);
      const status = await app.fetch(new Request("http://localhost:8787/api/connection/status", { headers: { cookie: active.cookie } }));
      assert.equal(status.status, 200);
      assert.equal(((await status.json()) as { state: string }).state, "active");

      const second = await login(app, "second-device");
      const busy = await app.fetch(new Request("http://localhost:8787/api/connection/status", { headers: { cookie: second.cookie } }));
      assert.equal(busy.status, 200);
      const body = (await busy.json()) as Record<string, unknown>;
      assert.equal(body.state, "busy");
      assert.equal(body.canTakeover, true);
      assert(!("fencingToken" in body));
      assert(!("connectionId" in body));
    } finally {
      await app.close();
    }
  });
});

test("client busy takeover collects password and restores state after success", async () => {
  const source = await readFile("src/client/main.tsx", "utf8");
  assert(source.includes("takeoverPassword"));
  assert(source.includes("Takeover password"));
  assert(source.includes("restoreState(takeoverLease)"));
  assert(source.includes("setTakeoverPassword(\"\")"));
});

test("client websocket keeps active lease alive and refreshes approvals on server events", async () => {
  const source = await readFile("src/client/main.tsx", "utf8");
  assert(source.includes("new WebSocket"));
  assert(source.includes("/api/ws-ticket"));
  assert(source.includes("connection.heartbeat"));
  assert(source.includes("approvals.changed"));
  assert(source.includes("refreshApprovals"));
});

test("approval decision route keeps M4 active lease CSRF and raw body constraints", async () => {
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
      await setupPassword(app);
      const session = await loginAndReconnect(app);
      appServer.emitServerRequest("approval-ui", "item/commandExecution/requestApproval", { command: "echo raw" });
      const missingLease = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-ui/decision", {
          body: JSON.stringify({ decision: "approve" }),
          headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(missingLease.status, 403);
      const rawBody = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-ui/decision", {
          body: JSON.stringify({ decision: "approve", method: "raw", params: { body: "SECRET" } }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(rawBody.status, 400);
      assert.equal(appServer.approvalResponses.length, 0);
    } finally {
      await app.close();
    }
  });
});

test("runtime error metadata for error cards redacts body-like content and is not persisted raw", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "api.sqlite");
    class FailingRefreshRuntime extends FakeAppServerRuntime {
      override async threadList(): Promise<unknown> {
        throw new Error("app-server unavailable prompt SECRET_PROMPT output SECRET_OUTPUT diff SECRET_DIFF body SECRET_BODY token=SECRET");
      }
    }
    const app = await createCodexWebApp({
      appServer: new FailingRefreshRuntime(),
      env: {
        CODEX_WEB_DB_PATH: dbPath,
        CODEX_WEB_PUBLIC_ORIGIN: "http://localhost:8787",
        CODEX_WEB_SESSION_SECRET: "s".repeat(32),
      },
    });
    try {
      await setupPassword(app);
      const session = await loginAndReconnect(app);
      const response = await app.fetch(new Request("http://localhost:8787/api/state", { headers: leaseHeaders(session) }));
      assert.equal(response.status, 503);
      const body = await response.text();
      for (const forbidden of ["SECRET_PROMPT", "SECRET_OUTPUT", "SECRET_DIFF", "SECRET_BODY", "token=SECRET"]) {
        assert(!body.includes(forbidden));
      }
    } finally {
      await app.close();
    }
  });
});

test("responsive UI source exposes chat layout search drawer busy approval and error card states", async () => {
  const source = await readFile("src/client/main.tsx", "utf8");
  for (const marker of [
    "conversation-layout",
    "history-drawer",
    "thread-search",
    "busy-card",
    "error-card",
    "approval-card",
    "lastOpenedAt",
  ]) {
    assert(source.includes(marker), marker);
  }
  assert(!source.includes("terminal"));
  assert(!source.includes("file tree"));
  assert(!source.includes("custom permission editor"));
});

test("responsive CSS covers phone tablet and desktop without one-note palette or nested cards", async () => {
  const css = await readFile("src/client/styles.css", "utf8");
  assert(css.includes("@media (max-width: 520px)"));
  assert(css.includes("@media (min-width: 521px) and (max-width: 760px)"));
  assert(css.includes("@media (min-width: 761px) and (max-width: 1024px)"));
  assert(css.includes("@media (min-width: 1025px)"));
  assert(css.includes("overflow-wrap: anywhere"));
  assert(!css.includes(".card .card"));
  for (const color of ["#174f3d", "#2563eb", "#a15c16"]) {
    assert(css.includes(color), color);
  }
});

test("UI routes still do not expose raw RPC endpoints", async () => {
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
      const session = await loginAndReconnect(app);
      for (const path of ["/api/rpc", "/api/json-rpc", "/api/app-server", "/api/ui/rpc"]) {
        const response = await app.fetch(
          new Request(`http://localhost:8787${path}`, {
            body: JSON.stringify({ method: "thread/list", params: { raw: true } }),
            headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
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
