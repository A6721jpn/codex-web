import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexWebApp } from "../../src/server/app.ts";
import { FakeAppServerRuntime } from "../../src/server/chat-runtime.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-m4-api-"));
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

test("GET /api/approvals is authenticated and active-lease gated", async () => {
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
      assert.equal((await app.fetch(new Request("http://localhost:8787/api/approvals"))).status, 401);
      const session = await loginAndAcquireLease(app);
      assert.equal((await app.fetch(new Request("http://localhost:8787/api/approvals", { headers: { cookie: session.cookie } }))).status, 403);
      const ok = await app.fetch(new Request("http://localhost:8787/api/approvals", { headers: leaseHeaders(session) }));
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { approvals: [] });
    } finally {
      await app.close();
    }
  });
});

test("decision route requires auth active lease and CSRF, and invalid decisions are 400", async () => {
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
      appServer.emitServerRequest("approval-1", "item/commandExecution/requestApproval", { command: "echo secret", cwd: "C:\\repo" });

      const unauth = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-1/decision", {
          body: JSON.stringify({ decision: "approve" }),
          method: "POST",
        }),
      );
      assert.equal(unauth.status, 401);

      const missingLease = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-1/decision", {
          body: JSON.stringify({ decision: "approve" }),
          headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(missingLease.status, 403);

      const missingCsrf = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-1/decision", {
          body: JSON.stringify({ decision: "approve" }),
          headers: { ...leaseHeaders(session), "content-type": "application/json" },
          method: "POST",
        }),
      );
      assert.equal(missingCsrf.status, 403);

      const invalid = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-1/decision", {
          body: JSON.stringify({ decision: "accept", method: "raw" }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(invalid.status, 400);
      assert.equal(appServer.approvalResponses.length, 0);
    } finally {
      await app.close();
    }
  });
});

test("stale lease approval decisions are rejected and duplicate decisions do not double-send", async () => {
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
      appServer.emitServerRequest("approval-2", "item/permissions/requestApproval", { permission: { id: "workspace-write" } });

      const stale = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-2/decision", {
          body: JSON.stringify({ decision: "approve" }),
          headers: {
            ...leaseHeaders(session),
            "content-type": "application/json",
            "x-codex-connection-epoch": String(session.lease.epoch - 1),
            "x-csrf-token": session.csrfToken,
          },
          method: "POST",
        }),
      );
      assert.equal(stale.status, 403);

      const first = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-2/decision", {
          body: JSON.stringify({ decision: "approve", scope: "session" }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(first.status, 200);

      const duplicate = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-2/decision", {
          body: JSON.stringify({ decision: "reject" }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(duplicate.status, 409);
      assert.deepEqual(appServer.approvalResponses, [{ decision: "approve", requestId: "approval-2", scope: "session" }]);
    } finally {
      await app.close();
    }
  });
});

test("fake app-server approval request flows through semantic UI metadata to app-server response", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "repo");
    await mkdir(workspacePath);
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
      appServer.emitServerRequest("approval-3", "item/commandExecution/requestApproval", {
        command: "curl https://api.example.com/private?token=SECRET",
        cwd: workspacePath,
        networkApprovalContext: { host: "api.example.com", port: 443, protocol: "https" },
      });

      const listed = await app.fetch(new Request("http://localhost:8787/api/approvals", { headers: leaseHeaders(session) }));
      const body = (await listed.json()) as { approvals: Array<{ id: string; kind: string; metadata: Record<string, unknown> }> };
      assert.equal(body.approvals.length, 1);
      assert.equal(body.approvals[0]?.id, "approval-3");
      assert.equal(body.approvals[0]?.kind, "command");
      assert.deepEqual(body.approvals[0]?.metadata.network, { host: "api.example.com", port: 443, protocol: "https" });
      assert(!JSON.stringify(body).includes("SECRET"));
      assert(!("method" in body.approvals[0]!));
      assert(!("params" in body.approvals[0]!));

      const rawBody = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-3/decision", {
          body: JSON.stringify({ decision: "reject", params: { raw: true } }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(rawBody.status, 400);
      assert.equal(appServer.approvalResponses.length, 0);

      const decision = await app.fetch(
        new Request("http://localhost:8787/api/approvals/approval-3/decision", {
          body: JSON.stringify({ decision: "reject" }),
          headers: { ...leaseHeaders(session), "content-type": "application/json", "x-csrf-token": session.csrfToken },
          method: "POST",
        }),
      );
      assert.equal(decision.status, 200);
      assert.deepEqual(appServer.approvalResponses, [{ decision: "reject", requestId: "approval-3", scope: "turn" }]);
    } finally {
      await app.close();
    }
  });
});

test("server request without an active lease is fail-closed with cancel response", async () => {
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
      appServer.emitServerRequest("approval-no-lease", "item/commandExecution/requestApproval", { command: "echo secret" });
      await Promise.resolve();
      assert.deepEqual(appServer.approvalResponses, [{ decision: "cancel", requestId: "approval-no-lease", scope: "turn" }]);
    } finally {
      await app.close();
    }
  });
});

test("browser approval API has no raw RPC or arbitrary method forwarder", async () => {
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
      for (const path of ["/api/rpc", "/api/json-rpc", "/api/app-server", "/api/approvals/rpc"]) {
        const response = await app.fetch(
          new Request(`http://localhost:8787${path}`, {
            body: JSON.stringify({ method: "item/commandExecution/approve", params: { raw: true } }),
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
