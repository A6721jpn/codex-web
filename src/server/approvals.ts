import type { CodexWebDatabase } from "./db.ts";

export type ApprovalDecision = "approve" | "cancel" | "reject";
export type ApprovalScope = "session" | "turn";
export type ApprovalKind = "command" | "elicitation" | "file_change" | "permission" | "unknown";

export type ApprovalLeaseRef = {
  connectionId: string;
  epoch: number;
};

export type ApprovalMetadata = {
  cwd?: string;
  diffSummary?: string;
  network?: {
    host?: string;
    port?: number;
    protocol?: string;
  };
  paths?: string[];
  summary: string;
  title: string;
  workspaceStatus?: "outside_workspace" | "unknown" | "workspace_relative";
};

export type NormalizedApprovalRequest = {
  availableDecisions: ApprovalDecision[];
  defaultScope: ApprovalScope;
  failClosed: boolean;
  kind: ApprovalKind;
  metadata: ApprovalMetadata;
};

export type PendingApproval = NormalizedApprovalRequest & {
  createdAt: number;
  id: string;
  itemId?: string;
  lease: ApprovalLeaseRef;
  requestId: string | number;
  state: "pending";
  threadId?: string;
  turnId?: string;
};

export type ApprovalDecisionInput = {
  decision: ApprovalDecision;
  scope?: ApprovalScope;
};

export class ApprovalStore {
  #db: CodexWebDatabase;
  #now: () => number;
  #pending = new Map<string, PendingApproval>();

  constructor(db: CodexWebDatabase, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  recordRequest(input: {
    lease: ApprovalLeaseRef;
    method: string;
    params: unknown;
    requestId: string | number;
  }): PendingApproval {
    const normalized = normalizeApprovalRequest(input.method, input.params);
    const ids = extractIds(input.params);
    const pending: PendingApproval = {
      ...normalized,
      createdAt: this.#now(),
      id: String(input.requestId),
      itemId: ids.itemId,
      lease: { ...input.lease },
      requestId: input.requestId,
      state: "pending",
      threadId: ids.threadId,
      turnId: ids.turnId,
    };
    this.#pending.set(pending.id, pending);
    this.#insertAudit("approval.requested", pending, undefined, "pending");
    return toPublicPending(pending);
  }

  listForLease(lease: ApprovalLeaseRef): PendingApproval[] {
    return [...this.#pending.values()]
      .filter((approval) => approval.lease.connectionId === lease.connectionId && approval.lease.epoch === lease.epoch)
      .map(toPublicPending);
  }

  reassignLease(from: ApprovalLeaseRef, to: ApprovalLeaseRef): number {
    let reassigned = 0;
    for (const approval of this.#pending.values()) {
      if (approval.lease.connectionId === from.connectionId && approval.lease.epoch === from.epoch) {
        approval.lease = { ...to };
        reassigned += 1;
      }
    }
    return reassigned;
  }

  markDecided(
    approvalId: string,
    lease: ApprovalLeaseRef,
    input: ApprovalDecisionInput,
  ): { decision: ApprovalDecision; pending: PendingApproval; requestId: string | number; scope: ApprovalScope } {
    const prepared = this.prepareDecision(approvalId, lease, input);
    this.completeDecision(approvalId, prepared);
    return prepared;
  }

  prepareDecision(
    approvalId: string,
    lease: ApprovalLeaseRef,
    input: ApprovalDecisionInput,
  ): { decision: ApprovalDecision; pending: PendingApproval; requestId: string | number; scope: ApprovalScope } {
    const pending = this.#pending.get(approvalId);
    if (!pending) {
      throw new DuplicateApprovalDecisionError();
    }
    if (pending.lease.connectionId !== lease.connectionId || pending.lease.epoch !== lease.epoch) {
      throw new StaleApprovalLeaseError();
    }
    if (!pending.availableDecisions.includes(input.decision)) {
      throw new InvalidApprovalDecisionError();
    }
    const scope = input.scope ?? pending.defaultScope;
    return { decision: input.decision, pending: toPublicPending(pending), requestId: pending.requestId, scope };
  }

  completeDecision(
    approvalId: string,
    prepared: { decision: ApprovalDecision; pending: PendingApproval; requestId: string | number; scope: ApprovalScope },
  ): void {
    const pending = this.#pending.get(approvalId);
    if (!pending) {
      throw new DuplicateApprovalDecisionError();
    }
    this.#pending.delete(approvalId);
    this.#insertAudit("approval.decision", pending, prepared.decision, "decided", prepared.scope);
  }

  #insertAudit(
    eventType: "approval.decision" | "approval.requested",
    approval: PendingApproval,
    decision: ApprovalDecision | undefined,
    status: string,
    scope?: ApprovalScope,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO approval_events (
          event_type, approval_id, app_request_id, kind, status, decision, scope,
          connection_id, epoch, redacted_metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventType,
        approval.id,
        String(approval.requestId),
        approval.kind,
        status,
        decision ?? null,
        scope ?? null,
        approval.lease.connectionId,
        approval.lease.epoch,
        JSON.stringify(approval.metadata),
        this.#now(),
      );
  }
}

export class DuplicateApprovalDecisionError extends Error {
  constructor() {
    super("Approval was already decided");
  }
}

export class InvalidApprovalDecisionError extends Error {
  constructor() {
    super("Invalid approval decision");
  }
}

export class StaleApprovalLeaseError extends Error {
  constructor() {
    super("Approval belongs to a different active lease");
  }
}

export function normalizeApprovalRequest(method: string, params: unknown): NormalizedApprovalRequest {
  const payload = asRecord(params);
  if (isCommandApproval(method)) {
    return {
      availableDecisions: decisionsFrom(payload.availableDecisions, ["approve", "reject", "cancel"]),
      defaultScope: "turn",
      failClosed: false,
      kind: "command",
      metadata: {
        cwd: stringValue(payload.cwd) ? redactPath(stringValue(payload.cwd)!) : undefined,
        network: networkContext(payload.networkApprovalContext),
        summary: commandSummary(stringValue(payload.command) ?? stringValue(payload.cmd) ?? stringValue(payload.summary)),
        title: "Command approval",
      },
    };
  }
  if (isFileApproval(method)) {
    const paths = changedPaths(payload);
    return {
      availableDecisions: decisionsFrom(payload.availableDecisions, ["approve", "reject", "cancel"]),
      defaultScope: "turn",
      failClosed: false,
      kind: "file_change",
      metadata: {
        cwd: stringValue(payload.cwd) ? redactPath(stringValue(payload.cwd)!) : undefined,
        diffSummary: `${paths.length || 1} ${paths.length === 1 ? "file" : "files"} changed`,
        paths,
        summary: paths.length ? `Changes to ${paths.slice(0, 3).join(", ")}` : "File changes require approval",
        title: "File change approval",
        workspaceStatus: "unknown",
      },
    };
  }
  if (isPermissionApproval(method)) {
    const summary = permissionSummary(payload);
    return {
      availableDecisions: decisionsFrom(payload.availableDecisions, ["approve", "reject", "cancel"]),
      defaultScope: "turn",
      failClosed: false,
      kind: "permission",
      metadata: {
        summary,
        title: "Permission approval",
      },
    };
  }
  if (/elicitation/i.test(method)) {
    return {
      availableDecisions: ["cancel"],
      defaultScope: "turn",
      failClosed: true,
      kind: "elicitation",
      metadata: {
        summary: "Tool elicitation requires review in a later milestone.",
        title: "Tool elicitation deferred",
      },
    };
  }
  return {
    availableDecisions: ["cancel"],
    defaultScope: "turn",
    failClosed: true,
    kind: "unknown",
    metadata: {
      summary: "An unknown app-server request requires cancellation.",
      title: "Unknown approval request",
    },
  };
}

function toPublicPending(approval: PendingApproval): PendingApproval {
  return {
    ...approval,
    availableDecisions: [...approval.availableDecisions],
    lease: { ...approval.lease },
    metadata: {
      ...approval.metadata,
      network: approval.metadata.network ? { ...approval.metadata.network } : undefined,
      paths: approval.metadata.paths ? [...approval.metadata.paths] : undefined,
    },
  };
}

function isCommandApproval(method: string): boolean {
  return /commandExecution\/requestApproval|command.*approval/i.test(method);
}

function isFileApproval(method: string): boolean {
  return /fileChange\/requestApproval|file.*approval/i.test(method);
}

function isPermissionApproval(method: string): boolean {
  return /permissions\/requestApproval|permission.*approval/i.test(method);
}

function decisionsFrom(value: unknown, fallback: ApprovalDecision[]): ApprovalDecision[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const decisions = value.filter((entry): entry is ApprovalDecision => entry === "approve" || entry === "reject" || entry === "cancel");
  return decisions.length ? [...new Set(decisions)] : fallback;
}

function commandSummary(command?: string): string {
  if (!command) {
    return "Command execution requires approval";
  }
  const sanitized = redactText(command);
  const parts = sanitized.trim().split(/\s+/).slice(0, 2);
  return `${parts.join(" ")} command requires approval`;
}

function changedPaths(payload: Record<string, unknown>): string[] {
  const changes = Array.isArray(payload.changes) ? payload.changes : Array.isArray(payload.files) ? payload.files : [];
  const paths = changes
    .map((change) => {
      if (typeof change === "string") {
        return change;
      }
      const record = asRecord(change);
      return stringValue(record.path) ?? stringValue(record.filePath) ?? stringValue(record.relativePath);
    })
    .filter((path): path is string => Boolean(path))
    .map((path) => redactPath(path));
  const singlePath = stringValue(payload.path);
  if (paths.length === 0 && singlePath) {
    paths.push(redactPath(singlePath));
  }
  return paths.slice(0, 20);
}

function permissionSummary(payload: Record<string, unknown>): string {
  const fragments: string[] = [];
  const permission = asRecord(payload.permission);
  const permissionId = stringValue(permission.id) ?? stringValue(permission.type);
  if (permissionId) {
    fragments.push(permissionId);
  }
  if (Array.isArray(payload.permissions)) {
    fragments.push(
      ...payload.permissions
        .map((value) => (typeof value === "string" ? value : JSON.stringify(redactedObject(value))))
        .slice(0, 4),
    );
  }
  return fragments.length ? `Requesting ${fragments.map(redactText).join(", ")}` : "Permission change requires approval";
}

function networkContext(value: unknown): ApprovalMetadata["network"] | undefined {
  const record = asRecord(value);
  const host = stringValue(record.host);
  const protocol = stringValue(record.protocol);
  const port = typeof record.port === "number" ? record.port : Number(record.port);
  if (!host && !protocol && !Number.isFinite(port)) {
    return undefined;
  }
  return {
    host,
    port: Number.isFinite(port) ? port : undefined,
    protocol,
  };
}

function extractIds(params: unknown): { itemId?: string; threadId?: string; turnId?: string } {
  const payload = asRecord(params);
  return {
    itemId: stringValue(payload.itemId),
    threadId: stringValue(payload.threadId),
    turnId: stringValue(payload.turnId),
  };
}

function redactedObject(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactedObject);
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/prompt|message|reasoning|output|diff|body|payload|command/i.test(key)) {
      result[key] = "<redacted>";
    } else {
      result[key] = redactedObject(nested);
    }
  }
  return result;
}

function redactText(value: string): string {
  return value
    .replace(/[A-Z]:\\Users\\[^\\\s",]+(?:\\[^\\\s",]+)*/gi, "<USER_HOME>")
    .replace(/[A-Z]:\\\\Users\\\\[^\\\s",]+(?:\\\\[^\\\s",]+)*/gi, "<USER_HOME_ESCAPED>")
    .replace(/token=([^\s"'\\]+)/gi, "token=<redacted>")
    .replace(/SECRET[A-Z0-9_:-]*/g, "<redacted>")
    .replace(/SUPER_SECRET[A-Z0-9_:-]*/g, "<redacted>")
    .replace(/USER PROMPT|AGENT MESSAGE|SECRET_REASONING|SECRET_OUTPUT|FULL_DIFF/gi, "<redacted>")
    .slice(0, 160);
}

function redactPath(value: string): string {
  return value.replace(/^[A-Z]:\\Users\\[^\\]+\\/i, "<USER_HOME>\\");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
