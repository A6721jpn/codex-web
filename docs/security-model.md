# Security Model

This document consolidates current security invariants. It does not replace the milestone docs; it is the current-state entry point.

## Trust Boundary

The remote browser is not trusted with raw Codex app-server control. It talks only to codex-web semantic routes and WebSocket messages.

The codex-web server runs on the Windows host inside a VPN and is trusted to enforce:

- local authentication
- CSRF
- active connection leasing
- app-server method allow-listing
- workspace path policy
- approval normalization and decision validation
- metadata-only persistence

## Authentication And Browser Access

The first-run setup creates a local single-user password. The password is stored as a `scrypt` hash in SQLite.

Login rotates the session and issues a signed `HttpOnly` cookie. Unsafe HTTP methods require CSRF validation. WebSocket access uses short-lived, one-time, session-bound tickets from `POST /api/ws-ticket`.

Authentication is necessary but not sufficient. Privileged operations also require the active connection lease.

## Active Lease

Exactly one browser connection may hold privileged access at a time. The active lease gates reads and writes:

- workspace list/open
- thread list/read/turns
- thread start/resume
- turn start/interrupt
- approval list/decision

Takeover requires password re-entry and increments the epoch. Old HTTP lease headers and old WebSocket messages are rejected.

## App-Server Boundary

The BFF must not expose raw app-server method forwarding.

Forbidden browser-facing shapes include:

- `/api/rpc`
- `/api/json-rpc`
- `/api/app-server`
- request bodies that smuggle `method`, `params`, `appServerMethod`, or `rawPayload`
- debug consoles that submit arbitrary app-server calls

New app-server functionality must be added as a semantic operation with tests at the route and wrapper layer.

## Persistence Boundary

SQLite may store metadata and redacted audit rows. It must not store:

- prompts
- assistant messages
- reasoning
- command output
- full diffs
- raw turn item bodies
- raw app-server request, response, notification, stdout, or stderr bodies

Pending approval payloads are memory-only in M4. Audit rows contain ids, status, decision, scope, lease metadata, timestamps, and redacted metadata.

## Workspace Boundary

Workspace paths are canonicalized before persistence. The current policy blocks conservative Windows-dangerous shapes, including UNC paths, device paths, drive roots, Windows system roots, reserved device names, alternate-data-stream-like paths, and sensitive user profile roots.

Symlink/junction target enforcement is still deferred and needs Windows-specific handling.

## Approval Boundary

The browser receives normalized approval metadata, not raw app-server payloads. Decision bodies are narrow and reject extra raw keys.

Session-scoped approval behavior remains intentionally limited. If a future change expands persistent or session grants, it needs an ADR and UI that shows the exact scope being granted.

## Known Gaps

- Process-tree containment is deferred. Long-running app-server supervision must include Job Object or tree-kill design before exposure beyond the current MVP assumptions.
- Startup schema compatibility enforcement is not fully implemented.
- Pending approval restoration across reconnect is deferred.
- Detailed MCP/tool elicitation forms are deferred.
- HTTPS/WSS termination boundary is not yet recorded as an accepted ADR.
