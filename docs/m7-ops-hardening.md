# M7 Ops, Hardening, And E2E

M7 keeps codex-web as a VPN-scoped, single-user browser client. The browser still talks only to semantic BFF routes; there is no `/api/rpc`, `/api/json-rpc`, raw method forwarder, terminal, file tree, or custom permission editor.

## Windows Firewall And VPN

Bind `CODEX_WEB_HOST` to `127.0.0.1` for local-only use, or to the VPN interface address for remote devices. If exposing over VPN, create a Windows Firewall inbound rule scoped to the VPN subnet only. Do not allow Public or broad LAN profiles unless a later deployment review explicitly accepts that risk.

## HTTPS And WSS

Use HTTPS/WSS through a local reverse proxy or VPN layer that terminates TLS. Set `CODEX_WEB_PUBLIC_ORIGIN` to the externally used HTTPS origin. Plain HTTP is acceptable only for loopback development.

## Backup And Restore

Back up the SQLite database and `.env` separately. Keep a backup before every upgrade. The database contains metadata and audit rows only; it must not contain prompts, agent messages, reasoning, command output, diffs, or raw app-server payloads. Restore by stopping the server, replacing the DB file, restoring `.env`, then running `npm run preflight`.

## Upgrade And Migration

Before upgrade, stop the server and back up the database. After pulling code and running `npm install`, run `npm test`, `npm run build`, and `npm run preflight`. SQLite migrations are applied at startup and are versioned in `schema_migrations`.

## Codex Version And Schema Regeneration

The M0 snapshot was generated from `codex-cli 0.130.0-alpha.5`. Treat schema regeneration as required when changing Codex CLI/app-server versions. Regenerate schema snapshots with `codex app-server generate-ts --experimental` and `codex app-server generate-json-schema --experimental` when changing the Codex CLI/app-server version, then review the method allow-list before release.

## Error 1385

If local command execution fails with `CreateProcessWithLogonW failed: 1385`, inspect `%USERPROFILE%\.codex\sandbox.log` and `%USERPROFILE%\.codex\setup_error.json`. App-server sandbox readiness and the Codex Desktop command runner can disagree, so `npm run preflight` reports the shell probe separately.

## Process-Tree Containment

Process-tree containment remains a carried risk. The current app-server client terminates the direct child process; Windows Job Object or `taskkill /T` containment is deferred until a service-style runtime milestone. Operators should avoid leaving codex-web running unattended on untrusted workspaces.

## Hardening Status

API responses use `no-store` and security headers. Static HTML uses `no-cache`; hashed assets can use immutable caching. Runtime diagnostics, preflight output, approval audit rows, and runtime events are redacted. Raw payload capture remains disabled by default and is not implemented.
