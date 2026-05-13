# Architecture Decision Records

ADRs explain why stable project constraints exist. Read them before changing an invariant.

| ADR | Status | Decision |
| --- | --- | --- |
| `0001-use-node-bff-and-semantic-api.md` | Accepted | Browser traffic goes through a Node BFF with semantic routes, not a raw app-server proxy. |
| `0002-keep-server-source-of-truth-and-sqlite-metadata-only.md` | Accepted | Server state is authoritative for devices; SQLite stores metadata only. |
| `0003-use-single-active-connection-lease.md` | Accepted | Only one browser connection can hold privileged access at a time. |
| `0004-server-owned-approval-state.md` | Accepted | Pending approval state is server-owned, lease-bound, and normalized before it reaches the browser. |

Use this format for new decisions:

```markdown
# ADR N: Title

## Status

Accepted | Proposed | Superseded

## Context

The constraints and problem that forced the decision.

## Decision

The chosen rule.

## Alternatives Considered

Other plausible options and why they were not chosen.

## Consequences

What this enables, forbids, or defers.
```
