# Architecture Overview

This document is the compact architecture map for codex-web. It explains the current shape of the system without replaying milestone history.

## Context

codex-web is a browser client for using Codex on a Windows 11 Pro host inside a VPN. It is built for one user and multiple personal devices, but only one active remote browser connection at a time.

The browser UI is intentionally narrow in the first version: login, acquire the active connection, open a workspace, list/start/resume threads, send turns, interrupt a turn, and answer approvals.

## System Boundary

```text
Phone/iPad/Mac browser
  -> codex-web HTTP/WebSocket server
    -> codex app-server --listen stdio://
      -> local Codex tools and host filesystem
```

The browser never talks to `codex app-server` directly. The BFF owns authentication, CSRF, connection leasing, workspace metadata, local indexes, app-server lifecycle, approval normalization, and protocol translation.

## Runtime Model

`src/server/main.ts` starts the HTTP server and serves the React client. `src/server/app.ts` builds the application, routes browser requests, enforces auth/CSRF/active-lease checks, and delegates to domain services.

`AppServerClient` starts `codex app-server --listen stdio://` on demand and speaks newline-delimited JSON-RPC over stdio. It exposes only allow-listed semantic wrapper methods. App-server notifications and server-initiated approval requests are emitted internally.

`ChatRuntime` is the coordination layer above the app-server client. It refreshes thread metadata, starts/resumes threads, sends turns, interrupts turns, and routes app-server approval requests into `ApprovalStore`.

Side-effecting calls are not automatically replayed after app-server restart. A new user action is required for thread starts, resumes, turn starts, interrupts, and approval decisions after failure.

## Data Ownership

The server is the source of truth for browser-visible state. Devices do not own workspace, thread, approval, or active-connection state.

App-server remains the source for Codex conversation data. codex-web stores only client-specific metadata:

- local password/session metadata
- connection epochs and active lease state
- workspace records and workspace policy metadata
- thread index metadata
- UI thread state
- redacted runtime/audit events
- redacted approval audit rows

SQLite must not store prompt bodies, agent messages, reasoning text, command output, full diffs, raw turn item bodies, or raw app-server request/response/notification payloads.

## Security Model

The first-run flow creates one local password. Login rotates the session and issues a signed `HttpOnly` cookie. Unsafe requests require CSRF validation. WebSocket connections require short-lived, one-time, session-bound tickets.

The active lease is separate from authentication. A logged-in browser without the active lease may only see busy/takeover state. It cannot read workspaces, threads, conversations, pending approvals, or issue privileged actions.

Every privileged HTTP request presents active lease headers. WebSocket commands carry the current epoch. Takeover increments the epoch so delayed messages from the previous connection fail closed.

## App-Server Policy

codex-web is not a JSON-RPC proxy. Browser inputs are semantic fields such as `workspaceId`, `threadId`, `turnId`, `input`, `decision`, and `scope`.

The app-server method allow-list is maintained in `src/server/app-server-client.ts`. Browser-accessible routes must not accept raw `method`, `params`, `appServerMethod`, or `rawPayload` values.

The currently documented wrapper set covers model listing, thread listing/reading/turn listing, thread start/resume/unsubscribe, turn start/interrupt, and server-request responses for approvals.

## Approval Model

App-server approval requests are server-initiated JSON-RPC requests. `AppServerClient` emits them internally; the browser never receives raw method/params.

`ChatRuntime` records pending approvals in an in-memory `ApprovalStore`. Each approval is bound to the active connection id and epoch at the time the request is received. If no active lease exists, M4 cancels the request rather than leaving it ownerless.

`src/server/approvals.ts` normalizes approval metadata into browser-safe cards:

- command summary, cwd, kind, available decisions, optional network context
- changed path list and diff summary
- semantic permission summary and explicit turn/session scope
- fail-closed skeletons for deferred MCP/tool elicitations and unknown requests

SQLite stores only redacted approval audit rows. Pending raw payloads are memory-only.

## Windows Assumptions

The host is Windows 11 Pro. Workspace path validation is conservative: UNC paths, device paths, drive roots, Windows system roots, reserved device names, alternate-data-stream-like paths, and sensitive user profile roots are blocked.

M0 found that app-server sandbox readiness and the Codex Desktop command runner can disagree. Preflight therefore treats app-server readiness and actual shell execution as separate signals.

Windows child processes can outlive parents. Process-tree containment is still deferred, but any long-running app-server lifecycle work must account for Job Objects or a tree-kill fallback.

## Current Scope And Deferred Work

Stable baseline through M4:

- M1: local auth/session/CSRF/WS-ticket/active-lease security shell
- M2: SQLite metadata, workspace path policy, thread index
- M3: allow-listed app-server client and minimal chat runtime
- M4: memory-only pending approvals, semantic approval API, redacted audit rows, minimal approval UI

M5-M7 work is active in this worktree and includes reconnect/responsive/ops-hardening contract tests and M7 operational documentation. Treat it as newer than this compact architecture summary unless a later current-state doc promotes it to the stable baseline.

Deferred:

- terminal, file tree, and IDE-like panels
- custom permission editor
- detailed MCP/tool elicitation forms
- process-tree containment
- startup schema compatibility fail-closed gate
- persistent raw payload capture
- multi-user support and service installation
