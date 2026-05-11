# codex-web Design

Date: 2026-05-11

## Goal

Build a self-hosted Codex remote client that runs on a Windows 11 Pro host inside a VPN and recreates the core Codex app experience in a web browser for one user across phone, iPad, and Mac.

The first version is a daily-use, chat-centered client. It should support single-user password login, exactly one active remote browser connection, shared server-side project and conversation state, arbitrary workspace paths on the host, and official-app-like approval flows for default permissions and auto review. Arbitrary custom permission editing is deferred beyond MVP.

## Non-Goals For The First Version

- Multi-user accounts or shared sessions.
- Multiple simultaneous browser connections.
- IDE-style file tree, editor panes, or terminal panes.
- Persistent always-allow permissions.
- Custom permission editor beyond selecting built-in presets.
- Windows service installation.
- Direct remote exposure of `codex app-server`.
- Browser-accessible raw JSON-RPC console or generic app-server proxy.
- `thread/shellCommand`, app-server filesystem mutation methods, plugin/MCP management, dynamic tools, `danger-full-access`, or `approvalPolicy: never`.

## Architecture

Use a BFF architecture:

```text
Browser UI -> codex-web BFF -> codex app-server -> local Codex tools
```

The browser only talks to the codex-web server. The BFF owns authentication, exclusive connection locking, UI metadata, app-server lifecycle, and protocol translation.

The BFF starts `codex app-server --listen stdio://` as a child process and communicates with it using JSON-RPC over stdio. The app-server WebSocket transport is experimental and unsupported, so the first version does not expose it directly or rely on it for browser traffic.

Codex thread and conversation data should come from app-server APIs whenever possible. codex-web stores only client-specific metadata locally.

The BFF is a semantic API, not a generic JSON-RPC proxy. Browser routes and WebSocket commands map to a small allow-list of internal operations. The browser never supplies arbitrary app-server method names or params.

Initial browser-facing API shape:

- `GET /api/workspaces`
- `POST /api/workspaces/open`
- `GET /api/threads`
- `GET /api/threads/:threadId`
- `POST /api/threads/:threadId/turns`
- `POST /api/turns/:turnId/interrupt`
- `POST /api/approvals/:requestId/decision`
- `POST /api/ws-ticket`
- WebSocket commands using typed `ClientCommand` messages

Initial app-server method allow-list:

- `initialize`
- `model/list`
- `thread/list`
- `thread/read`
- `thread/turns/list`
- `thread/start`
- `thread/resume`
- `thread/unsubscribe`
- `turn/start`
- `turn/interrupt`
- `turn/steer` when supported
- Responses to server-initiated approval or elicitation requests

All other app-server methods are denied by default until explicitly designed and tested.

The Codex app-server protocol is version-sensitive. The implementation must pin the Codex CLI/app-server version used for a release, generate TypeScript and JSON Schema from that version when supported by `codex app-server generate-ts` / `generate-json-schema`, and record the runtime Codex version and schema hash at startup.

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

- `model/list`
- `thread/list`
- `thread/read`
- `thread/turns/list`
- `thread/start`
- `thread/resume`
- `thread/unsubscribe`
- `turn/start`
- `turn/interrupt`
- `turn/steer` when supported

The BFF must validate browser commands before sending anything to app-server. Raw browser payloads must never be forwarded directly to stdio.

Side-effecting calls must not be automatically replayed after app-server restart. Safe reads such as `model/list`, `thread/list`, and `thread/read` may retry. `turn/start`, approval decisions, command execution, and file operations must fail closed and require explicit user action after recovery.

## Exclusive Connection

The system is single-user and single-active-connection.

After login, each browser gets a device session, but only one WebSocket connection may hold the active lease. If another device is already connected, the new device sees a "currently in use" screen. It cannot read or operate the app until it obtains the lease.

The active lease contains:

- Connection id.
- Connection epoch.
- Fencing token hash.
- Device session id.
- Device label and user agent.
- Last heartbeat time.
- Lease expiry time.

The BFF must check the active lease before every privileged action:

- Reading workspace, thread, or conversation data.
- Starting or resuming a thread.
- Starting, steering, or interrupting a turn.
- Responding to approvals.
- Changing permissions.
- Opening or changing workspace paths.
- Taking over another connection.

Read APIs are lease-gated too. A logged-in browser without the active lease may only see the busy/takeover screen and cannot call `GET /api/workspaces`, `GET /api/threads`, or `GET /api/threads/:threadId` successfully.

Every WebSocket command includes the current connection epoch. The BFF rejects messages from stale epochs even if the old socket is still physically connected. Takeover increments the epoch and invalidates delayed messages from the previous device.

Same-device reloads should not feel like another device. If the same device session reconnects within a short grace window, it may reclaim its lease automatically. Different device sessions must show the busy screen and require explicit takeover.

Takeover is explicit. The new device must re-enter the password, then the BFF revokes the old socket with `connection.revoked`, clears old pending UI actions, and grants a new lease.

Heartbeat expiry releases dead connections. The initial timeout should be conservative, around 60 seconds, to handle phone sleep and network transitions without leaving stale locks forever.

## History And Workspace Sync

The server is the source of truth. Devices do not own thread, workspace, or approval state.

On login or reconnect, the BFF:

1. Pages through app-server `thread/list` with explicit source kinds.
2. Upserts a lightweight `thread_index`.
3. Merges the index with locally stored workspaces.
4. Shows the same project and conversation history to every device.

`thread/list` must explicitly request the source kinds codex-web wants to show, such as `appServer`, `cli`, and `vscode`, instead of relying on app-server defaults. Otherwise history can be silently missing.

Conversation content is loaded lazily:

- Open a conversation: prefer `thread/turns/list` pagination for large histories.
- Load metadata or smaller saved threads: `thread/read`.
- Continue work: `thread/resume`.

The local DB does not duplicate full turn/item history. It stores only UI metadata and indexes.

Workspace paths may be arbitrary host paths, but the BFF must canonicalize them and verify access. Windows device paths, sensitive system roots, and UNC/network paths are blocked in the first version unless a later explicit allowlist is added.

Each turn should pass explicit workspace policy where app-server supports it: cwd, writable roots, read-only access posture, and network access posture. The first version should keep readable and writable scope inside the selected workspace unless an approval explicitly grants more.

When a resumed thread is no longer visible or active in the UI, the BFF should call `thread/unsubscribe`. The BFF keeps its own active-thread registry so a hidden or closed UI view does not leave stale subscriptions indefinitely.

## Permission Presets And Approvals

The UI exposes three permission presets:

- `Default`: Codex-like default permissions.
- `Auto Review`: Uses app-server approval review signals where available and displays the risk/rationale/action taken.
- `Custom`: Deferred beyond MVP as a full editor. The MVP may store a selected built-in preset, but does not expose arbitrary permission editing.

The BFF passes permission profile, approval policy, and approvals reviewer settings through `thread/start`, `thread/resume`, and `turn/start` where supported.

Approval requests are first-class UI events:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- Network-only command approval with `networkApprovalContext`
- MCP or tool elicitations when needed later

The BFF stores each pending approval server-side and binds it to:

- Request id or approval id.
- Thread id.
- Turn id.
- Item id.
- Workspace/cwd.
- Redacted command, file change, or permission metadata.
- Active lease id.

The browser displays server-derived metadata only. Approval responses are idempotent and non-replayable. A unique constraint on the approval request id prevents double responses.

Approval cards must show what is being granted as structured data, not only a command string.

Command approval cards show:

- Command.
- Cwd.
- Effective sandbox and approval policy.
- Additional filesystem or network permissions.
- `networkApprovalContext` host, protocol, and port when present.
- Server-provided `availableDecisions` when present.

File change approval cards show:

- Changed paths.
- Diff summary.
- Workspace-relative or outside-workspace status.
- Symlink or junction resolved path where available.
- `grantRoot` when app-server asks for session-scoped write access.

Network approvals use a separate visual treatment that names the host, protocol, and port. They must not be hidden behind a shell command preview.

For permission requests, the BFF returns only the granted subset. The default scope is `turn`; `session` is used only when the user explicitly selects it. Persistent grants are deferred.

`acceptForSession` and policy-amendment decisions are not primary buttons in the MVP. If exposed, they require a detail view that shows the exact session-scoped permission or policy amendment.

If the browser disconnects while an approval is pending, the BFF waits for a short grace period. If the same user reconnects and obtains the lease, the approval can continue. Otherwise the BFF responds with `cancel`.

## Persistence

Use SQLite for codex-web metadata and runtime state.

Tables:

- `schema_migrations`: migration version tracking.
- `settings`: password hash, session policy, heartbeat timeout, default permission preset.
- `device_sessions`: login sessions and device metadata.
- `connection_epochs`: active lease history, epoch, fencing token hash, heartbeat, revocation reason.
- `active_connection`: zero or one active lease, derived from the current connection epoch.
- `workspaces`: host paths opened by the user.
- `workspace_policy`: canonical path, trust state, default preset, realpath, last existence check, last error.
- `thread_index`: lightweight index of app-server threads.
- `ui_thread_state`: pinned/collapsed/last-opened UI state.
- `pending_server_requests`: server-initiated JSON-RPC request ids, kind, redacted metadata, state, and expiry.
- `permission_presets`: built-in preset selection and future custom profiles.
- `approval_events`: audit log for approval requests and decisions.
- `audit_events`: redacted login, logout, takeover, workspace, approval, and permission events.
- `runtime_events`: redacted server start/stop, app-server restart, and error events.
- `app_server_runtime`: Codex binary path, Codex version, generated schema hash, pid, started_at, initialize result.
- `login_attempts`: rate-limit and backoff state.

Do not store secrets in plaintext. Passwords are hashed with Argon2id or another modern password hash. Session cookies are signed, and only session ids/expiry/revocation state are persisted.

Persisted session ids and device ids should be hashed server-side. The browser may hold an opaque device id, but the DB should not rely on browser fingerprinting for identity.

DB, logs, runtime files, and generated secrets live under a dedicated app data directory with Windows ACLs limited to the service user.

The DB must not store full user prompts, agent messages, reasoning text, command output, or file diffs in normal operation. Audit rows store event type, ids, redacted metadata, decision, status, timestamps, and error codes. Raw payload capture is debug-only, opt-in, short-lived, redacted, and disabled by default.

Pending approval payloads that include command text, diffs, or permission details live in memory while the request is active. SQLite stores only opaque ids and redacted metadata needed to audit and cancel the request after reconnect or timeout.

SQLite should run with WAL mode, `busy_timeout`, short transactions, and atomic compare-and-swap updates for active leases and fencing tokens.

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

The recommended flow is:

1. UI calls `POST /api/ws-ticket` with a valid CSRF token.
2. BFF issues a one-time ticket valid for about 30 seconds.
3. UI opens `wss://.../ws?ticket=...`.
4. BFF validates session, ticket, host, origin, and lease state, then consumes the ticket.

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

Command output, diffs, paths, and tool output are rendered as text, never trusted HTML. The UI must neutralize ANSI escape sequences, control characters, and Unicode bidi controls before display.

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

Each command is validated against authentication, CSRF or WebSocket ticket state, active lease, connection epoch, and server-side authorization state.

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
- Process-tree containment so app-server child or grandchild processes do not remain orphaned after BFF shutdown or restart.

Windows sandbox behavior is a core MVP risk, not polish. Preflight and error handling should cover:

- `codex app-server` availability and version.
- `generate-ts` / `generate-json-schema` availability.
- Windows sandbox setup status where exposed by app-server.
- Elevated sandbox availability and unelevated fallback.
- Error 1385 and related logon-right failures.
- Everyone-writable workspace warnings.
- Network-disabled and network-approval behavior.
- Sandbox log path guidance.

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

Emergency stop should terminate the app-server process tree, not only the direct child process. On Windows this may require Job Object support or a `taskkill /T` equivalent.

## Reviewed Test Plan

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
- Real app-server smoke tests for initialize, model list, thread list, start, stream, interrupt, and resume.
- Generated schema compatibility and schema hash recording.
- JSON-RPC behavior including omitted wire `jsonrpc` field when app-server expects it.
- Approval request round trip.
- Idempotent approval response.
- `serverRequest/resolved` before and after approval response.
- App-server overload retry for retryable errors.
- App-server crash and restart.
- Safe reads retried after restart; side-effecting calls not replayed.
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
- Missing origin WebSocket rejected.
- Reused WebSocket ticket rejected.
- Non-active lease cannot approve or start turns.
- Stale connection epoch cannot approve or start turns.
- Session fixation and logout-after-cookie reuse.
- Login brute force rate limit and backoff.
- Cookie flags and static asset cache behavior.
- Blocked Windows paths rejected.

History tests:

- `thread/list` pagination.
- Explicit source kinds versus default source kinds.
- Archived, ephemeral, missing, and deleted threads.
- Cwd and searchTerm filters.
- Large thread pagination through `thread/turns/list`.

Approval safety tests:

- Command approval.
- File change approval.
- Network approval with host/protocol/port display.
- Missing or invalid `availableDecisions`.
- Duplicate decision click.
- App-server crash during approval.
- ANSI escape, HTML, newline, Unicode bidi, and long output rendering.

Windows path tests:

- Paths with spaces.
- Japanese paths.
- Drive letter case differences.
- OneDrive paths.
- UNC paths.
- Junctions and symlinks.
- Volume mount points.
- Reserved device names.
- Alternate data stream-like paths.
- Long paths.

Crash/restart tests:

- Partial stdout line.
- Invalid JSON.
- stdout/stderr flood.
- Child process exit.
- BFF restart.
- App-server restart during active turn.
- App-server restart during approval.
- Orphan process cleanup.
- DB locked state.

No-body-persistence tests:

- SQLite does not persist user prompts.
- SQLite does not persist agent message deltas.
- SQLite does not persist reasoning text.
- SQLite does not persist command output.
- SQLite does not persist file diffs.

Windows sandbox operations tests:

- Elevated sandbox setup success.
- Unelevated fallback.
- Network disabled behavior.
- Network approval behavior.
- Everyone-writable warning display.
- Sandbox log path display.

## Revised Milestones

M0: protocol and Windows feasibility spike

- Start real `codex app-server --listen stdio://`.
- Confirm initialize handshake.
- Exercise `model/list`, `thread/list`, `thread/start`, `turn/start`, streaming, interrupt, and resume.
- Generate TypeScript and JSON Schema from the installed app-server.
- Decide Codex version pinning and schema hash policy.
- Check Windows sandbox setup, elevated/unelevated behavior, and sandbox log reporting.

M1: BFF security baseline

- TypeScript/Node server.
- React browser UI.
- npm scripts.
- lint/test setup.
- SQLite migrations.
- `.env.example`.
- First-run password setup.
- Login/session cookie.
- CSRF.
- WebSocket ticket.
- Active connection lease.
- Fencing token and connection epoch.
- Busy and takeover screens.
- Raw JSON-RPC proxy explicitly absent.

M2: SQLite, workspace, and thread index

- WAL mode, busy timeout, migrations.
- Workspace canonicalization and blocked path handling.
- Thread list pagination.
- Explicit source kinds.
- Archived, ephemeral, and missing thread handling.
- Thread index integration.

M3: app-server client and minimal chat runtime

- Start `codex app-server --listen stdio://`.
- Initialize JSON-RPC.
- Generated schema compatibility check.
- Thread list/read/turns-list/start/resume/unsubscribe.
- Turn start/interrupt.
- Event normalization.
- Workspace input.
- Thread/project history.
- Conversation timeline.
- Streaming agent output.
- Command/file item cards.
- Stop button.
- Backend restart state refresh.

M4: approval UI

- Command approval.
- File change approval.
- Network approval.
- Permission request approval.
- Session-scoped grants only through the detail-gated flow.
- `availableDecisions` and `serverRequest/resolved`.
- Duplicate decision prevention.
- Disconnect-time cancel.
- Approval audit log.

M5: reconnect and cross-device restoration

- Thread index refresh on login.
- Workspace index refresh.
- Reconnect state recovery.
- Same-device reload handling.
- Takeover race handling.
- Pending approval restoration.
- Thread unsubscribe.
- App-server restart recovery.

M6: responsive UI polish

- Left navigation.
- Phone drawer.
- iPad split view.
- Search term.
- Display names.
- Last access.
- Error cards.

M7: ops, hardening, README, and E2E

- Windows Firewall documentation.
- HTTPS/WSS or reverse proxy guidance.
- Redacted logs.
- Backup and upgrade guidance.
- Schema regeneration guidance.
- Codex version compatibility notes.
- README usage guide.
- E2E test coverage.

## Open Review Items

- Verify exact app-server permission profile names and generated TypeScript schema during implementation.
- Decide whether HTTPS is handled by codex-web directly or by a reverse proxy/VPN layer.
- Decide whether UNC/network paths remain blocked permanently or become opt-in.
- Decide exact process-tree containment implementation on Windows.
