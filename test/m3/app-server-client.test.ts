import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AppServerClient,
  APP_SERVER_ALLOWED_METHODS,
  codexAppServerSpawnOptions,
  type AppServerProcess,
} from "../../src/server/app-server-client.ts";

class FakeProcess extends EventEmitter implements AppServerProcess {
  killed = false;
  pid = 1234;
  stderr = new PassThrough();
  stdin = new PassThrough();
  stdout = new PassThrough();
  writes: Array<{ id: number; method: string; params?: unknown }> = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      this.writes.push(JSON.parse(chunk.toString("utf8")) as { id: number; method: string; params?: unknown });
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

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
}

function makeClient(options: { stderrLimit?: number; timeoutMs?: number } = {}): { client: AppServerClient; process: FakeProcess } {
  const process = new FakeProcess();
  const client = new AppServerClient({
    codexBin: "codex",
    createProcess: () => process,
    stderrLimit: options.stderrLimit,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  return { client, process };
}

async function startInitialized(): Promise<{ client: AppServerClient; process: FakeProcess }> {
  const pair = makeClient();
  const started = pair.client.start();
  await Promise.resolve();
  pair.process.respond(1, { userAgent: "test" });
  await started;
  return pair;
}

test("AppServerClient starts codex app-server over stdio and sends codex_web initialize params", async () => {
  const { client, process } = makeClient();
  const started = client.start();
  await Promise.resolve();

  assert.deepEqual(process.writes[0], {
    id: 1,
    method: "initialize",
    params: {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "codex_web", title: "codex-web", version: "0.0.0" },
    },
  });

  process.respond(1, { platformOs: "windows" });
  await started;
  assert.equal(client.state.status, "ready");
  await client.close();
});

test("AppServerClient matches JSON-RPC responses by id when responses arrive out of order", async () => {
  const { client, process } = await startInitialized();

  const models = client.modelList();
  const threads = client.threadList({ limit: 1, sourceKinds: ["appServer", "cli", "vscode"] });
  assert.equal(process.writes[1]?.method, "model/list");
  assert.equal(process.writes[2]?.method, "thread/list");

  process.respond(3, { data: [{ id: "t1" }], nextCursor: null, backwardsCursor: null });
  process.respond(2, { data: [{ id: "m1" }], nextCursor: null });

  assert.deepEqual(await models, { data: [{ id: "m1" }], nextCursor: null });
  assert.deepEqual(await threads, { data: [{ id: "t1" }], nextCursor: null, backwardsCursor: null });
  await client.close();
});

test("AppServerClient routes server notifications without resolving pending requests", async () => {
  const { client, process } = await startInitialized();
  const notifications: unknown[] = [];
  client.on("notification", (event) => notifications.push(event));

  const pending = client.threadRead({ threadId: "t1", includeTurns: false });
  process.notify("turn/started", { turn: { id: "turn1" } });
  process.respond(2, { thread: { id: "t1" } });

  assert.deepEqual(await pending, { thread: { id: "t1" } });
  assert.deepEqual(notifications, [{ method: "turn/started", params: { turn: { id: "turn1" } } }]);
  await client.close();
});

test("AppServerClient reflects process exit and rejects pending requests", async () => {
  const { client, process } = await startInitialized();
  const pending = client.threadRead({ threadId: "t1" });

  process.emit("exit", 1, null);

  assert.equal(client.state.status, "exited");
  await assert.rejects(pending, /app-server exited/i);
});

test("AppServerClient exposes only allow-listed semantic wrapper methods", async () => {
  assert.deepEqual(APP_SERVER_ALLOWED_METHODS, [
    "model/list",
    "thread/list",
    "thread/read",
    "thread/turns/list",
    "thread/start",
    "thread/resume",
    "thread/unsubscribe",
    "turn/start",
    "turn/interrupt",
  ]);

  const { client } = makeClient();
  assert.equal("send" in client, false);
  assert.equal("request" in client, false);
});

test("AppServerClient caps and redacts stdout and stderr diagnostics", async () => {
  const { client, process } = makeClient({ stderrLimit: 90, timeoutMs: 1_000 });
  const started = client.start();
  await Promise.resolve();
  process.stderr.write("secret token=abc prompt private body C:\\Users\\aokuni\\repo\n");
  process.stdout.write("{not json with prompt private body}\n");
  process.respond(1, { ok: true });
  await started;

  const diagnostics = client.diagnostics();
  assert(diagnostics.stderr.length <= 90);
  assert(diagnostics.stdout.length <= 90);
  assert(!JSON.stringify(diagnostics).includes("private body"));
  assert(!JSON.stringify(diagnostics).includes("C:\\Users\\aokuni"));
  await client.close();
});

test("codex app-server spawn options can launch Windows command shims", () => {
  const cmdOptions = codexAppServerSpawnOptions("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd");
  assert.equal(cmdOptions.shell, process.platform === "win32");
  assert.equal(cmdOptions.windowsHide, true);

  const exeOptions = codexAppServerSpawnOptions("C:\\Tools\\codex.exe");
  assert.equal(exeOptions.shell, false);
});
