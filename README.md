# codex-web

Self-hosted web client for using Codex remotely from a browser.

The target host is a Windows 11 Pro machine inside a VPN. The client is intended for one user who connects from a phone, iPad, or Mac and wants the core Codex app experience without sitting at the host machine.

## Goal

Build a remote Codex client that feels close to the official app for daily development:

- Chat-centered UI with project and conversation history.
- Single-user password login.
- Exactly one active remote connection at a time.
- Shared server-side project and conversation state across devices.
- Arbitrary workspace paths on the host machine.
- TypeScript/Node BFF between the browser and `codex app-server`.
- Approval flows for default permissions, auto review, and custom permissions.

## Initial Architecture

The planned first version uses a BFF architecture:

```text
Browser UI -> codex-web server -> codex app-server -> local Codex tools
```

The browser only talks to the codex-web server. The server owns authentication, exclusive connection locking, UI metadata, and app-server communication. Codex thread and conversation data should come from `codex app-server` whenever possible, with local storage used only for client-specific metadata.

## Status

This repository is in the design/setup phase. The first implementation milestone is a minimal chat-centered remote client.

The current design is documented in [docs/superpowers/specs/2026-05-11-codex-web-design.md](docs/superpowers/specs/2026-05-11-codex-web-design.md).

M0 protocol and Windows feasibility results are documented in [docs/m0/protocol-and-windows-feasibility.md](docs/m0/protocol-and-windows-feasibility.md).

M1 security baseline setup and scope are documented in [docs/m1-security-baseline.md](docs/m1-security-baseline.md).

M2 SQLite, workspace policy, and thread index scope are documented in [docs/m2-sqlite-workspace-thread-index.md](docs/m2-sqlite-workspace-thread-index.md).

M3 app-server client and minimal chat runtime scope are documented in [docs/m3-app-server-client-minimal-chat-runtime.md](docs/m3-app-server-client-minimal-chat-runtime.md).

M4 approval UI and server-side approval handling scope are documented in [docs/m4-approval-ui-and-server-side-handling.md](docs/m4-approval-ui-and-server-side-handling.md).

## M1 Development

```powershell
copy .env.example .env
# Set CODEX_WEB_SESSION_SECRET to at least 32 random characters.
npm install
npm run dev
```

Validation:

```powershell
npm test
npm run build
```

See [AGENTS.md](AGENTS.md) for project goals and development rules.

## M2 Development

M2 adds SQLite migration versioning, workspace metadata/policy, and a lightweight thread index. It remains metadata-only: prompts, agent messages, reasoning, command output, diffs, turn items, and raw app-server payloads are not stored in SQLite.

Validation:

```powershell
npm test
npm run build
npm run preflight
```

## M3 Development

M3 adds an allow-listed server-side app-server client and minimal chat runtime. The browser API remains semantic and does not expose raw JSON-RPC forwarding. Thread refresh uses explicit `sourceKinds: ["appServer", "cli", "vscode"]` and stores only thread metadata in SQLite.

Validation:

```powershell
npm test
npm run build
$env:CODEX_WEB_SESSION_SECRET = "replace-with-at-least-32-characters"
npm run preflight
npm run dev
```

M3 intentionally defers approval UI, rich timeline rendering, terminal/file panels, custom permission editing, and Windows process-tree containment.

## M4 Development

M4 adds memory-only pending approval handling, redacted SQLite approval audit rows, semantic approval list/decision routes, and a minimal approval card UI. The browser still cannot call raw app-server JSON-RPC methods or submit raw method/params. Approval request bodies, command bodies, full diffs, prompts, agent messages, reasoning, command output, and raw app-server payloads are not persisted.

Validation:

```powershell
npm test
npm run build
$env:CODEX_WEB_SESSION_SECRET = "replace-with-at-least-32-characters"
npm run preflight
npm run dev
```

M4 intentionally defers terminal/file tree views, custom permission editing, rich diff/command rendering, reconnect restoration of pending approvals, and detailed MCP/tool elicitation forms.
