# ADR 0001: Use A Node BFF And Semantic Browser API

## Status

Accepted.

## Context

The product is a web browser client for a local Codex runtime on a Windows host. `codex app-server` exposes powerful thread, turn, approval, filesystem, process, plugin, and configuration operations. Exposing that protocol directly to a remote browser would make the browser responsible for protocol safety, permission interpretation, and raw method filtering.

M0 confirmed that Node can start `codex app-server --listen stdio://` and speak JSON-RPC over stdio. The app-server WebSocket transport exists but is not the chosen MVP transport.

## Decision

All browser traffic goes through a TypeScript/Node BFF. Browser routes are semantic product operations, not raw app-server JSON-RPC.

The BFF owns app-server lifecycle, method allow-listing, input validation, notification handling, approval request handling, diagnostics redaction, and protocol version checks.

There must be no browser-accessible `/api/rpc`, `/api/json-rpc`, `/api/app-server`, debug console, or generic app-server forwarding route.

## Alternatives Considered

- Direct browser-to-app-server WebSocket: rejected for the MVP because it exposes too much protocol surface and relies on a transport that is not the selected stable integration path.
- A thin generic proxy in codex-web: rejected because it would move critical safety decisions into the browser and make policy bypass too easy.
- A desktop-only local script: useful for M0 probing, but not sufficient for a daily-use browser client across devices.

## Consequences

Every new browser capability needs a small semantic route or command. This adds work, but keeps the remote surface narrow.

App-server method additions must be reviewed at the BFF boundary. The allow-list in `src/server/app-server-client.ts` is a security boundary, not just a convenience list.

Tests should include negative cases proving raw method names, raw params, and unknown proxy routes are rejected.
