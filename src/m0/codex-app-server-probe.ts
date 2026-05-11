import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { JsonRpcLineBuffer, JsonRpcPeer, type JsonRpcMessage, type JsonValue } from "./json-rpc.ts";
import { redactForReport } from "./redaction.ts";

const root = resolve(import.meta.dirname, "../..");
const reportOut = resolve(root, "docs/m0/probe-result.redacted.json");

type ProbeStep = {
  elapsedMs: number;
  method: string;
  ok: boolean;
  resultSummary?: unknown;
  error?: string;
};

type AppServerProbeResult = {
  codexBin: string;
  startedAt: string;
  steps: ProbeStep[];
  notifications: unknown[];
  stderrSummary: string[];
  pid?: number;
};

class AppServerStdioClient {
  readonly notifications: JsonRpcMessage[] = [];
  readonly peer: JsonRpcPeer;
  #buffer = new JsonRpcLineBuffer();
  #child: ChildProcessWithoutNullStreams;
  #stderr = "";

  constructor(command: string, args: string[]) {
    this.#child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        CODEX_M0_PROBE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.peer = new JsonRpcPeer((line) => this.#child.stdin.write(line), {
      onNotification: (message) => {
        this.notifications.push(message);
      },
    });
    this.#child.stdout.on("data", (chunk) => {
      for (const message of this.#buffer.push(chunk)) {
        this.peer.receive(message);
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = tail(this.#stderr + chunk);
    });
    this.#child.on("close", (code, signal) => {
      this.peer.rejectAll(new Error(`app-server exited code=${String(code)} signal=${String(signal)}`));
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  async request(method: string, params?: JsonValue, timeoutMs = 20_000): Promise<JsonValue | undefined> {
    const pending = this.peer.request(method, params);
    return await withTimeout(pending.response, timeoutMs, method);
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null) {
      return;
    }
    this.#child.stdin.end();
    this.#child.kill();
    await delay(500);
    if (this.#child.exitCode === null) {
      this.#child.kill("SIGKILL");
    }
  }
}

async function main(): Promise<void> {
  const codexBin = process.env.CODEX_WEB_CODEX_BIN || "codex";
  const client = new AppServerStdioClient(codexBin, ["app-server", "--listen", "stdio://"]);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const steps: ProbeStep[] = [];

  async function probe(method: string, params?: JsonValue, timeoutMs?: number): Promise<JsonValue | undefined> {
    try {
      const result = await client.request(method, params, timeoutMs);
      steps.push({
        elapsedMs: Math.round(performance.now() - start),
        method,
        ok: true,
        resultSummary: summarize(result),
      });
      return result;
    } catch (error) {
      steps.push({
        elapsedMs: Math.round(performance.now() - start),
        method,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  try {
    const initialize = await probe("initialize", {
      clientInfo: { name: "codex_web_m0", title: "codex-web M0 probe", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });

    await probe("model/list", { limit: 20, includeHidden: false });
    await probe("thread/list", { sourceKinds: ["appServer", "cli", "vscode"], limit: 10 });
    await probe("windowsSandbox/readiness", undefined, 10_000);

    const prompt = readArg("--prompt") ?? "M0 smoke: reply with one short sentence.";
    const cwd = readArg("--cwd") ?? root;
    const thread = await probe("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      threadSource: "user",
      sessionStartSource: "startup",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      model: readArg("--model"),
    });
    const threadId = pickString(thread, ["threadId", "id"]) ?? pickNestedString(thread, ["thread", "id"]);

    if (threadId) {
      const turn = await probe("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      }, 60_000);
      const turnId = pickString(turn, ["turnId", "id"]) ?? pickNestedString(turn, ["turn", "id"]);
      await waitForStreamingWindow(client, 20_000);
      if (turnId) {
        await probe("turn/interrupt", { threadId, turnId }, 10_000);
      } else {
        await probe("turn/interrupt", { threadId }, 10_000);
      }
      await probe("thread/resume", { threadId, cwd, persistExtendedHistory: false }, 20_000);
    }

    if (!initialize) {
      process.exitCode = 1;
    }
  } finally {
    const result: AppServerProbeResult = {
      codexBin,
      startedAt,
      pid: client.pid,
      steps,
      notifications: client.notifications.slice(0, 30).map((message) => summarize(message)),
      stderrSummary: summarizeStderr(client.stderrTail),
    };
    await mkdir(resolve(root, "docs/m0"), { recursive: true });
    await writeFile(reportOut, `${JSON.stringify(redactForReport(result), null, 2)}\n`);
    console.log(JSON.stringify(redactForReport(result), null, 2));
    await client.close();
  }
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  for (const key of keys) {
    const nested = (value as Record<string, unknown>)[key];
    if (typeof nested === "string") {
      return nested;
    }
  }
  return undefined;
}

function pickNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function summarize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, sample: value.slice(0, 3).map(summarize) };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const summary: Record<string, unknown> = { keys: entries.map(([key]) => key).slice(0, 20) };
  for (const key of ["id", "threadId", "turnId", "method", "type", "sourceKind", "model", "status", "approvalPolicy", "approvalsReviewer"]) {
    if (key in (value as Record<string, unknown>)) {
      summary[key] = (value as Record<string, unknown>)[key];
    }
  }
  const threadId = pickNestedString(value, ["thread", "id"]);
  if (threadId) {
    summary.threadId = threadId;
  }
  const turnId = pickNestedString(value, ["turn", "id"]);
  if (turnId) {
    summary.turnId = turnId;
    summary.turnStatus = pickNestedString(value, ["turn", "status"]);
  }
  return summary;
}

async function waitForStreamingWindow(client: AppServerStdioClient, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const hasTurnTerminalEvent = client.notifications.some((notification) => {
      const method = notification.method ?? "";
      return method === "turn/completed" || method === "turn/failed";
    });
    const hasStreamingSignal = client.notifications.some((notification) => {
      const method = notification.method ?? "";
      return method.includes("delta") || method.includes("item") || method.startsWith("turn/");
    });
    if (hasTurnTerminalEvent || (hasStreamingSignal && Date.now() - started > 3_000)) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      return;
    }
    await delay(250);
  }
}

function summarizeStderr(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-20)
    .map((line) => {
      let summary = line;
      summary = summary.replace(/<html>[\s\S]*/i, "<html redacted>");
      summary = summary.replace(/failed with status ([0-9]{3} [^:]+):.*/i, "failed with status $1: <body redacted>");
      summary = summary.length > 500 ? `${summary.slice(0, 500)}...<truncated>` : summary;
      return summary;
    });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = delay(timeoutMs).then(() => {
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
  });
  return await Promise.race([promise, timeout]);
}

function tail(value: string): string {
  return value.length > 32_768 ? value.slice(-32_768) : value;
}

await main();
