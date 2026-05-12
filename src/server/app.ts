import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

import { AuthService, readCookie } from "./auth.ts";
import { AppServerClient } from "./app-server-client.ts";
import {
  ApprovalStore,
  DuplicateApprovalDecisionError,
  InvalidApprovalDecisionError,
  StaleApprovalLeaseError,
  type ApprovalDecision,
  type ApprovalScope,
} from "./approvals.ts";
import { ChatRuntime, type AppServerRuntime } from "./chat-runtime.ts";
import { ConnectionLeaseManager } from "./connection-lease.ts";
import { getConfig, type CodexWebConfig } from "./config.ts";
import { applyMigrations, openDatabase, type CodexWebDatabase } from "./db.ts";
import { requestHeaders, validateCsrf } from "./security.ts";
import { ThreadIndexStore } from "./thread-index.ts";
import { WorkspaceStore } from "./workspace.ts";
import { WebSocketTicketStore } from "./ws-ticket.ts";

export type CodexWebApp = {
  close: () => Promise<void>;
  config: CodexWebConfig;
  fetch: (request: Request) => Promise<Response>;
  handleUpgrade: (request: Request, socket: Duplex) => Promise<void>;
};

export async function createCodexWebApp(input: { appServer?: AppServerRuntime; env?: NodeJS.ProcessEnv } = {}): Promise<CodexWebApp> {
  const config = await getConfig(input.env ?? process.env);
  const db = openDatabase(config.dbPath);
  applyMigrations(db);
  const auth = new AuthService(db, { sessionSecret: config.sessionSecret });
  const tickets = new WebSocketTicketStore(db, { secret: config.sessionSecret });
  const leases = new ConnectionLeaseManager(db, { secret: config.sessionSecret });
  const threads = new ThreadIndexStore(db);
  const workspaces = new WorkspaceStore(db);
  const approvals = new ApprovalStore(db);
  const appServer = input.appServer ?? new AppServerClient({ codexBin: config.codexBin });
  const runtime = new ChatRuntime({
    appServer,
    approvals,
    getActiveLease: () => currentActiveLease(db),
    threads,
    workspaces,
  });
  const sockets = new Map<string, Duplex>();
  leases.on("revoked", (event: { connectionId?: string; reason: string }) => {
    if (!event.connectionId) {
      return;
    }
    const socket = sockets.get(event.connectionId);
    if (socket) {
      sendWebSocketJson(socket, { reason: event.reason, type: "connection.revoked" });
      socket.end();
      sockets.delete(event.connectionId);
    }
  });

  return {
    close: async () => {
      await runtime.close();
      db.close();
    },
    config,
    fetch: async (request) => await routeRequest({ auth, config, db, leases, request, runtime, threads, tickets, workspaces }),
    handleUpgrade: async (request, socket) => {
      await handleUpgrade({ auth, config, leases, request, socket, sockets, tickets });
    },
  };
}

async function routeRequest(input: {
  auth: AuthService;
  config: CodexWebConfig;
  db: CodexWebDatabase;
  leases: ConnectionLeaseManager;
  request: Request;
  runtime: ChatRuntime;
  threads: ThreadIndexStore;
  tickets: WebSocketTicketStore;
  workspaces: WorkspaceStore;
}): Promise<Response> {
  const url = new URL(input.request.url);
  if (url.pathname === "/api/rpc" || url.pathname === "/api/json-rpc") {
    return json({ error: "Not found" }, 404);
  }

  if (input.request.method === "GET" && url.pathname === "/api/status") {
    return json({ ok: true, setupRequired: input.auth.needsSetup() });
  }
  if (input.request.method === "GET" && url.pathname === "/api/csrf") {
    const session = readAuthenticatedSession(input.auth, input.request);
    return json({ csrfToken: session ? undefined : "preauth" });
  }
  if (input.request.method === "GET" && url.pathname === "/api/auth/status") {
    const session = readAuthenticatedSession(input.auth, input.request);
    return json({ authenticated: Boolean(session), setupRequired: input.auth.needsSetup() });
  }

  if (input.request.method === "POST" && url.pathname === "/api/auth/setup") {
    const csrf = validateCsrf({
      expectedToken: "preauth",
      headers: requestHeaders(input.request),
      method: input.request.method,
      publicOrigin: input.config.publicOrigin,
    });
    if (!csrf.ok) {
      return json({ error: csrf.reason }, 403);
    }
    const body = (await input.request.json()) as { password?: string };
    await input.auth.setupPassword(body.password ?? "");
    return json({ ok: true });
  }

  if (input.request.method === "POST" && url.pathname === "/api/auth/login") {
    const csrf = validateCsrf({
      expectedToken: "preauth",
      headers: requestHeaders(input.request),
      method: input.request.method,
      publicOrigin: input.config.publicOrigin,
    });
    if (!csrf.ok) {
      return json({ error: csrf.reason }, 403);
    }
    const body = (await input.request.json()) as { password?: string };
    const result = await input.auth.login(body.password ?? "", {
      ip: input.request.headers.get("x-forwarded-for") ?? "local",
      userAgent: input.request.headers.get("user-agent") ?? "",
    });
    return json({ csrfToken: result.csrfToken, ok: true }, 200, { "set-cookie": result.setCookie });
  }

  const session = readAuthenticatedSession(input.auth, input.request);
  if (!session) {
    return json({ error: "Authentication required" }, 401);
  }
  const csrfToken = input.request.headers.get("x-csrf-token") ?? undefined;
  if (!["GET", "HEAD", "OPTIONS"].includes(input.request.method) && !input.auth.validateCsrfToken(session, csrfToken)) {
    return json({ error: "CSRF token rejected" }, 403);
  }

  if (input.request.method === "POST" && url.pathname === "/api/auth/logout") {
    input.auth.logout(readCookie(input.request.headers.get("cookie"), input.auth.cookieName()));
    return json({ ok: true }, 200, {
      "set-cookie": `${input.auth.cookieName()}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
    });
  }

  if (input.request.method === "POST" && url.pathname === "/api/ws-ticket") {
    return json({ ticket: input.tickets.issue(session.sessionHash) });
  }

  if (input.request.method === "POST" && url.pathname === "/api/connection/takeover") {
    const body = (await input.request.json()) as { password?: string };
    const lease = await input.leases.takeover({
      auth: input.auth,
      deviceLabel: "browser",
      deviceSessionId: session.deviceSessionId,
      password: body.password ?? "",
      userAgent: input.request.headers.get("user-agent") ?? "",
    });
    return json(lease);
  }

  if (input.request.method === "GET" && url.pathname === "/api/workspaces") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    return json(input.workspaces.list());
  }

  if (input.request.method === "POST" && url.pathname === "/api/workspaces/open") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    const body = (await input.request.json()) as { path?: string };
    try {
      return json(await input.workspaces.open(body.path ?? ""));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Workspace rejected" }, 400);
    }
  }

  if (input.request.method === "GET" && url.pathname === "/api/threads") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    try {
      return json(input.threads.list({ cursor, limit: Number.isFinite(limit) ? limit : 50 }));
    } catch {
      return json({ error: "Invalid cursor" }, 400);
    }
  }

  if (input.request.method === "GET" && url.pathname === "/api/approvals") {
    const lease = readActiveLease(input.leases, input.request);
    if (!lease) {
      return json({ error: "Active connection required" }, 403);
    }
    return json({ approvals: input.runtime.listApprovals(lease).map(publicApproval) });
  }

  const approvalDecisionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if (approvalDecisionMatch && input.request.method === "POST") {
    const lease = readActiveLease(input.leases, input.request);
    if (!lease) {
      return json({ error: "Active connection required" }, 403);
    }
    const body = await readJsonBody<{ decision?: unknown; scope?: unknown }>(input.request);
    if (!hasOnlyKeys(body, ["decision", "scope"])) {
      return json({ error: "Invalid approval decision" }, 400);
    }
    if (!isApprovalDecision(body.decision) || (body.scope !== undefined && !isApprovalScope(body.scope))) {
      return json({ error: "Invalid approval decision" }, 400);
    }
    try {
      return json(
        await input.runtime.decideApproval(decodeURIComponent(approvalDecisionMatch[1]!), lease, {
          decision: body.decision,
          scope: body.scope,
        }),
      );
    } catch (error) {
      if (error instanceof InvalidApprovalDecisionError) {
        return json({ error: error.message }, 400);
      }
      if (error instanceof StaleApprovalLeaseError) {
        return json({ error: error.message }, 403);
      }
      if (error instanceof DuplicateApprovalDecisionError) {
        return json({ error: error.message }, 409);
      }
      return json({ error: error instanceof Error ? error.message : "Approval decision failed" }, 503);
    }
  }

  if (input.request.method === "POST" && url.pathname === "/api/threads/refresh") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    const body = await readJsonBody<{ pageSize?: number }>(input.request);
    try {
      return json(await input.runtime.refreshThreads({ pageSize: sanitizeLimit(body.pageSize, 50) }));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Thread refresh failed" }, 503);
    }
  }

  if (input.request.method === "POST" && url.pathname === "/api/threads/start") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    const body = await readJsonBody<{ prompt?: string; workspaceId?: number }>(input.request);
    const workspaceId = integerBodyValue(body.workspaceId);
    if (workspaceId === undefined) {
      return json({ error: "workspaceId is required" }, 400);
    }
    try {
      return json(await input.runtime.startThread({ prompt: body.prompt, workspaceId }));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Thread start failed" }, 400);
    }
  }

  const threadTurnsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
  if (threadTurnsMatch && input.request.method === "GET") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    try {
      return json(
        await input.runtime.listTurns({
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: sanitizeLimit(Number(url.searchParams.get("limit") ?? "50"), 50),
          threadId: decodeURIComponent(threadTurnsMatch[1]!),
        }),
      );
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Turn list failed" }, 503);
    }
  }

  if (threadTurnsMatch && input.request.method === "POST") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    const body = await readJsonBody<{ input?: string; workspaceId?: number }>(input.request);
    const workspaceId = integerBodyValue(body.workspaceId);
    if (workspaceId === undefined || typeof body.input !== "string" || !body.input.trim()) {
      return json({ error: "workspaceId and input are required" }, 400);
    }
    try {
      return json(
        await input.runtime.startTurn({
          input: body.input,
          threadId: decodeURIComponent(threadTurnsMatch[1]!),
          workspaceId,
        }),
      );
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Turn start failed" }, 400);
    }
  }

  const threadResumeMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/resume$/);
  if (threadResumeMatch && input.request.method === "POST") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    const body = await readJsonBody<{ workspaceId?: number }>(input.request);
    const workspaceId = integerBodyValue(body.workspaceId);
    if (workspaceId === undefined) {
      return json({ error: "workspaceId is required" }, 400);
    }
    try {
      return json(
        await input.runtime.resumeThread({
          threadId: decodeURIComponent(threadResumeMatch[1]!),
          workspaceId,
        }),
      );
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Thread resume failed" }, 400);
    }
  }

  const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (threadMatch && input.request.method === "GET") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    try {
      return json(await input.runtime.readThread({ includeTurns: false, threadId: decodeURIComponent(threadMatch[1]!) }));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Thread read failed" }, 503);
    }
  }

  const turnInterruptMatch = url.pathname.match(/^\/api\/turns\/([^/]+)\/interrupt$/);
  if (turnInterruptMatch && input.request.method === "POST") {
    if (!canUseActiveLease(input.leases, input.request)) {
      return json({ error: "Active connection required" }, 403);
    }
    const body = await readJsonBody<{ threadId?: string }>(input.request);
    if (typeof body.threadId !== "string" || !body.threadId) {
      return json({ error: "threadId is required" }, 400);
    }
    try {
      return json(
        await input.runtime.interruptTurn({
          threadId: body.threadId,
          turnId: decodeURIComponent(turnInterruptMatch[1]!),
        }),
      );
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Turn interrupt failed" }, 503);
    }
  }

  return json({ error: "Not found" }, 404);
}

async function handleUpgrade(input: {
  auth: AuthService;
  config: CodexWebConfig;
  leases: ConnectionLeaseManager;
  request: Request;
  socket: Duplex;
  sockets: Map<string, Duplex>;
  tickets: WebSocketTicketStore;
}): Promise<void> {
  const url = new URL(input.request.url);
  const origin = input.request.headers.get("origin");
  const host = input.request.headers.get("host");
  const expectedHost = new URL(input.config.publicOrigin).host;
  const session = readAuthenticatedSession(input.auth, input.request);
  const ticket = url.searchParams.get("ticket");
  if (url.pathname !== "/ws" || !session || !ticket || origin !== input.config.publicOrigin || host !== expectedHost) {
    input.socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  if (!input.tickets.consume(ticket, session.sessionHash)) {
    input.socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }

  const lease = input.leases.acquire(session.deviceSessionId, "browser", input.request.headers.get("user-agent") ?? "");
  if (lease.state === "busy") {
    input.socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
    return;
  }
  const key = input.request.headers.get("sec-websocket-key");
  if (!key) {
    input.socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  input.socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${webSocketAccept(key)}`,
      "\r\n",
    ].join("\r\n"),
  );
  input.sockets.set(lease.connectionId, input.socket);
  input.socket.on("close", () => input.sockets.delete(lease.connectionId));
  input.socket.on("end", () => input.sockets.delete(lease.connectionId));
  sendWebSocketJson(input.socket, {
    connectionId: lease.connectionId,
    epoch: lease.epoch,
    fencingToken: lease.fencingToken,
    leaseExpiresAt: lease.leaseExpiresAt,
    type: "connection.ready",
  });
}

function readAuthenticatedSession(auth: AuthService, request: Request) {
  return auth.readSession(readCookie(request.headers.get("cookie"), auth.cookieName()));
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    status,
  });
}

function canUseActiveLease(leases: ConnectionLeaseManager, request: Request): boolean {
  return Boolean(readActiveLease(leases, request));
}

function readActiveLease(leases: ConnectionLeaseManager, request: Request): { connectionId: string; epoch: number; fencingToken: string } | undefined {
  const connectionId = request.headers.get("x-codex-connection-id");
  const epoch = Number(request.headers.get("x-codex-connection-epoch"));
  const fencingToken = request.headers.get("x-codex-fencing-token");
  return connectionId && Number.isInteger(epoch) && fencingToken && leases.canUse(connectionId, epoch, fencingToken)
    ? { connectionId, epoch, fencingToken }
    : undefined;
}

function currentActiveLease(db: CodexWebDatabase): { connectionId: string; epoch: number } | undefined {
  const row = db.prepare("SELECT connection_id, epoch, lease_expires_at FROM active_connection WHERE singleton_id = 1").get() as
    | { connection_id: string; epoch: number; lease_expires_at: number }
    | undefined;
  return row && row.lease_expires_at > Date.now() ? { connectionId: row.connection_id, epoch: row.epoch } : undefined;
}

async function readJsonBody<T extends Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function sanitizeLimit(value: unknown, fallback: number): number {
  const limit = typeof value === "number" ? value : Number(value);
  return Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 100)) : fallback;
}

function integerBodyValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "approve" || value === "reject" || value === "cancel";
}

function isApprovalScope(value: unknown): value is ApprovalScope {
  return value === "turn" || value === "session";
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function publicApproval(approval: ReturnType<ChatRuntime["listApprovals"]>[number]) {
  return {
    availableDecisions: approval.availableDecisions,
    defaultScope: approval.defaultScope,
    failClosed: approval.failClosed,
    id: approval.id,
    itemId: approval.itemId,
    kind: approval.kind,
    metadata: approval.metadata,
    threadId: approval.threadId,
    turnId: approval.turnId,
  };
}

function webSocketAccept(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function sendWebSocketJson(socket: Duplex, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  if (payload.length <= 125) {
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    return;
  }
  if (payload.length <= 65_535) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    socket.write(Buffer.concat([header, payload]));
    return;
  }
  throw new Error("M1 WebSocket frame too large");
}
