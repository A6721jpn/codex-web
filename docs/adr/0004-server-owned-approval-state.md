# ADR 0004: Use Server-Owned Approval State

## Status

Accepted.

## Context

Codex approval requests can authorize shell commands, file changes, permission grants, network access, and future MCP/tool elicitations. The browser must show enough structure for the user to decide, but must not receive raw app-server request payloads or be allowed to fabricate responses.

Approval requests arrive from app-server while a turn is running. A browser may disconnect, reload, or lose the active lease while an approval is pending.

## Decision

Approval state is owned by the server. `AppServerClient` detects app-server-initiated requests and emits them internally. `ChatRuntime` records pending approvals in an in-memory `ApprovalStore`, bound to the active connection id and epoch.

The browser uses semantic approval routes:

- `GET /api/approvals`
- `POST /api/approvals/:approvalId/decision`

Decision bodies are narrow: `decision` is `approve`, `reject`, or `cancel`; `scope` is optional and limited to `turn` or `session`. Extra raw keys are rejected.

The browser receives normalized metadata only. SQLite stores redacted approval audit rows, not pending payloads or raw app-server bodies.

If app-server asks for an approval while no active lease exists, the MVP fails closed by sending `cancel`.

## Alternatives Considered

- Let the browser hold pending approval payloads: rejected because stale devices could act on old approvals and raw payloads would cross the browser boundary.
- Persist pending approvals in SQLite: deferred because pending payloads can contain sensitive command, diff, or tool details.
- Expose app-server approval method/params to the browser: rejected because it bypasses BFF policy and makes response fabrication easier.
- Expose session-scoped grants as primary MVP buttons: rejected until the UI can show the exact scope and consequences.

## Consequences

Approval UI work must start from normalized metadata in `src/server/approvals.ts`, not raw app-server payloads.

Approval decisions must be idempotent and non-replayable. Duplicate decisions should not be sent to app-server twice.

Reconnect restoration of pending approvals requires a later explicit design because M4 pending approval state is memory-only.
