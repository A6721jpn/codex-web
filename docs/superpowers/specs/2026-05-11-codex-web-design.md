# codex-web Design

Date: 2026-05-11

## Goal

Build a self-hosted Codex remote client that runs on a Windows 11 Pro host inside a VPN and recreates the core Codex app experience in a web browser for one user across phone, iPad, and Mac.

The first version is a daily-use, chat-centered client. It should support single-user password login, exactly one active remote browser connection, shared server-side project and conversation state, arbitrary workspace paths on the host, and official-app-like approval flows for default permissions, auto review, and custom permissions.

## Non-Goals For The First Version

- Multi-user accounts or shared sessions.
- Multiple simultaneous browser connections.
- IDE-style file tree, editor panes, or terminal panes.
- Persistent always-allow permissions.
- Windows service installation.
- Direct remote exposure of `codex app-server`.

## Architecture

Use a BFF architecture:

```text
Browser UI -> codex-web BFF -> codex app-server -> local Codex tools
```

The browser only talks to the codex-web server. The BFF owns authentication, exclusive connection locking, UI metadata, app-server lifecycle, and protocol translation.

The BFF starts `codex app-server --listen stdio://` as a child process and communicates with it using JSON-RPC over stdio. The app-server WebSocket transport is experimental and unsupported, so the first version does not expose it directly or rely on it for browser traffic.

Codex thread and conversation data should come from app-server APIs whenever possible. codex-web stores only client-specific metadata locally.

## App-Server Integration

The BFF contains an `AppServerClient` responsible for:

- Starting and supervising the `codex app-server` child process.
- Sending `initialize` with `clientInfo.name = "codex_web"`.
- Enabling `capabilities.experimentalApi = true` for richer permission and approval payloads.
- Managing JSON-RPC request/response ids.
- Routing app-server notifications into an internal event bus.
- Handling app-server-initiated approval and elicitation requests.
- Restarting app-server after crashes and notifying the browser.

The first wrapper methods should cover:

- `thread/list`
- `thread/read`
- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/interrupt`

The BFF must validate browser commands before sending anything to app-server. Raw browser payloads must never be forwarded directly to stdio.

## Exclusive Connection

The system is single-user and single-active-connection.

After login, each browser gets a device session, but only one WebSocket connection may hold the active lease. If another device is already connected, the new device sees a "currently in use" screen. It cannot read or operate the app until it obtains the lease.

The active lease contains:

- Connection id.
- Device session id.
- Device label and user agent.
- Last heartbeat time.
- Lease expiry time.

The BFF must check the active lease before every privileged action:

- Starting or resuming a thread.
- Starting, steering, or interrupting a turn.
- Responding to approvals.
- Changing permissions.
- Opening or changing workspace paths.
- Taking over another connection.

Takeover is explicit. The new device must re-enter the password, then the BFF revokes the old socket with `connection.revoked`, clears old pending UI actions, and grants a new lease.

Heartbeat expiry releases dead connections. The initial timeout should be conservative, around 60 seconds, to handle phone sleep and network transitions without leaving stale locks forever.

## History And Workspace Sync

The server is the source of truth. Devices do not own thread, workspace, or approval state.

On login or reconnect, the BFF:

1. Pages through app-server `thread/list`.
2. Upserts a lightweight `thread_index`.
3. Merges the index with locally stored workspaces.
4. Shows the same project and conversation history to every device.

Conversation content is loaded lazily:

- Open a conversation: `thread/read`.
- Continue work: `thread/resume`.

The local DB does not duplicate full turn/item history. It stores only UI metadata and indexes.

Workspace paths may be arbitrary host paths, but the BFF must canonicalize them and verify access. Windows device paths, sensitive system roots, and UNC/network paths are blocked in the first version unless a later explicit allowlist is added.

## Permission Presets And Approvals

The UI exposes three permission presets:

- `Default`: Codex-like default permissions.
- `Auto Review`: Uses app-server approval review signals where available and displays the risk/rationale/action taken.
- `Custom`: Allows the user to tune filesystem, network, and command permission behavior.

The BFF passes permission profile, approval policy, and approvals reviewer settings through `thread/start`, `thread/resume`, and `turn/start` where supported.

Approval requests are first-class UI events:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- MCP or tool elicitations when needed later

The BFF stores each pending approval server-side and binds it to:

- Request id or approval id.
- Thread id.
- Turn id.
- Item id.
- Workspace/cwd.
- Command, file change, or permission payload.
- Active lease id.

The browser displays server-derived metadata only. Approval responses are idempotent and non-replayable. A unique constraint on the approval request id prevents double responses.

For permission requests, the BFF returns only the granted subset. The default scope is `turn`; `session` is used only when the user explicitly selects it. Persistent grants are deferred.

If the browser disconnects while an approval is pending, the BFF waits for a short grace period. If the same user reconnects and obtains the lease, the approval can continue. Otherwise the BFF responds with `cancel`.

## Persistence

Use SQLite for codex-web metadata and runtime state.

Tables:

- `settings`: password hash, session policy, heartbeat timeout, default permission preset.
- `device_sessions`: login sessions and device metadata.
- `active_connection`: zero or one active lease.
- `workspaces`: host paths opened by the user.
- `thread_index`: lightweight index of app-server threads.
- `ui_thread_state`: pinned/collapsed/last-opened UI state.
- `permission_presets`: default, auto-review, and custom profiles.
- `approval_events`: audit log for approval requests and decisions.
- `server_events`: server start/stop, app-server restart, errors, takeovers.

Do not store secrets in plaintext. Passwords are hashed with Argon2id or another modern password hash. Session cookies are signed, and only session ids/expiry/revocation state are persisted.

DB, logs, runtime files, and generated secrets live under a dedicated app data directory with Windows ACLs limited to the service user.

## Auth, CSRF, And WebSocket Security

The first run shows a setup screen if no password hash exists. Setup stores the password hash and returns the user to the login page.

Login creates a signed HttpOnly cookie. Cookie properties:

- `HttpOnly`
- `Path=/`
- No `Domain`
- `SameSite=Lax` or stricter if practical
- `Secure` when HTTPS is used
- Prefer `__Host-` prefix when HTTPS allows it

Authentication controls:

- Password hashing with Argon2id, scrypt, or bcrypt.
- Rate limiting and backoff for failed login attempts.
- Session rotation on login.
- Idle and absolute session expiry.
- Logout and logout-all.

CSRF protection applies to every unsafe HTTP method. The BFF validates:

- CSRF token.
- `Origin` or `Referer`.
- Fetch Metadata headers where available.

WebSocket upgrades require:

- Authenticated session.
- Exact `Origin` allowlist.
- Exact `Host` allowlist.
- Short-lived one-time connection ticket bound to the session.
- Successful active lease acquisition.

## Browser UI

The first UI is chat-centered.

Desktop layout:

- Left navigation: workspace path input, project list, conversation history.
- Center: conversation timeline.
- Bottom: input box, send, stop.

iPad uses a collapsible split layout. Phone uses the conversation as the primary view and puts history in a drawer.

Conversation items include:

- User messages.
- Agent messages.
- Reasoning summaries.
- Plans.
- Command execution cards.
- File change cards.
- Approval cards.
- Error cards.

Streaming deltas append to the active item. `item.completed` replaces the item with the authoritative final state.

Command output is collapsible and capped in memory for the first version. Large output should prefer showing the tail and a clear truncation marker.

## Internal Event Model

The BFF normalizes app-server JSON-RPC messages into UI events. The UI should not depend on raw app-server protocol details.

Event categories:

- `ConnectionEvent`
- `ThreadEvent`
- `TurnEvent`
- `ItemEvent`
- `ApprovalEvent`
- `WorkspaceEvent`
- `BackendEvent`
- `ErrorEvent`

Important events:

- `connection.ready`
- `connection.busy`
- `connection.revoked`
- `thread.indexUpdated`
- `thread.loaded`
- `turn.started`
- `turn.completed`
- `item.started`
- `item.delta`
- `item.completed`
- `approval.requested`
- `approval.resolved`
- `backend.restarting`
- `backend.ready`
- `error`

Client commands:

```ts
type ClientCommand =
  | { type: "thread.open"; threadId: string }
  | { type: "thread.start"; cwd: string; prompt?: string }
  | { type: "turn.start"; threadId: string; input: string }
  | { type: "turn.interrupt"; threadId: string; turnId: string }
  | { type: "approval.respond"; approvalId: string; decision: ApprovalDecision }
  | { type: "connection.takeover"; password: string };
```

Each command is validated against authentication, CSRF or WebSocket ticket state, active lease, and server-side authorization state.

## Windows Operation

The first version runs as a normal process under the logged-in non-admin Windows user. It is not installed as a Windows service initially because Codex auth, Git credentials, `CODEX_HOME`, user profile paths, and PATH are likely user-session-dependent.

Initial commands use npm:

```powershell
npm install
npm run dev
npm run build
npm start
```

`.env` contains process startup configuration:

```env
CODEX_WEB_HOST=127.0.0.1
CODEX_WEB_PORT=8787
CODEX_WEB_PUBLIC_ORIGIN=http://localhost:8787
CODEX_WEB_DB_PATH=./data/codex-web.sqlite
CODEX_WEB_SESSION_SECRET=
CODEX_WEB_CODEX_BIN=codex
CODEX_WEB_LOG_LEVEL=info
```

VPN exposure must be explicit. Prefer binding to the VPN interface or placing the BFF behind a reverse proxy. Add Windows Firewall rules that allow only the VPN subnet and do not expose the server on LAN/Public profiles.

The app-server child process should run with:

- Controlled environment variables.
- Fixed cwd.
- Bounded stdout/stderr buffers.
- Restart policy.
- Logs that redact secrets.

## Audit And Emergency Stop

Audit logs should include:

- Login attempts.
- Session creation and revocation.
- Connection takeover.
- Workspace changes.
- Permission changes.
- Approval decisions.
- App-server restarts.
- Server start/stop.

Add a later local CLI emergency stop that invalidates all sessions, clears the active lease, and terminates app-server child processes.

## Provisional Test Plan

This section is provisional while external ChatGPT Pro review is pending.

Server unit tests:

- Password setup and login.
- Session cookie creation, rotation, expiry, logout-all.
- CSRF checks.
- WebSocket ticket creation and one-time consumption.
- Exclusive active lease acquisition, heartbeat, expiry, and takeover.
- Workspace path canonicalization and blocked path behavior.
- Permission preset persistence.
- JSON-RPC request/response matching.

BFF integration tests:

- Fake app-server for `thread/list`, `thread/read`, `thread/start`, `thread/resume`, `turn/start`, and streaming item notifications.
- Approval request round trip.
- Idempotent approval response.
- App-server overload retry for retryable errors.
- App-server crash and restart.
- Browser disconnect during pending approval.

Browser E2E tests:

- First setup.
- Login.
- Project/thread list.
- Open thread.
- Start turn.
- Command/file/permission approval cards.
- Reject and accept approvals.
- Second device blocked.
- Takeover with password re-entry.
- Desktop, iPad, and phone widths.

Security tests:

- Missing/wrong CSRF token rejected.
- Cross-origin WebSocket rejected.
- Reused WebSocket ticket rejected.
- Non-active lease cannot approve or start turns.
- Blocked Windows paths rejected.

## Provisional Milestones

This section is provisional while external ChatGPT Pro review is pending.

M1: repository and app foundation

- TypeScript/Node server.
- React browser UI.
- npm scripts.
- lint/test setup.
- SQLite migrations.
- `.env.example`.

M2: setup, auth, and exclusive connection

- First-run password setup.
- Login/session cookie.
- CSRF.
- WebSocket ticket.
- Active connection lease.
- Busy and takeover screens.

M3: app-server client

- Start `codex app-server --listen stdio://`.
- Initialize JSON-RPC.
- Thread list/read/start/resume.
- Turn start/interrupt.
- Event normalization.

M4: chat UI

- Workspace input.
- Thread/project history.
- Conversation timeline.
- Streaming agent output.
- Command/file item cards.
- Stop button.

M5: approval UI

- Command approval.
- File change approval.
- Permission request approval.
- Session-scoped grants.
- Approval audit log.

M6: cross-device restoration

- Thread index refresh on login.
- Workspace index refresh.
- Reconnect state recovery.
- App-server restart recovery.

M7: hardening and polish

- Windows Firewall documentation.
- Redacted logs.
- Responsive layout polish.
- Error cards.
- README usage guide.
- E2E test coverage.

## Open Review Items

- Incorporate ChatGPT Pro feedback on the provisional test plan and milestones.
- Verify exact app-server permission profile names and generated TypeScript schema during implementation.
- Decide whether HTTPS is handled by codex-web directly or by a reverse proxy/VPN layer.
- Decide whether UNC/network paths remain blocked permanently or become opt-in.
