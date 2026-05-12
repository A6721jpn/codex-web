# M1 Security Baseline

M1 implements the browser-facing security shell only. It does not implement app-server turns, thread history sync, approval UI, terminal/file tools, or a custom permission editor.

## Run

```powershell
copy .env.example .env
# Edit CODEX_WEB_SESSION_SECRET to a random value with at least 32 characters.
npm install
npm run dev
```

Use `npm test` for focused security tests and `npm run build` for TypeScript and React build verification.

Run `npm run preflight` on the Windows host before wiring app-server lifecycle work into later milestones.

## Security Model

- First run requires local password setup. The password is stored as a `scrypt` hash in SQLite.
- Login rotates the session and issues a signed `HttpOnly` cookie.
- Unsafe API methods require CSRF validation. The CSRF helper checks the token, `Origin` or `Referer`, and Fetch Metadata when present.
- WebSocket access starts with `POST /api/ws-ticket`. Tickets are session-bound, one-time, and short-lived.
- The active connection lease allows exactly one browser connection to hold privileged access. A takeover requires password re-entry and increments the connection epoch.
- Browser routes are semantic. There is no `/api/rpc`, `/api/json-rpc`, or arbitrary app-server method forwarder.

## SQLite Scope

The M1 schema contains only metadata tables:

- `schema_migrations`
- `settings`
- `device_sessions`
- `connection_epochs`
- `active_connection`
- `login_attempts`
- `ws_tickets`

SQLite must not store conversation bodies, reasoning text, command output, or file diffs.

## M0 Windows Risk Carry-Forward

Preflight covers `codex --version`, `codex app-server --help`, and a real shell launch probe. The app-server `windowsSandbox/readiness` signal remains optional/check-only in M1 because M0 showed it can report ready while this Codex Desktop command runner fails with Error 1385.

Operators should treat Error 1385 as a logon-right/sandbox setup problem and inspect `%USERPROFILE%\.codex\sandbox.log` and `%USERPROFILE%\.codex\setup_error.json`.

App-server stdout/stderr must be capped and redacted before logging because M0 observed remote-service error bodies on stderr. M1 documents the policy and carries a preflight redaction helper; app-server supervision is deferred to M3.

Windows child processes can outlive parents. Process-tree containment and cleanup, preferably Windows Job Objects plus a tree-kill fallback, is deferred to the app-server lifecycle milestone. M1 records this as a go/no-go risk for M2/M3 rather than starting long-lived app-server processes.

## Deferred

- App-server stdio lifecycle and schema compatibility gate.
- Thread list/history sync.
- Turn streaming UI.
- Approval UI and permission editor.
- Workspace/file tree/terminal/IDE UI.
- Raw payload capture, even for debugging, unless a later opt-in redaction design is approved.
