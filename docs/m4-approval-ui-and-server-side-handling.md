# M4 Approval UI And Server-Side Approval Handling

M4 adds server-owned approval state for app-server initiated approval requests. The browser still talks only to codex-web semantic routes and never sends raw app-server method names or params.

## Run

```powershell
npm test
npm run build
$env:CODEX_WEB_SESSION_SECRET = "replace-with-at-least-32-characters"
npm run preflight
npm run dev
```

## Approval Lifecycle

`AppServerClient` now distinguishes app-server JSON-RPC responses, notifications, and server-initiated requests. Messages with `id` and `method` are emitted internally as server requests. The public wrapper for answering them is `respondToServerRequest`; there is still no browser-accessible generic send/request API.

`ChatRuntime` subscribes to server requests and records pending approvals in an in-memory `ApprovalStore`. Each pending approval is bound to the active connection id and epoch at request time. Browser reads and decisions must present the current active lease headers. Stale or non-active lease decisions are rejected.

The browser-facing API is semantic:

- `GET /api/approvals`
- `POST /api/approvals/:approvalId/decision`

Decision bodies accept only:

```json
{ "decision": "approve", "scope": "turn" }
```

`decision` must be `approve`, `reject`, or `cancel`. `scope` is optional and must be `turn` or `session`; permission approvals default to `turn`, and the UI sends `session` only when explicitly selected. Duplicate decisions return a conflict and are not sent to app-server a second time.

Decision bodies with extra keys such as raw `method` or `params` are rejected. If app-server asks for an approval while no active lease exists, M4 fail-closes by sending `cancel` to app-server instead of leaving the request pending without a browser owner.

## Metadata Normalization

The BFF normalizes app-server request payloads into semantic approval cards:

- command approvals: redacted command summary, cwd, kind, available decisions, optional network host/protocol/port
- file change approvals: changed path list and diff summary only
- permission approvals: semantic permission summary and default `turn` scope
- MCP/tool elicitations: deferred/fail-closed skeleton
- unknown requests: generic fail-closed approval with only `cancel`

The browser receives only the normalized metadata. It does not receive raw app-server payloads, raw JSON-RPC method/params, raw command bodies, or full diffs.

## Persistence Policy

Pending approval payloads are memory-only in M4.

SQLite stores `approval_events` audit rows only. Audit rows contain ids, kind, status, decision, scope, lease metadata, timestamps, and `redacted_metadata_json`. They do not store user prompts, agent messages, reasoning, command output, full diffs, raw app-server payloads, raw command bodies, tool output, or raw file change bodies.

The existing no raw proxy policy remains in force. There is no `/api/rpc`, `/api/json-rpc`, `/api/app-server`, or arbitrary app-server method forwarder.

## UI Scope

The React UI shows a minimal pending approvals section after login, active connection acquisition, and workspace setup. It can refresh pending approvals and submit approve/reject/cancel decisions. Permission approvals expose a small turn/session scope selector.

## Deferred

- terminal UI
- file tree
- custom permission editor
- rich command/file/diff rendering
- persistent pending approval restoration across reconnect
- disconnect-time auto-cancel grace handling
- detailed MCP/tool elicitation forms
- session-scoped grant detail view beyond the minimal explicit selector
- Chrome + ChatGPT Pro review if the Windows sandbox/browser bridge still fails with Error 1385
