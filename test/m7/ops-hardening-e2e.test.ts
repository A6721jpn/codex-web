import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexWebApp } from "../../src/server/app.ts";
import { FakeAppServerRuntime } from "../../src/server/chat-runtime.ts";
import { applyMigrations, openDatabase } from "../../src/server/db.ts";
import { runPreflightChecks } from "../../src/server/preflight.ts";
import { readStaticAsset } from "../../src/server/static.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-m7-"));
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

async function setup(app: { fetch: (request: Request) => Promise<Response> }): Promise<void> {
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

async function reconnect(app: { fetch: (request: Request) => Promise<Response> }, session: { cookie: string; csrfToken: string }): Promise<{
  connectionId: string;
  epoch: number;
  fencingToken: string;
}> {
  const response = await app.fetch(
    new Request("http://localhost:8787/api/connection/reconnect", {
      headers: { cookie: session.cookie, origin: "http://localhost:8787", "x-csrf-token": session.csrfToken },
      method: "POST",
    }),
  );
  return (await response.json()) as { connectionId: string; epoch: number; fencingToken: string };
}

test("API responses include security headers and no-store on sensitive routes", async () => {
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
      const response = await app.fetch(new Request("http://localhost:8787/api/status"));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "same-origin");
      assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    } finally {
      await app.close();
    }
  });
});

test("static cache policy is safe and static responses include security headers", async () => {
  const html = await readStaticAsset("/", { root: process.cwd() });
  assert.equal(html.status, 200);
  assert.equal(html.headers["cache-control"], "no-cache");
  assert.equal(html.headers["x-content-type-options"], "nosniff");
  assert.match(html.headers["content-security-policy"], /default-src 'self'/);

  const asset = await readStaticAsset("/assets/app.abcdef12.js", { root: process.cwd() });
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
});

test("preflight redacts paths tokens and body-like text", async () => {
  const result = await runPreflightChecks({
    codexBin: "codex",
    runCommand: async (command) => ({
      ok: false,
      stderr: `${command} token=SECRET C:\\Users\\aokuni\\repo prompt SECRET_PROMPT output SECRET_OUTPUT diff SECRET_DIFF body SECRET_BODY`,
      stdout: "codex-cli 0.130.0-alpha.5",
    }),
  });
  const text = JSON.stringify(result);
  for (const forbidden of ["token=SECRET", "C:\\Users\\aokuni", "SECRET_PROMPT", "SECRET_OUTPUT", "SECRET_DIFF", "SECRET_BODY"]) {
    assert(!text.includes(forbidden), forbidden);
  }
});

test("E2E first setup login lease workspace and thread refresh happy path", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "repo");
    await mkdir(workspacePath);
    const appServer = new FakeAppServerRuntime({
      threadListPages: [{ data: [{ cwd: workspacePath, id: "thread-e2e", name: "E2E", source: "appServer", updatedAt: 1 }] }],
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
      await setup(app);
      const session = await login(app);
      const lease = await reconnect(app, session);
      const opened = await app.fetch(
        new Request("http://localhost:8787/api/workspaces/open", {
          body: JSON.stringify({ path: workspacePath }),
          headers: { ...leaseHeaders({ ...session, lease }), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(opened.status, 200);
      const refreshed = await app.fetch(
        new Request("http://localhost:8787/api/threads/refresh", {
          headers: { ...leaseHeaders({ ...session, lease }), "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(refreshed.status, 200);
      const threads = await app.fetch(new Request("http://localhost:8787/api/threads", { headers: leaseHeaders({ ...session, lease }) }));
      assert.equal(((await threads.json()) as { items: unknown[] }).items.length, 1);
    } finally {
      await app.close();
    }
  });
});

test("E2E approval request to UI metadata to decision", async () => {
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
      await setup(app);
      const session = await login(app);
      const lease = await reconnect(app, session);
      appServer.emitServerRequest("approval-e2e", "item/commandExecution/requestApproval", { command: "curl token=SECRET" });
      const listed = await app.fetch(new Request("http://localhost:8787/api/approvals", { headers: leaseHeaders({ ...session, lease }) }));
      const body = (await listed.json()) as { approvals: Array<{ id: string; metadata: { summary: string } }> };
      assert.equal(body.approvals[0]?.id, "approval-e2e");
      assert(!JSON.stringify(body).includes("SECRET"));
      const decision = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-e2e/decision", {
          body: JSON.stringify({ decision: "reject" }),
          headers: { ...leaseHeaders({ ...session, lease }), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(decision.status, 200);
      assert.deepEqual(appServer.approvalResponses, [{ decision: "reject", requestId: "approval-e2e", scope: "turn" }]);
    } finally {
      await app.close();
    }
  });
});

test("E2E second device busy and takeover path", async () => {
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
      await setup(app);
      const first = await login(app, "device-one");
      const firstLease = await reconnect(app, first);
      const second = await login(app, "device-two");
      const busy = await app.fetch(
        new Request("http://localhost:8787/api/connection/reconnect", {
          headers: { cookie: second.cookie, origin: "http://localhost:8787", "x-csrf-token": second.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(busy.status, 409);
      const takeover = await app.fetch(
        new Request("http://localhost:8787/api/connection/takeover", {
          body: JSON.stringify({ password: "pw-123456789" }),
          headers: { cookie: second.cookie, origin: "http://localhost:8787", "x-csrf-token": second.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(takeover.status, 200);
      const oldRead = await app.fetch(new Request("http://localhost:8787/api/workspaces", { headers: leaseHeaders({ ...first, lease: firstLease }) }));
      assert.equal(oldRead.status, 403);
    } finally {
      await app.close();
    }
  });
});

test("SQLite still does not persist prompt agent reasoning output diff or raw payload", async () => {
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
      await setup(app);
      const session = await login(app);
      const lease = await reconnect(app, session);
      appServer.emitServerRequest("approval-sqlite", "item/fileChange/requestApproval", {
        agent: "AGENT_MESSAGE",
        changes: [{ diff: "SECRET_DIFF", path: "src/file.ts" }],
        output: "SECRET_OUTPUT",
        prompt: "SECRET_PROMPT",
        rawPayload: { body: "SECRET_BODY" },
        reasoning: "SECRET_REASONING",
      });
      await app.fetch(new Request("http://localhost:8787/api/approvals", { headers: leaseHeaders({ ...session, lease }) }));
    } finally {
      await app.close();
    }
    const db = openDatabase(dbPath);
    try {
      applyMigrations(db);
      const snapshot = JSON.stringify(db.prepare("SELECT * FROM sqlite_master").all()) + JSON.stringify(db.prepare("SELECT * FROM approval_events").all());
      for (const forbidden of ["AGENT_MESSAGE", "SECRET_DIFF", "SECRET_OUTPUT", "SECRET_PROMPT", "SECRET_BODY", "SECRET_REASONING", "rawPayload"]) {
        assert(!snapshot.includes(forbidden), forbidden);
      }
    } finally {
      db.close();
    }
  });
});

test("README and ops doc cover Windows VPN HTTPS backup upgrade schema Error 1385 and process containment", async () => {
  const readme = await readFile("README.md", "utf8");
  const ops = await readFile("docs/m7-ops-hardening.md", "utf8");
  const combined = `${readme}\n${ops}`;
  for (const term of [
    "Windows Firewall",
    "VPN",
    "HTTPS",
    "WSS",
    "backup",
    "restore",
    "upgrade",
    "schema regeneration",
    "Error 1385",
    "process-tree containment",
    "CODEX_WEB_SESSION_SECRET",
    "npm run preflight",
  ]) {
    assert(combined.includes(term), term);
  }
});

