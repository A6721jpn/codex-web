import React, { useEffect, useMemo, useState } from "react";
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

type ConnectionStatus = {
  canTakeover: boolean;
  state: "active" | "available" | "busy";
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
  lastOpenedAt?: number;
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

type RuntimeError = {
  code: string;
  message: string;
};

type RestoredState = {
  activeThreadId?: string;
  activeWorkspaceId?: number;
  approvals: Approval[];
  runtimeError?: RuntimeError;
  threads: { items: ThreadSummary[] };
  workspaces: Workspace[];
};

function App(): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus | undefined>();
  const [csrfToken, setCsrfToken] = useState("preauth");
  const [password, setPassword] = useState("");
  const [takeoverPassword, setTakeoverPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [runtimeError, setRuntimeError] = useState<RuntimeError | undefined>();
  const [lease, setLease] = useState<Lease | undefined>();
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | undefined>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | undefined>();
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadSearch, setThreadSearch] = useState("");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalScopes, setApprovalScopes] = useState<Record<string, "session" | "turn">>({});
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const [prompt, setPrompt] = useState("");
  const [turnInput, setTurnInput] = useState("");
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    void refreshAuth();
  }, []);

  useEffect(() => {
    if (status?.authenticated && csrfToken !== "preauth") {
      void restoreConnection();
    }
  }, [status?.authenticated, csrfToken]);

  useEffect(() => {
    if (!status?.authenticated || !lease || csrfToken === "preauth") {
      return;
    }
    let closed = false;
    let heartbeat: number | undefined;
    let socket: WebSocket | undefined;
    void (async () => {
      const ticketResponse = await fetch("/api/ws-ticket", {
        headers: { "x-csrf-token": csrfToken },
        method: "POST",
      });
      if (!ticketResponse.ok || closed) {
        return;
      }
      const ticket = (await ticketResponse.json()) as { ticket?: string };
      if (!ticket.ticket || closed) {
        return;
      }
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({
        connectionId: lease.connectionId,
        epoch: String(lease.epoch),
        fencingToken: lease.fencingToken,
        ticket: ticket.ticket,
      });
      socket = new WebSocket(`${scheme}://${window.location.host}/ws?${params.toString()}`);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type === "approvals.changed") {
            void refreshApprovals({ lease, setApprovals, setError });
          }
          if (message.type === "connection.revoked") {
            setConnectionStatus({ canTakeover: true, state: "busy" });
          }
        } catch {
          // Ignore malformed local websocket messages.
        }
      };
      socket.onopen = () => {
        heartbeat = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ ...lease, type: "connection.heartbeat" }));
          }
        }, 25_000);
      };
    })();
    return () => {
      closed = true;
      if (heartbeat) {
        window.clearInterval(heartbeat);
      }
      socket?.close();
    };
  }, [csrfToken, lease?.connectionId, lease?.epoch, lease?.fencingToken, status?.authenticated]);

  const visibleThreads = useMemo(() => {
    const term = threadSearch.trim().toLowerCase();
    if (!term) {
      return threads;
    }
    return threads.filter((thread) =>
      [thread.title, thread.id, thread.workspacePath, thread.sourceKind, thread.status].some((value) => value?.toLowerCase().includes(term)),
    );
  }, [threadSearch, threads]);

  async function refreshAuth(): Promise<void> {
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
    await refreshAuth();
  }

  async function restoreConnection(): Promise<void> {
    setError(undefined);
    setRuntimeError(undefined);
    const response = await fetch("/api/connection/reconnect", {
      headers: { "x-csrf-token": csrfToken },
      method: "POST",
    });
    if (response.status === 409) {
      setConnectionStatus((await response.json()) as ConnectionStatus);
      return;
    }
    if (!response.ok) {
      setError("Connection restore failed");
      return;
    }
    const activeLease = (await response.json()) as Lease;
    setLease(activeLease);
    setConnectionStatus({ canTakeover: false, state: "active" });
    await restoreState(activeLease);
  }

  async function restoreState(activeLease: Lease): Promise<void> {
    const response = await fetch("/api/state", { headers: leaseHeaders(activeLease) });
    const body = (await response.json()) as Partial<RestoredState> & { error?: string };
    if (!response.ok) {
      setRuntimeError(body.runtimeError);
      setError(body.error ?? "State restore failed");
      return;
    }
    setWorkspaces(body.workspaces ?? []);
    setThreads(body.threads?.items ?? []);
    setApprovals(body.approvals ?? []);
    setSelectedWorkspaceId(body.activeWorkspaceId ?? body.workspaces?.[0]?.id);
    setActiveThreadId(body.activeThreadId);
  }

  const mode = status?.setupRequired ? "Set up local password" : status?.authenticated ? "codex-web" : "Log in";
  const action = status?.setupRequired ? "/api/auth/setup" : "/api/auth/login";

  if (!status) {
    return <main className="shell" />;
  }

  if (!status.authenticated) {
    return (
      <main className="shell auth-shell">
        <section className="auth-panel">
          <p className="eyebrow">codex-web</p>
          <h1>{mode}</h1>
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
            {error ? <article className="error-card">{error}</article> : null}
            <button type="submit">{status.setupRequired ? "Save password" : "Log in"}</button>
          </form>
        </section>
      </main>
    );
  }

  const history = (
    <aside className="history-drawer" data-open={drawerOpen} aria-label="Workspaces and conversation history">
      <div className="nav-section">
        <label>
          Workspace
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (lease) {
              void openWorkspace({
                csrfToken,
                lease,
                path: workspacePath,
                setError,
                setSelectedWorkspaceId,
                setWorkspacePath,
                setWorkspaces,
              });
            }
          }}
        >
          <label>
            Open path
            <input
              onChange={(event) => setWorkspacePath(event.currentTarget.value)}
              placeholder="C:\\Users\\aokuni\\Documents\\New project"
              value={workspacePath}
            />
          </label>
          <button disabled={!lease || !workspacePath.trim()} type="submit">Open</button>
        </form>
      </div>
      <div className="nav-section">
        <div className="nav-heading">
          <p className="eyebrow">History</p>
          <button
            type="button"
            onClick={() => lease && void refreshThreads({ csrfToken, lease, search: threadSearch, setError, setThreads })}
          >
            Refresh
          </button>
        </div>
        <label className="thread-search">
          Search
          <input
            onChange={(event) => {
              const next = event.currentTarget.value;
              setThreadSearch(next);
              if (lease) {
                void refreshThreadList({ lease, search: next, setError, setThreads });
              }
            }}
            value={threadSearch}
          />
        </label>
        <ul className="thread-list">
          {visibleThreads.map((thread) => (
            <li key={thread.id}>
              <button
                className={thread.id === activeThreadId ? "thread-button active" : "thread-button"}
                type="button"
                onClick={() => {
                  setActiveThreadId(thread.id);
                  setDrawerOpen(false);
                  if (lease) {
                    void saveActiveUi({ csrfToken, lease, threadId: thread.id, workspaceId: selectedWorkspaceId });
                  }
                }}
              >
                <span>{thread.title ?? thread.id}</span>
                <small>{thread.sourceKind} / {thread.status}</small>
                <small>{formatLastOpened(thread.lastOpenedAt ?? thread.updatedAt)}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );

  return (
    <main className="shell app-shell">
      <section className="conversation-layout">
        {history}
        <section className="chat-pane" aria-label="Chat runtime">
          <header className="topbar">
            <button className="drawer-toggle" type="button" onClick={() => setDrawerOpen((current) => !current)}>
              History
            </button>
            <div>
              <p className="eyebrow">{mode}</p>
              <h1>{activeThreadId ? threads.find((thread) => thread.id === activeThreadId)?.title ?? activeThreadId : "Conversation"}</h1>
            </div>
          </header>
          {connectionStatus?.state === "busy" ? (
            <article className="busy-card">
              <strong>In use</strong>
              <label>
                Takeover password
                <input
                  autoComplete="current-password"
                  onChange={(event) => setTakeoverPassword(event.currentTarget.value)}
                  type="password"
                  value={takeoverPassword}
                />
              </label>
              <button
                disabled={!takeoverPassword}
                type="button"
                onClick={() =>
                  void takeover({
                    csrfToken,
                    password: takeoverPassword,
                    restoreState,
                    setConnectionStatus,
                    setError,
                    setLease,
                    setTakeoverPassword,
                  })
                }
              >
                Take over
              </button>
            </article>
          ) : null}
          {runtimeError ? (
            <article className="error-card">
              <strong>{runtimeError.code}</strong>
              <span>{runtimeError.message}</span>
            </article>
          ) : error ? (
            <article className="error-card">{error}</article>
          ) : null}
          <section className="timeline" aria-label="Conversation timeline">
            <article className="timeline-item user-item">
              <span>User</span>
              <p>{activeThreadId ? "Ready for the selected thread." : "Select or start a thread."}</p>
            </article>
            <article className="timeline-item agent-item">
              <span>Agent</span>
              <p>{activeTurnId ? `Active turn ${activeTurnId}` : "No active turn."}</p>
            </article>
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
          <section className="composer">
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
                <input onChange={(event) => setPrompt(event.currentTarget.value)} value={prompt} />
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
                Message
                <input onChange={(event) => setTurnInput(event.currentTarget.value)} value={turnInput} />
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
      </section>
    </main>
  );
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
  await saveActiveUi({ csrfToken: input.csrfToken, lease: input.lease, workspaceId: opened.id });
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
  search?: string;
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
  await refreshThreadList({ lease: input.lease, search: input.search, setError: input.setError, setThreads: input.setThreads });
}

async function refreshThreadList(input: {
  lease: Lease;
  search?: string;
  setError: (error: string | undefined) => void;
  setThreads: (threads: ThreadSummary[]) => void;
}): Promise<void> {
  const query = input.search?.trim() ? `?search=${encodeURIComponent(input.search.trim())}` : "";
  const list = await fetch(`/api/threads${query}`, { headers: leaseHeaders(input.lease) });
  if (!list.ok) {
    input.setError("Thread list requires the active connection");
    return;
  }
  input.setThreads(((await list.json()) as { items: ThreadSummary[] }).items);
}

async function saveActiveUi(input: { csrfToken: string; lease: Lease; threadId?: string; workspaceId?: number }): Promise<void> {
  await fetch("/api/ui/active", {
    body: JSON.stringify({ threadId: input.threadId, workspaceId: input.workspaceId }),
    headers: { ...leaseHeaders(input.lease), "content-type": "application/json", "x-csrf-token": input.csrfToken },
    method: "POST",
  });
}

async function takeover(input: {
  csrfToken: string;
  password: string;
  restoreState: (lease: Lease) => Promise<void>;
  setConnectionStatus: (status: ConnectionStatus | undefined) => void;
  setError: (error: string | undefined) => void;
  setLease: (lease: Lease | undefined) => void;
  setTakeoverPassword: (password: string) => void;
}): Promise<void> {
  const response = await fetch("/api/connection/takeover", {
    body: JSON.stringify({ password: input.password }),
    headers: { "content-type": "application/json", "x-csrf-token": input.csrfToken },
    method: "POST",
  });
  if (!response.ok) {
    input.setError("Takeover failed");
    return;
  }
  const takeoverLease = (await response.json()) as Lease;
  input.setLease(takeoverLease);
  input.setConnectionStatus({ canTakeover: false, state: "active" });
  input.setTakeoverPassword("");
  await input.restoreState(takeoverLease);
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
  await saveActiveUi({ csrfToken: input.csrfToken, lease: input.lease, threadId: body.thread.id, workspaceId: input.workspaceId });
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

function formatLastOpened(value?: number): string {
  return value ? new Date(value).toLocaleString() : "No recent activity";
}

function leaseHeaders(lease: Lease): Record<string, string> {
  return {
    "x-codex-connection-epoch": String(lease.epoch),
    "x-codex-connection-id": lease.connectionId,
    "x-codex-fencing-token": lease.fencingToken,
  };
}

createRoot(document.getElementById("root")!).render(<App />);
