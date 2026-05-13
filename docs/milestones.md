# Milestones

This table separates current implementation state from historical research notes.

| Milestone | Status | Current meaning | Primary docs |
| --- | --- | --- | --- |
| M0 | Completed spike | Proved Node can start and speak to real `codex app-server --listen stdio://` on the Windows host. Records protocol and Windows risks. | `docs/m0/protocol-and-windows-feasibility.md` |
| M1 | Implemented | Browser-facing security shell: password setup/login, signed sessions, CSRF, WebSocket tickets, active lease basics. | `docs/m1-security-baseline.md` |
| M2 | Implemented | SQLite metadata, workspace path policy, thread index, workspace/thread semantic routes. | `docs/m2-sqlite-workspace-thread-index.md` |
| M3 | Implemented | Allow-listed app-server client and minimal chat runtime for thread refresh/start/resume/turn/interrupt. | `docs/m3-app-server-client-minimal-chat-runtime.md` |
| M4 | Implemented | Server-owned pending approvals, normalized approval metadata, semantic approval routes, redacted approval audit rows, minimal approval UI. | `docs/m4-approval-ui-and-server-side-handling.md` |
| M5 | Active/contract | Reconnect and cross-device restoration behavior. Contract tests exist under `test/m5/`; verify current pass/fail before treating as stable. | Not yet consolidated. |
| M6 | Active/contract | Responsive chat-centered UI behavior. Contract tests exist under `test/m6/`; verify current pass/fail before treating as stable. | Not yet consolidated. |
| M7 | Active/contract | Ops hardening, Windows/VPN runbook details, security headers/cache policy, and server-side E2E smoke coverage. | `docs/m7-ops-hardening.md`, `test/m7/` |

## Source-Of-Truth Labels

- `docs/agent-reading-guide.md`: current reading order and source ownership.
- `docs/architecture/overview.md`: current architecture summary.
- `docs/adr/`: stable decisions and rationale.
- `docs/m0/` through `docs/m4-*`: milestone-specific implementation notes.
- `docs/superpowers/specs/2026-05-11-codex-web-design.md`: original broad design; useful but not the shortest current-state entry point.
- `docs/security-review-*.md` and `docs/codex-web-development-plan-ja.html`: review/planning artifacts. Treat as supporting context unless a current architecture or ADR file links to a specific decision.
- `docs/m0/generated/`: generated protocol snapshots. Do not read as narrative documentation unless validating protocol types or schema drift.

## Freshness Rules

When changing behavior, update the shortest current-state document first:

- Change an invariant or rationale: update or add an ADR.
- Change current module ownership or read order: update `docs/agent-reading-guide.md`.
- Change implemented milestone scope: update this file and the relevant milestone doc.
- Change operational commands: update `README.md` and `docs/runbook.md`.
