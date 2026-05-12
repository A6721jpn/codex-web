import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type AuthStatus = {
  authenticated: boolean;
  setupRequired: boolean;
};

type Lease = {
  connectionId: string;
  epoch: number;
  fencingToken: string;
};

type Workspace = {
  canonicalPath: string;
  exists: boolean;
  id: number;
  isSymlink: boolean;
  lastOpenedAt: number;
  trustState: string;
};

type ThreadSummary = {
  id: string;
  sourceKind: string;
  status: string;
  title?: string;
  updatedAt: number;
  workspacePath?: string;
};

type Approval = {
  availableDecisions: Array<"approve" | "cancel" | "reject">;
  defaultScope: "session" | "turn";
  id: string;
  kind: string;
  metadata: {
    cwd?: string;
    diffSummary?: string;
    network?: { host?: string; port?: number; protocol?: string };
    paths?: string[];
    summary: string;
    title: string;
    workspaceStatus?: string;
  };
};

function App(): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus | undefined>();
  const [csrfToken, setCsrfToken] = useState("preauth");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [lease, setLease] = useState<Lease | undefined>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | undefined>();
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalScopes, setApprovalScopes] = useState<Record<string, "session" | "turn">>({});
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const [prompt, setPrompt] = useState("");
  const [turnInput, setTurnInput] = useState("");
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    const [statusResponse, csrfResponse] = await Promise.all([fetch("/api/auth/status"), fetch("/api/csrf")]);
    setStatus((await statusResponse.json()) as AuthStatus);
    const csrf = (await csrfResponse.json()) as { csrfToken?: string };
    if (csrf.csrfToken) {
      setCsrfToken(csrf.csrfToken);
    }
  }

  async function submit(path: string): Promise<void> {
    setError(undefined);
    const response = await fetch(path, {
      body: JSON.stringify({ password }),
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      method: "POST",
    });
    const body = (await response.json()) as { csrfToken?: string; error?: string };
    if (!response.ok) {
      setError(body.error ?? "Request failed");
      return;
    }
    if (body.csrfToken) {
      setCsrfToken(body.csrfToken);
    }
    setPassword("");
    await refresh();
  }

  if (!status) {
    return <main className="shell" />;
  }

  const mode = status.setupRequired ? "Set up local password" : status.authenticated ? "Connection ready" : "Log in";
  const action = status.setupRequired ? "/api/auth/setup" : "/api/auth/login";

  return (
    <main className="shell">
      <section className="panel">
        <div>
          <p className="eyebrow">codex-web M1</p>
          <h1>{mode}</h1>
        </div>
        {status.authenticated ? (
          <div className="runtime">
            <strong>Signed in</strong>
            <span>Only the active browser connection can use workspace and thread actions.</span>
            <button type="button" onClick={() => void openConnection(csrfToken, setLease, setError, setWorkspaces, setThreads, setApprovals)}>
              Open connection
            </button>
            {lease ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void openWorkspace({
                    csrfToken,
                    lease,
                    path: workspacePath,
                    setError,
                    setSelectedWorkspaceId,
                    setWorkspacePath,
                    setWorkspaces,
                  });
                }}
              >
                <label>
                  Workspace path
                  <input
                    onChange={(event) => setWorkspacePath(event.currentTarget.value)}
                    placeholder="C:\\Users\\aokuni\\Documents\\New project"
                    value={workspacePath}
                  />
                </label>
                <button type="submit">Open workspace</button>
              </form>
            ) : null}
            {workspaces.length > 0 ? (
              <section className="runtime-grid">
                <aside className="sidebar" aria-label="Workspaces and threads">
                  <label>
                    Active workspace
                    <select
                      onChange={(event) => setSelectedWorkspaceId(Number(event.currentTarget.value))}
                      value={selectedWorkspaceId ?? workspaces[0]?.id ?? ""}
                    >
                      {workspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>
                          {workspace.canonicalPath}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void refreshThreads({ csrfToken, lease: lease!, setError, setThreads })}
                  >
                    Refresh threads
                  </button>
                  <ul className="thread-list">
                    {threads.map((thread) => (
                      <li key={thread.id}>
                        <button
                          className={thread.id === activeThreadId ? "thread-button active" : "thread-button"}
                          type="button"
                          onClick={() => setActiveThreadId(thread.id)}
                        >
                          <span>{thread.title ?? thread.id}</span>
                          <small>{thread.sourceKind} · {thread.status}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </aside>
                <section className="chat-pane" aria-label="Chat runtime">
                  <section className="approval-list" aria-label="Pending approvals">
                    <div className="approval-heading">
                      <div>
                        <p className="eyebrow">Approvals</p>
                        <h2>Pending requests</h2>
                      </div>
                      <button
                        type="button"
                        onClick={() => lease && void refreshApprovals({ lease, setApprovals, setError })}
                      >
                        Refresh
                      </button>
                    </div>
                    {approvals.length === 0 ? <p className="muted">No pending approvals.</p> : null}
                    {approvals.map((approval) => (
                      <article className="approval-card" key={approval.id}>
                        <div>
                          <strong>{approval.metadata.title}</strong>
                          <small>{approval.kind}</small>
                        </div>
                        <p>{approval.metadata.summary}</p>
                        {approval.metadata.cwd ? <small>Cwd: {approval.metadata.cwd}</small> : null}
                        {approval.metadata.network ? (
                          <small>
                            Network: {[approval.metadata.network.protocol, approval.metadata.network.host, approval.metadata.network.port]
                              .filter(Boolean)
                              .join(" ")}
                          </small>
                        ) : null}
                        {approval.metadata.paths?.length ? <small>Paths: {approval.metadata.paths.join(", ")}</small> : null}
                        {approval.metadata.diffSummary ? <small>{approval.metadata.diffSummary}</small> : null}
                        <div className="approval-actions">
                          {approval.kind === "permission" ? (
                            <select
                              aria-label="Approval scope"
                              onChange={(event) =>
                                setApprovalScopes((current) => ({
                                  ...current,
                                  [approval.id]: event.currentTarget.value === "session" ? "session" : "turn",
                                }))
                              }
                              value={approvalScopes[approval.id] ?? approval.defaultScope}
                            >
                              <option value="turn">This turn</option>
                              <option value="session">This session</option>
                            </select>
                          ) : null}
                          {approval.availableDecisions.map((decision) => (
                            <button
                              key={decision}
                              type="button"
                              onClick={() =>
                                lease &&
                                void decideApproval({
                                  approvalId: approval.id,
                                  csrfToken,
                                  decision,
                                  lease,
                                  scope: approvalScopes[approval.id] ?? approval.defaultScope,
                                  setApprovals,
                                  setError,
                                })
                              }
                            >
                              {decision}
                            </button>
                          ))}
                        </div>
                      </article>
                    ))}
                  </section>
                  <div className="timeline">
                    <p className="eyebrow">codex-web M3</p>
                    <h2>{activeThreadId ? "Thread ready" : "No thread selected"}</h2>
                    <p>{activeThreadId ?? "Refresh or start a thread from the selected workspace."}</p>
                    {activeTurnId ? <small>Active turn: {activeTurnId}</small> : null}
                  </div>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (lease && selectedWorkspaceId) {
                        void startThread({
                          csrfToken,
                          lease,
                          prompt,
                          setActiveThreadId,
                          setActiveTurnId,
                          setError,
                          setPrompt,
                          setThreads,
                          workspaceId: selectedWorkspaceId,
                        });
                      }
                    }}
                  >
                    <label>
                      Start thread
                      <input
                        onChange={(event) => setPrompt(event.currentTarget.value)}
                        placeholder="Short initial prompt"
                        value={prompt}
                      />
                    </label>
                    <button disabled={!selectedWorkspaceId || !prompt.trim()} type="submit">Start</button>
                  </form>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (lease && selectedWorkspaceId && activeThreadId) {
                        void sendTurn({
                          csrfToken,
                          input: turnInput,
                          lease,
                          setActiveTurnId,
                          setError,
                          setTurnInput,
                          threadId: activeThreadId,
                          workspaceId: selectedWorkspaceId,
                        });
                      }
                    }}
                  >
                    <label>
                      Send turn
                      <input
                        onChange={(event) => setTurnInput(event.currentTarget.value)}
                        placeholder="Message for the selected thread"
                        value={turnInput}
                      />
                    </label>
                    <div className="composer-actions">
                      <button disabled={!activeThreadId || !turnInput.trim()} type="submit">Send</button>
                      <button
                        disabled={!activeThreadId || !activeTurnId}
                        type="button"
                        onClick={() => {
                          if (lease && activeThreadId && activeTurnId) {
                            void interruptTurn({ activeTurnId, csrfToken, lease, setActiveTurnId, setError, threadId: activeThreadId });
                          }
                        }}
                      >
                        Stop
                      </button>
                    </div>
                  </form>
                </section>
              </section>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(action);
            }}
          >
            <label>
              Password
              <input
                autoComplete={status.setupRequired ? "new-password" : "current-password"}
                minLength={8}
                onChange={(event) => setPassword(event.currentTarget.value)}
                type="password"
                value={password}
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button type="submit">{status.setupRequired ? "Save password" : "Log in"}</button>
          </form>
        )}
      </section>
    </main>
  );
}

async function openConnection(
  csrfToken: string,
  setLease: (lease: Lease) => void,
  setError: (error: string | undefined) => void,
  setWorkspaces: (workspaces: Workspace[]) => void,
  setThreads: (threads: ThreadSummary[]) => void,
  setApprovals: (approvals: Approval[]) => void,
): Promise<void> {
  setError(undefined);
  const response = await fetch("/api/ws-ticket", {
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
  if (!response.ok) {
    setError("Connection ticket failed");
    return;
  }
  const body = (await response.json()) as { ticket: string };
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?ticket=${encodeURIComponent(body.ticket)}`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Partial<Lease> & { type?: string };
    if (message.type === "connection.ready" && message.connectionId && message.epoch && message.fencingToken) {
      const activeLease = {
        connectionId: message.connectionId,
        epoch: message.epoch,
        fencingToken: message.fencingToken,
      };
      setLease(activeLease);
      void refreshWorkspaces(activeLease, setWorkspaces, setError);
      void refreshThreads({ csrfToken, lease: activeLease, setError, setThreads });
      void refreshApprovals({ lease: activeLease, setApprovals, setError });
    }
  });
  socket.addEventListener("error", () => setError("Connection failed"));
}

async function openWorkspace(input: {
  csrfToken: string;
  lease: Lease;
  path: string;
  setError: (error: string | undefined) => void;
  setSelectedWorkspaceId: (id: number) => void;
  setWorkspacePath: (path: string) => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
}): Promise<void> {
  input.setError(undefined);
  const response = await fetch("/api/workspaces/open", {
    body: JSON.stringify({ path: input.path }),
    headers: {
      ...leaseHeaders(input.lease),
      "content-type": "application/json",
      "x-csrf-token": input.csrfToken,
    },
    method: "POST",
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    input.setError(body.error ?? "Workspace rejected");
    return;
  }
  const opened = (await response.json()) as Workspace;
  input.setSelectedWorkspaceId(opened.id);
  input.setWorkspacePath("");
  await refreshWorkspaces(input.lease, input.setWorkspaces, input.setError);
}

async function refreshWorkspaces(
  lease: Lease,
  setWorkspaces: (workspaces: Workspace[]) => void,
  setError: (error: string | undefined) => void,
): Promise<void> {
  const response = await fetch("/api/workspaces", { headers: leaseHeaders(lease) });
  if (!response.ok) {
    setError("Workspace list requires the active connection");
    return;
  }
  setWorkspaces((await response.json()) as Workspace[]);
}

async function refreshThreads(input: {
  csrfToken: string;
  lease: Lease;
  setError: (error: string | undefined) => void;
  setThreads: (threads: ThreadSummary[]) => void;
}): Promise<void> {
  input.setError(undefined);
  const refresh = await fetch("/api/threads/refresh", {
    headers: { ...leaseHeaders(input.lease), "x-csrf-token": input.csrfToken },
    method: "POST",
  });
  if (!refresh.ok) {
    const body = (await refresh.json()) as { error?: string };
    input.setError(body.error ?? "Thread refresh failed");
    return;
  }
  const list = await fetch("/api/threads", { headers: leaseHeaders(input.lease) });
  if (!list.ok) {
    input.setError("Thread list requires the active connection");
    return;
  }
  input.setThreads(((await list.json()) as { items: ThreadSummary[] }).items);
}

async function startThread(input: {
  csrfToken: string;
  lease: Lease;
  prompt: string;
  setActiveThreadId: (id: string) => void;
  setActiveTurnId: (id: string | undefined) => void;
  setError: (error: string | undefined) => void;
  setPrompt: (prompt: string) => void;
  setThreads: (threads: ThreadSummary[]) => void;
  workspaceId: number;
}): Promise<void> {
  input.setError(undefined);
  const response = await fetch("/api/threads/start", {
    body: JSON.stringify({ prompt: input.prompt, workspaceId: input.workspaceId }),
    headers: { ...leaseHeaders(input.lease), "content-type": "application/json", "x-csrf-token": input.csrfToken },
    method: "POST",
  });
  const body = (await response.json()) as { error?: string; thread?: { id?: string }; turn?: { id?: string } };
  if (!response.ok || !body.thread?.id) {
    input.setError(body.error ?? "Thread start failed");
    return;
  }
  input.setActiveThreadId(body.thread.id);
  input.setActiveTurnId(body.turn?.id);
  input.setPrompt("");
  await refreshThreads({ csrfToken: input.csrfToken, lease: input.lease, setError: input.setError, setThreads: input.setThreads });
}

async function sendTurn(input: {
  csrfToken: string;
  input: string;
  lease: Lease;
  setActiveTurnId: (id: string | undefined) => void;
  setError: (error: string | undefined) => void;
  setTurnInput: (value: string) => void;
  threadId: string;
  workspaceId: number;
}): Promise<void> {
  input.setError(undefined);
  const response = await fetch(`/api/threads/${encodeURIComponent(input.threadId)}/turns`, {
    body: JSON.stringify({ input: input.input, workspaceId: input.workspaceId }),
    headers: { ...leaseHeaders(input.lease), "content-type": "application/json", "x-csrf-token": input.csrfToken },
    method: "POST",
  });
  const body = (await response.json()) as { error?: string; turn?: { id?: string } };
  if (!response.ok) {
    input.setError(body.error ?? "Turn start failed");
    return;
  }
  input.setActiveTurnId(body.turn?.id);
  input.setTurnInput("");
}

async function interruptTurn(input: {
  activeTurnId: string;
  csrfToken: string;
  lease: Lease;
  setActiveTurnId: (id: string | undefined) => void;
  setError: (error: string | undefined) => void;
  threadId: string;
}): Promise<void> {
  input.setError(undefined);
  const response = await fetch(`/api/turns/${encodeURIComponent(input.activeTurnId)}/interrupt`, {
    body: JSON.stringify({ threadId: input.threadId }),
    headers: { ...leaseHeaders(input.lease), "content-type": "application/json", "x-csrf-token": input.csrfToken },
    method: "POST",
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    input.setError(body.error ?? "Interrupt failed");
    return;
  }
  input.setActiveTurnId(undefined);
}

async function refreshApprovals(input: {
  lease: Lease;
  setApprovals: (approvals: Approval[]) => void;
  setError: (error: string | undefined) => void;
}): Promise<void> {
  const response = await fetch("/api/approvals", { headers: leaseHeaders(input.lease) });
  if (!response.ok) {
    input.setError("Approval list requires the active connection");
    return;
  }
  input.setApprovals(((await response.json()) as { approvals: Approval[] }).approvals);
}

async function decideApproval(input: {
  approvalId: string;
  csrfToken: string;
  decision: "approve" | "cancel" | "reject";
  lease: Lease;
  scope: "session" | "turn";
  setApprovals: (approvals: Approval[]) => void;
  setError: (error: string | undefined) => void;
}): Promise<void> {
  input.setError(undefined);
  const response = await fetch(`/api/approvals/${encodeURIComponent(input.approvalId)}/decision`, {
    body: JSON.stringify({ decision: input.decision, scope: input.scope }),
    headers: { ...leaseHeaders(input.lease), "content-type": "application/json", "x-csrf-token": input.csrfToken },
    method: "POST",
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    input.setError(body.error ?? "Approval decision failed");
    return;
  }
  await refreshApprovals({ lease: input.lease, setApprovals: input.setApprovals, setError: input.setError });
}

function leaseHeaders(lease: Lease): Record<string, string> {
  return {
    "x-codex-connection-epoch": String(lease.epoch),
    "x-codex-connection-id": lease.connectionId,
    "x-codex-fencing-token": lease.fencingToken,
  };
}

createRoot(document.getElementById("root")!).render(<App />);
