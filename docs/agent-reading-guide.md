# Agent Reading Guide

This guide is the preferred entry point for an LLM or sub-agent with no prior context.
Read it before scanning milestone history.

## Mission

`codex-web` is a self-hosted, single-user web client for using Codex remotely from a browser.
The host is a Windows 11 Pro machine inside a VPN. The user connects from a phone, iPad, or Mac.

The first version is chat-centered. File trees, terminals, IDE-like panels, and a custom permission editor are deferred until the chat and approval loop is reliable.

## Read Order

Use the smallest set that answers the task.

| Task | Read first | Then read |
| --- | --- | --- |
| Understand the project | `README.md`, `AGENTS.md`, this file | `docs/architecture/overview.md` |
| Change auth, sessions, CSRF, or active connection behavior | `docs/architecture/overview.md` | `docs/m1-security-baseline.md`, `src/server/auth.ts`, `src/server/security.ts`, `src/server/connection-lease.ts`, `src/server/ws-ticket.ts`, `src/server/app.ts` |
| Change workspace or thread metadata | `docs/architecture/overview.md` | `docs/m2-sqlite-workspace-thread-index.md`, `src/server/workspace.ts`, `src/server/thread-index.ts`, `src/server/db.ts` |
| Change app-server communication or chat turns | `docs/architecture/overview.md` | `docs/m0/protocol-and-windows-feasibility.md`, `docs/m3-app-server-client-minimal-chat-runtime.md`, `src/server/app-server-client.ts`, `src/server/chat-runtime.ts` |
| Change approvals | `docs/architecture/overview.md` | `docs/m4-approval-ui-and-server-side-handling.md`, `docs/adr/0004-server-owned-approval-state.md`, `src/server/approvals.ts`, `src/server/chat-runtime.ts`, `src/server/app.ts` |
| Decide whether a behavior is intentional | `docs/adr/README.md` | The ADR for that decision, then the relevant milestone doc |
| Check current milestone state | `docs/milestones.md` | Relevant milestone doc |
| Check security invariants | `docs/security-model.md` | Relevant ADR and source files |
| Run or diagnose the app | `docs/runbook.md` | `README.md`, relevant milestone doc |
| Evaluate or improve docs | `docs/llm-doc-evaluation.md` | Run a fresh no-context review against this guide |

## Core Invariants

- The server is the source of truth for project, thread, workspace, approval, and connection state.
- The browser talks only to the codex-web BFF. It never talks directly to `codex app-server`.
- Browser routes are semantic. There is no raw JSON-RPC proxy or generic app-server forwarder.
- Exactly one browser connection may hold the active lease at a time.
- SQLite stores only client metadata and redacted audit rows. It must not store prompts, assistant messages, reasoning, command output, full diffs, turn item bodies, or raw app-server payloads.
- App-server thread, turn, item, approval, and resume APIs remain the primary model for Codex data.
- Approval state is server-owned. Pending approval payloads are memory-only in M4.
- Windows host behavior is part of the design. Sandbox readiness, process cleanup, path safety, and stderr redaction cannot be treated as generic Unix assumptions.

## Current Milestone State

M0 proved Node can start and speak JSON-RPC over stdio to the real `codex app-server`.
M1 added the browser-facing security shell.
M2 added SQLite metadata, workspace policy, and a thread index.
M3 added the allow-listed app-server client and minimal chat runtime.
M4 added server-owned pending approvals, semantic approval routes, redacted audit rows, and a minimal approval UI.
M5-M7 work is active/forward-looking in this worktree; check `docs/milestones.md`, `docs/m7-ops-hardening.md`, and the matching tests before treating those behaviors as stable baseline.

Deferred work still includes terminal/file tree panels, custom permission editing, persistent raw payload capture, multi-user support, service installation, full Windows process-tree containment, and startup schema compatibility enforcement.

## Source Ownership Map

| Area | Main files | Notes |
| --- | --- | --- |
| HTTP app and routes | `src/server/app.ts` | Owns semantic browser API, auth/CSRF/lease gates, approval routes, and WebSocket upgrade handling. |
| Auth and sessions | `src/server/auth.ts`, `src/server/crypto.ts`, `src/server/security.ts` | Local password setup, signed session cookies, password hashing, CSRF validation. |
| Active connection | `src/server/connection-lease.ts`, `src/server/ws-ticket.ts` | Single active lease, takeover fencing, one-time WebSocket tickets. |
| Config and preflight | `src/server/config.ts`, `src/server/preflight.ts`, `src/server/preflight-cli.ts` | Runtime config, Codex binary checks, sandbox and shell probes. |
| SQLite | `src/server/db.ts` | Migration runner and SQLite connection policy. |
| Workspaces | `src/server/workspace.ts` | Canonicalization, Windows path validation, workspace metadata persistence. |
| Thread index | `src/server/thread-index.ts` | Metadata-only index, source kinds, pagination, UI state. |
| App-server protocol | `src/server/app-server-client.ts` | Starts `codex app-server --listen stdio://`, request/response matching, allowed methods, diagnostics redaction. |
| Chat runtime | `src/server/chat-runtime.ts` | Thread refresh/start/resume/turn operations, app-server request handling, approval store integration. |
| Approvals | `src/server/approvals.ts` | Normalizes app-server approval requests, enforces lease binding and duplicate decision handling. |
| React UI | `src/client/main.tsx`, `src/client/styles.css` | Minimal login, connection, workspace, chat, and approval UI. |
| M0 probes | `src/m0/*` | Protocol generation and feasibility scripts; not browser-facing runtime code. |

## Test Ownership Map

| Area | Tests |
| --- | --- |
| M0 JSON-RPC and redaction helpers | `test/m0/json-rpc.test.ts`, `test/m0/redaction.test.ts` |
| M1 security shell | `test/m1/security-baseline.test.ts` |
| M2 SQLite, workspace, thread index | `test/m2/sqlite-workspace-thread-index.test.ts` |
| M3 app-server client and chat runtime | `test/m3/app-server-client.test.ts`, `test/m3/minimal-chat-runtime.test.ts` |
| M4 approval runtime and API | `test/m4/approval-runtime.test.ts`, `test/m4/approval-api.test.ts` |
| M5/M6/M7 forward-looking contracts | `test/m5/reconnect-restoration.test.ts`, `test/m6/responsive-ui-contract.test.ts`, `test/m7/ops-hardening-e2e.test.ts` |

M5/M6/M7 tests are contract markers for planned work. If they fail or describe missing behavior, check whether the related milestone is implemented before treating the docs as stale.

## Decision Records

Read ADRs when a question starts with "why" or when a change touches a project invariant.

- `docs/adr/0001-use-node-bff-and-semantic-api.md`
- `docs/adr/0002-keep-server-source-of-truth-and-sqlite-metadata-only.md`
- `docs/adr/0003-use-single-active-connection-lease.md`
- `docs/adr/0004-server-owned-approval-state.md`
- `docs/adr/backlog.md` lists known decisions that are not accepted yet.

## Document Status

- Current-state entry points: this file, `docs/architecture/overview.md`, `docs/security-model.md`, `docs/runbook.md`, and `docs/milestones.md`.
- Decision rationale: `docs/adr/`.
- Historical milestone detail: `docs/m0/`, `docs/m1-*`, `docs/m2-*`, `docs/m3-*`, `docs/m4-*`.
- Broad original design: `docs/superpowers/specs/2026-05-11-codex-web-design.md`.
- Supporting review/planning artifacts: `docs/security-review-*.md`, `docs/codex-web-development-plan-ja.html`.
- Generated protocol snapshots: `docs/m0/generated/`. Do not read these for orientation.

## Context Budget Guidance

For a small implementation task, do not read every milestone document up front.
Start with `README.md`, `AGENTS.md`, and this file. Add `docs/architecture/overview.md` only when you need the current architecture model, then open only the row-specific docs from the read-order table.

Approximate reading budget:

- Orientation: this file plus `README.md` and `AGENTS.md`; target under 2,500 words.
- Architecture: add `docs/architecture/overview.md` when the task needs system boundaries or ownership details.
- Decision rationale: add only the relevant ADR.
- Implementation: add the relevant milestone doc and source files.

If the task requires changing an invariant, read the relevant ADR before editing.
