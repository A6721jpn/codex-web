# M2 SQLite, Workspace, And Thread Index

M2 extends the M1 security baseline with server-owned metadata for workspaces and thread history. It does not start real app-server runtime work, stream turns, render approvals, expose file tools, or add a permission editor.

## Run

```powershell
npm test
npm run build
npm run preflight
```

`npm run dev` starts the same BFF/UI shell as M1. After login, use **Open connection** to acquire the active WebSocket lease, then open a workspace path. Workspace list reads are active-lease gated.

## SQLite

The migration runner uses `schema_migrations` and applies versioned migrations idempotently. Version 1 keeps the M1 security/session tables. Version 2 adds:

- `workspaces`
- `workspace_policy`
- `thread_index`
- `ui_thread_state`
- `runtime_events`

Connections enable `WAL`, `busy_timeout = 5000`, and `foreign_keys = ON`.

The schema is intentionally metadata-only. SQLite must not store user prompts, agent messages, reasoning text, command output, file diffs, turn items, streaming deltas, or raw app-server payloads. `thread_index` stores ids, source kind, status, title, timestamps, and workspace references only. `runtime_events` stores redacted metadata JSON only.

## Workspace Path Policy

Workspace paths are canonicalized before persistence:

- Relative paths become absolute.
- Drive letters are normalized to uppercase.
- Trailing separators are removed except drive roots.
- Existing paths use resolved real paths.
- Missing paths can be indexed as missing without creating directories.
- Paths with spaces and Japanese characters are supported.

M2 blocks conservative Windows-dangerous shapes:

- UNC/network paths.
- Windows device paths such as `\\?\` and `\\.\`.
- Drive-root-only workspaces.
- Windows system roots under `C:\Windows`.
- Reserved device names such as `CON`, `NUL`, `COM1`, and `LPT1`.
- Alternate-data-stream-like paths containing `:` after the drive prefix.
- Sensitive user profile roots such as `.ssh`, `.gnupg`, `.aws`, `.azure`, and `.kube`.

Symlink/junction metadata is recorded where Node exposes it. Strict junction target enforcement is deferred because it needs Windows-specific reparse-point handling and policy review.

## Thread Index

M2 defines an internal thread-list adapter and fake implementation for integration tests. The BFF contract explicitly requests:

```ts
["appServer", "cli", "vscode"]
```

Pagination uses opaque string cursors. The local index represents `active`, `archived`, `ephemeral`, `missing`, and `deleted` metadata states. Real `thread/list` calls, archived/non-archived app-server sweep behavior, runtime status fields, and app-server preview handling are deferred to M3/M5.

`Thread.preview` is treated as body-like content and is not persisted in M2.

## API

M2 adds semantic browser routes:

- `GET /api/workspaces`
- `POST /api/workspaces/open`
- `GET /api/threads`

Authenticated read routes are active-lease gated. Unsafe methods require CSRF. The BFF still has no `/api/rpc`, `/api/json-rpc`, or arbitrary method forwarder.

## Deferred

- Real app-server `thread/list` integration.
- Turn streaming UI and chat timeline.
- Approval UI.
- File tree, terminal, and IDE-like panels.
- Custom permission editor.
- Junction/reparse-point target enforcement.
- Chrome + ChatGPT Pro review: attempted during M2, but the required `node_repl` browser bridge failed before Chrome connection with `windows sandbox failed: CreateProcessWithLogonW failed: 1385`.
