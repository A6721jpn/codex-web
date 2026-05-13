# M3 App-Server Client And Minimal Chat Runtime

M3 adds the first real BFF runtime path to `codex app-server --listen stdio://`. The browser still talks only to codex-web semantic routes; it never sends raw app-server method names or params.

## Run

```powershell
npm test
npm run build
$env:CODEX_WEB_SESSION_SECRET = "replace-with-at-least-32-characters"
npm run preflight
npm run dev
```

## App-Server Lifecycle

- `AppServerClient` starts `codex app-server --listen stdio://` on demand and talks JSON-RPC over newline-delimited stdio.
- The initialize handshake sends `clientInfo.name = "codex_web"` and `capabilities.experimentalApi = true`.
- Request ids are matched to responses. Notifications are emitted internally and are not treated as request responses.
- Startup failure, process errors, and process exit move the client into an unavailable state and reject pending requests.
- M3 does not automatically replay side-effecting calls after app-server exit or restart. `thread/start`, `thread/resume`, `turn/start`, and `turn/interrupt` require a fresh user-triggered route call.
- stdout/stderr diagnostics are capped and redacted. Raw app-server bodies are not saved.

## BFF Policy

The app-server wrapper exposes only these semantic methods:

- `model/list`
- `thread/list`
- `thread/read`
- `thread/turns/list`
- `thread/start`
- `thread/resume`
- `thread/unsubscribe`
- `turn/start`
- `turn/interrupt`

There is still no `/api/rpc`, `/api/json-rpc`, or arbitrary app-server forwarder. Browser routes accept semantic fields such as `workspaceId`, `threadId`, `input`, and `turnId`.

## Thread And Persistence Policy

`POST /api/threads/refresh` pages through app-server `thread/list` with explicit `sourceKinds: ["appServer", "cli", "vscode"]`, then upserts the M2 `thread_index`.

SQLite remains metadata-only. M3 does not persist:

- user prompts
- agent messages
- reasoning text
- command output
- diffs
- turn item bodies
- raw app-server request, response, notification, stdout, or stderr bodies

`thread/read` and `thread/turns/list` return runtime responses to the caller but do not write those bodies into SQLite.

## Browser Routes

M3 adds these authenticated, active-lease gated routes:

- `POST /api/threads/refresh`
- `GET /api/threads/:threadId`
- `GET /api/threads/:threadId/turns`
- `POST /api/threads/start`
- `POST /api/threads/:threadId/resume`
- `POST /api/threads/:threadId/turns`
- `POST /api/turns/:turnId/interrupt`

Unsafe requests require CSRF. Workspace cwd and policy values are derived server-side from `workspaceId`.

## UI Scope

The React UI now exposes a minimal chat-centered entry after login, active connection, and workspace open:

- refresh thread index
- display thread list
- start a thread with a short prompt
- send a turn to a selected thread
- interrupt the active turn

The M3 timeline is intentionally minimal and does not render rich conversation bodies.

## Deferred

- approval UI and approval decision routes
- file tree, terminal, command cards, file cards, and custom permission editor
- rich streaming timeline and item rendering
- browser WebSocket event normalization beyond the active connection message
- generated schema compatibility enforcement at startup
- process-tree containment with Windows Job Objects or `taskkill /T` fallback
- automatic safe-read retry after restart
- Chrome + ChatGPT Pro review if the Windows sandbox/browser bridge still fails with Error 1385
