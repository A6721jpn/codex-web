import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";

export const APP_SERVER_ALLOWED_METHODS = [
  "model/list",
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/start",
  "thread/resume",
  "thread/unsubscribe",
  "turn/start",
  "turn/interrupt",
] as const;

type AllowedMethod = (typeof APP_SERVER_ALLOWED_METHODS)[number];
type JsonRpcId = number | string;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };
type JsonRpcMessage = {
  error?: JsonValue;
  id?: JsonRpcId;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
};

export type AppServerProcess = EventEmitter & {
  kill: () => boolean;
  pid?: number;
  stderr: Readable;
  stdin: Writable;
  stdout: Readable;
};

export type AppServerState =
  | { status: "idle" }
  | { pid?: number; status: "starting"; startedAt: number }
  | { pid?: number; status: "ready"; startedAt: number }
  | { code: number | null; signal: NodeJS.Signals | null; status: "exited" }
  | { message: string; status: "failed" };

export type AppServerClientOptions = {
  codexBin: string;
  createProcess?: () => AppServerProcess;
  stderrLimit?: number;
  timeoutMs?: number;
};

type Pending = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

export class AppServerClient extends EventEmitter {
  #codexBin: string;
  #createProcess?: () => AppServerProcess;
  #nextId = 1;
  #pending = new Map<JsonRpcId, Pending>();
  #process?: AppServerProcess;
  #stderrTail = "";
  #stdoutTail = "";
  #tailLimit: number;
  #timeoutMs: number;
  state: AppServerState = { status: "idle" };

  constructor(options: AppServerClientOptions) {
    super();
    this.#codexBin = options.codexBin;
    this.#createProcess = options.createProcess;
    this.#tailLimit = options.stderrLimit ?? 16_384;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async start(): Promise<void> {
    if (this.state.status === "ready" || this.state.status === "starting") {
      return;
    }
    const startedAt = Date.now();
    const child = this.#createProcess ? this.#createProcess() : spawnCodexAppServer(this.#codexBin);
    this.#process = child;
    this.state = { pid: child.pid, startedAt, status: "starting" };
    child.stdout.on("data", (chunk) => this.#handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.#stderrTail = appendCapped(this.#stderrTail, redactDiagnostic(chunk.toString("utf8")), this.#tailLimit);
    });
    child.on("error", (error) => {
      this.state = { message: error.message, status: "failed" };
      this.#rejectAll(new Error(`app-server failed: ${error.message}`));
      this.emit("state", this.state);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.state = { code, signal, status: "exited" };
      this.#rejectAll(new Error(`app-server exited with code ${String(code)}`));
      this.emit("state", this.state);
    });

    await this.#request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "codex_web", title: "codex-web", version: "0.0.0" },
    });
    if (this.state.status === "starting") {
      this.state = { pid: child.pid, startedAt, status: "ready" };
      this.emit("state", this.state);
    }
  }

  async close(): Promise<void> {
    this.#rejectAll(new Error("app-server client closed"));
    const child = this.#process;
    this.#process = undefined;
    if (child && this.state.status !== "exited") {
      child.kill();
    }
    this.state = { status: "idle" };
  }

  diagnostics(): { stderr: string; stdout: string } {
    return { stderr: this.#stderrTail, stdout: this.#stdoutTail };
  }

  async modelList(params: Record<string, unknown> = {}): Promise<unknown> {
    return await this.#request("model/list", params);
  }

  async threadList(params: Record<string, unknown>): Promise<unknown> {
    return await this.#request("thread/list", params);
  }

  async threadRead(params: { includeTurns?: boolean; threadId: string }): Promise<unknown> {
    return await this.#request("thread/read", params);
  }

  async threadTurnsList(params: { cursor?: string; limit?: number; threadId: string }): Promise<unknown> {
    return await this.#request("thread/turns/list", params);
  }

  async threadStart(params: Record<string, unknown>): Promise<unknown> {
    return await this.#request("thread/start", params);
  }

  async threadResume(params: Record<string, unknown>): Promise<unknown> {
    return await this.#request("thread/resume", params);
  }

  async threadUnsubscribe(params: { threadId: string }): Promise<unknown> {
    return await this.#request("thread/unsubscribe", params);
  }

  async turnStart(params: Record<string, unknown>): Promise<unknown> {
    return await this.#request("turn/start", params);
  }

  async turnInterrupt(params: { threadId: string; turnId: string }): Promise<unknown> {
    return await this.#request("turn/interrupt", params);
  }

  async respondToServerRequest(input: { decision: string; requestId: JsonRpcId; scope?: string }): Promise<void> {
    const child = this.#process;
    if (!child || this.state.status === "failed" || this.state.status === "exited") {
      throw new Error("app-server unavailable");
    }
    const result: { decision: string; scope?: string } = { decision: input.decision };
    if (input.scope) {
      result.scope = input.scope;
    }
    child.stdin.write(`${JSON.stringify({ id: input.requestId, result })}\n`);
  }

  #handleStdout(chunk: Buffer | string): void {
    const lines = splitLines(this, chunk.toString("utf8"));
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        this.#receive(JSON.parse(line) as JsonRpcMessage);
      } catch {
        this.#stdoutTail = appendCapped(this.#stdoutTail, redactDiagnostic(line), this.#tailLimit);
        this.emit("protocolError", new Error("Invalid JSON-RPC stdout line"));
      }
    }
  }

  #receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.emit("orphanResponse", { id: message.id });
        return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(`JSON-RPC error for id ${String(message.id)}: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", { method: message.method, params: message.params, requestId: message.id });
      return;
    }
    if (message.method) {
      this.emit("notification", { method: message.method, params: message.params });
    }
  }

  #request(method: AllowedMethod | "initialize", params?: unknown): Promise<unknown> {
    const child = this.#process;
    if (!child || this.state.status === "failed" || this.state.status === "exited") {
      return Promise.reject(new Error("app-server unavailable"));
    }
    const id = this.#nextId++;
    const message: { id: number; method: string; params?: unknown } = { id, method };
    if (params !== undefined) {
      message.params = params;
    }
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { reject, resolve, timer });
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return response;
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

const stdoutBuffers = new WeakMap<AppServerClient, string>();

function splitLines(owner: AppServerClient, chunk: string): string[] {
  const previous = stdoutBuffers.get(owner) ?? "";
  const combined = previous + chunk;
  const parts = combined.split(/\n/);
  stdoutBuffers.set(owner, parts.pop() ?? "");
  return parts;
}

function spawnCodexAppServer(codexBin: string): ChildProcessWithoutNullStreams {
  return spawn(codexBin, ["app-server", "--listen", "stdio://"], codexAppServerSpawnOptions(codexBin));
}

export function codexAppServerSpawnOptions(codexBin: string): SpawnOptionsWithoutStdio {
  return {
    shell: process.platform === "win32" && /\.(?:bat|cmd)$/i.test(codexBin),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

function appendCapped(existing: string, next: string, limit: number): string {
  const combined = `${existing}${next}`;
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
}

function redactDiagnostic(value: string): string {
  const home = homedir();
  let redacted = value;
  if (home) {
    redacted = redacted.split(home).join("<USER_HOME>");
    redacted = redacted.split(home.replaceAll("\\", "\\\\")).join("<USER_HOME_ESCAPED>");
  }
  return redacted
    .replace(/[A-Z]:\\Users\\[^\\\r\n"]+/g, "<USER_HOME>")
    .replace(/[A-Z]:\\\\Users\\\\[^\\\r\n"]+/g, "<USER_HOME_ESCAPED>")
    .replace(/token=[^\s"'\\]+/gi, "token=<redacted>")
    .replace(/(prompt|message|reasoning|output|diff|body)\b[^}\r\n]*/gi, "$1=<redacted>");
}
