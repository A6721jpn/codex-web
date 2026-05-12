import { EventEmitter } from "node:events";

import type { AppServerClient } from "./app-server-client.ts";
import {
  ApprovalStore,
  type ApprovalDecision,
  type ApprovalLeaseRef,
  type ApprovalScope,
  type PendingApproval,
} from "./approvals.ts";
import {
  syncThreadIndex,
  THREAD_SOURCE_KINDS,
  type ThreadIndexEntry,
  type ThreadIndexStore,
  type ThreadSourceKind,
} from "./thread-index.ts";
import type { WorkspaceStore } from "./workspace.ts";

export type AppServerRuntime = Pick<
  AppServerClient,
  | "close"
  | "modelList"
  | "respondToServerRequest"
  | "start"
  | "threadList"
  | "threadRead"
  | "threadResume"
  | "threadStart"
  | "threadTurnsList"
  | "threadUnsubscribe"
  | "turnInterrupt"
  | "turnStart"
> & {
  off?: (eventName: "serverRequest", listener: (event: AppServerRequestEvent) => void) => unknown;
  on?: (eventName: "serverRequest", listener: (event: AppServerRequestEvent) => void) => unknown;
};

type ChatRuntimeOptions = {
  appServer: AppServerRuntime;
  approvals?: ApprovalStore;
  getActiveLease?: () => ApprovalLeaseRef | undefined;
  threads: ThreadIndexStore;
  workspaces: WorkspaceStore;
};

type AppServerRequestEvent = {
  method: string;
  params?: unknown;
  requestId: string | number;
};

type AppServerThread = {
  [key: string]: unknown;
  archived?: boolean;
  cwd?: string;
  ephemeral?: boolean;
  id: string;
  name?: string | null;
  source?: unknown;
  status?: unknown;
  updatedAt?: number;
};

type AppServerThreadListPage = {
  data?: AppServerThread[];
  nextCursor?: string | null;
};

type SemanticWorkspaceInput = {
  workspaceId: number;
};

export class ChatRuntime {
  #appServer: AppServerRuntime;
  #approvals?: ApprovalStore;
  #getActiveLease?: () => ApprovalLeaseRef | undefined;
  #serverRequestListener?: (event: AppServerRequestEvent) => void;
  #threads: ThreadIndexStore;
  #workspaces: WorkspaceStore;

  constructor(options: ChatRuntimeOptions) {
    this.#appServer = options.appServer;
    this.#approvals = options.approvals;
    this.#getActiveLease = options.getActiveLease;
    this.#threads = options.threads;
    this.#workspaces = options.workspaces;
    if (this.#approvals && this.#appServer.on) {
      this.#serverRequestListener = (event) => this.#recordServerRequest(event);
      this.#appServer.on("serverRequest", this.#serverRequestListener);
    }
  }

  async close(): Promise<void> {
    if (this.#serverRequestListener && this.#appServer.off) {
      this.#appServer.off("serverRequest", this.#serverRequestListener);
    }
    await this.#appServer.close?.();
  }

  listApprovals(lease: ApprovalLeaseRef): PendingApproval[] {
    return this.#requireApprovals().listForLease(lease);
  }

  reassignApprovals(from: ApprovalLeaseRef, to: ApprovalLeaseRef): number {
    return this.#requireApprovals().reassignLease(from, to);
  }

  async decideApproval(
    approvalId: string,
    lease: ApprovalLeaseRef,
    input: { decision: ApprovalDecision; scope?: ApprovalScope },
  ): Promise<{ decision: ApprovalDecision; id: string; scope: ApprovalScope }> {
    const approvals = this.#requireApprovals();
    const result = approvals.prepareDecision(approvalId, lease, input);
    await this.#appServer.respondToServerRequest({
      decision: result.decision,
      requestId: result.requestId,
      scope: result.scope,
    });
    approvals.completeDecision(approvalId, result);
    return { decision: result.decision, id: approvalId, scope: result.scope };
  }

  async refreshThreads(options: { pageSize?: number } = {}): Promise<{ upserted: number }> {
    return await this.#safeRead(async () => {
      return await syncThreadIndex(
        this.#threads,
        {
          listThreads: async (request) => {
            const page = (await this.#appServer.threadList({
              cursor: request.cursor,
              limit: request.pageSize,
              sourceKinds: [...request.sourceKinds],
            })) as AppServerThreadListPage;
            return {
              data: (page.data ?? []).map(mapThreadMetadata),
              nextCursor: page.nextCursor ?? undefined,
            };
          },
        },
        { pageSize: options.pageSize ?? 50 },
      );
    });
  }

  async readThread(input: { includeTurns?: boolean; threadId: string }): Promise<unknown> {
    return await this.#safeRead(async () => {
      return await this.#appServer.threadRead({ includeTurns: input.includeTurns ?? false, threadId: input.threadId });
    });
  }

  async listTurns(input: { cursor?: string; limit?: number; threadId: string }): Promise<unknown> {
    return await this.#safeRead(async () => {
      return await this.#appServer.threadTurnsList(input);
    });
  }

  async startThread(input: SemanticWorkspaceInput & { prompt?: string }): Promise<{ thread: AppServerThread; turn?: { id?: string } }> {
    await this.#ensureReady();
    const workspace = this.#requireWorkspace(input.workspaceId);
    const result = (await this.#appServer.threadStart({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: workspace.canonicalPath,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      sandbox: "workspace-write",
    })) as { thread: AppServerThread; turn?: { id?: string } };
    this.#upsertResultThread(result);
    if (input.prompt?.trim() && isThreadStartResult(result)) {
      await this.startTurn({ input: input.prompt, threadId: result.thread.id, workspaceId: input.workspaceId });
    }
    return result;
  }

  async resumeThread(input: SemanticWorkspaceInput & { threadId: string }): Promise<{ thread: AppServerThread }> {
    await this.#ensureReady();
    const workspace = this.#requireWorkspace(input.workspaceId);
    const result = (await this.#appServer.threadResume({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: workspace.canonicalPath,
      excludeTurns: true,
      persistExtendedHistory: false,
      sandbox: "workspace-write",
      threadId: input.threadId,
    })) as { thread: AppServerThread };
    this.#upsertResultThread(result);
    return result;
  }

  async startTurn(input: SemanticWorkspaceInput & { input: string; threadId: string }): Promise<{ turn: { id?: string; status?: string } }> {
    await this.#ensureReady();
    const workspace = this.#requireWorkspace(input.workspaceId);
    return (await this.#appServer.turnStart({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: workspace.canonicalPath,
      input: [{ text: input.input, text_elements: [], type: "text" }],
      sandboxPolicy: { mode: "workspaceWrite", networkAccess: false },
      threadId: input.threadId,
    })) as { turn: { id?: string; status?: string } };
  }

  async interruptTurn(input: { threadId: string; turnId: string }): Promise<unknown> {
    await this.#ensureReady();
    return await this.#appServer.turnInterrupt({ threadId: input.threadId, turnId: input.turnId });
  }

  async unsubscribeThread(input: { threadId: string }): Promise<unknown> {
    await this.#ensureReady();
    return await this.#appServer.threadUnsubscribe({ threadId: input.threadId });
  }

  async #ensureReady(): Promise<void> {
    await this.#appServer.start?.();
  }

  async #safeRead<T>(operation: () => Promise<T>): Promise<T> {
    await this.#ensureReady();
    try {
      return await operation();
    } catch (error) {
      if (!isAppServerUnavailable(error)) {
        throw error;
      }
      await this.#ensureReady();
      return await operation();
    }
  }

  #requireWorkspace(workspaceId: number) {
    const workspace = this.#workspaces.getById(workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }
    return workspace;
  }

  #upsertResultThread(result: unknown): void {
    if (!isThreadStartResult(result)) {
      return;
    }
    this.#threads.upsertMany([mapThreadMetadata(result.thread)]);
  }

  #recordServerRequest(event: AppServerRequestEvent): void {
    const lease = this.#getActiveLease?.();
    if (!lease || !this.#approvals) {
      void this.#appServer.respondToServerRequest({
        decision: "cancel",
        requestId: event.requestId,
        scope: "turn",
      });
      return;
    }
    this.#approvals.recordRequest({
      lease,
      method: event.method,
      params: event.params,
      requestId: event.requestId,
    });
  }

  #requireApprovals(): ApprovalStore {
    if (!this.#approvals) {
      throw new Error("Approval runtime is not configured");
    }
    return this.#approvals;
  }
}

export class FakeAppServerRuntime extends EventEmitter implements AppServerRuntime {
  approvalResponses: Array<{ decision: string; requestId: string | number; scope?: string }> = [];
  threadListCalls: Array<Record<string, unknown> & { cursor?: string; sourceKinds?: string[] }> = [];
  threadResumeCalls: Array<Record<string, unknown>> = [];
  threadStartCalls: Array<Record<string, unknown>> = [];
  threadReadResult: unknown = { thread: { id: "thread-1" } };
  threadReadCalls: Array<Record<string, unknown>> = [];
  threadUnsubscribeCalls: Array<Record<string, unknown>> = [];
  threadListPages: AppServerThreadListPage[];
  turnsListResult: unknown = { data: [], nextCursor: null };
  turnsListCalls: Array<Record<string, unknown>> = [];
  turnInterruptCalls: Array<{ threadId: string; turnId: string }> = [];
  turnStartCalls: Array<Record<string, unknown> & { input: Array<{ text?: string; type: string }> }> = [];

  constructor(options: { threadListPages?: AppServerThreadListPage[]; threadReadResult?: unknown; turnsListResult?: unknown } = {}) {
    super();
    this.threadListPages = options.threadListPages ?? [{ data: [], nextCursor: null }];
    this.threadReadResult = options.threadReadResult ?? this.threadReadResult;
    this.turnsListResult = options.turnsListResult ?? this.turnsListResult;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  async modelList(): Promise<unknown> {
    return { data: [] };
  }

  async threadList(params: Record<string, unknown>): Promise<unknown> {
    this.threadListCalls.push({ ...params, sourceKinds: Array.isArray(params.sourceKinds) ? [...params.sourceKinds] : undefined });
    return this.threadListPages.shift() ?? { data: [], nextCursor: null };
  }

  async threadRead(params: { includeTurns?: boolean; threadId: string }): Promise<unknown> {
    this.threadReadCalls.push(params);
    return this.threadReadResult;
  }

  async threadTurnsList(params: { cursor?: string; limit?: number; threadId: string }): Promise<unknown> {
    this.turnsListCalls.push(params);
    return this.turnsListResult;
  }

  async threadStart(params: Record<string, unknown>): Promise<unknown> {
    this.threadStartCalls.push(params);
    return { thread: { cwd: params.cwd, ephemeral: false, id: "thread-1", name: "New thread", source: "appServer", updatedAt: 1 } };
  }

  async threadResume(params: Record<string, unknown>): Promise<unknown> {
    this.threadResumeCalls.push(params);
    return { thread: { cwd: params.cwd, ephemeral: false, id: params.threadId, name: "Resumed thread", source: "appServer", updatedAt: 2 } };
  }

  async threadUnsubscribe(params: { threadId: string }): Promise<unknown> {
    this.threadUnsubscribeCalls.push(params);
    return {};
  }

  async turnStart(params: Record<string, unknown> & { input: Array<{ text?: string; type: string }> }): Promise<unknown> {
    this.turnStartCalls.push(params);
    return { turn: { id: "turn-1", status: "inProgress" } };
  }

  async turnInterrupt(params: { threadId: string; turnId: string }): Promise<unknown> {
    this.turnInterruptCalls.push(params);
    return {};
  }

  async respondToServerRequest(input: { decision: string; requestId: string | number; scope?: string }): Promise<void> {
    this.approvalResponses.push(input);
  }

  emitServerRequest(requestId: string | number, method: string, params: unknown): void {
    this.emit("serverRequest", { method, params, requestId });
  }
}

function mapThreadMetadata(thread: AppServerThread): ThreadIndexEntry {
  return {
    id: thread.id,
    sourceKind: mapSourceKind(thread.source),
    status: thread.ephemeral ? "ephemeral" : thread.archived ? "archived" : "active",
    title: thread.name ?? undefined,
    updatedAt: thread.updatedAt ?? Date.now(),
    workspacePath: thread.cwd,
  };
}

function mapSourceKind(source: unknown): ThreadSourceKind {
  if (THREAD_SOURCE_KINDS.includes(source as ThreadSourceKind)) {
    return source as ThreadSourceKind;
  }
  return "appServer";
}

function isThreadStartResult(value: unknown): value is { thread: AppServerThread } {
  return Boolean(value && typeof value === "object" && "thread" in value && (value as { thread?: unknown }).thread);
}

function isAppServerUnavailable(error: unknown): boolean {
  return error instanceof Error && /app-server (unavailable|failed|exited)|app-server exited/i.test(error.message);
}
