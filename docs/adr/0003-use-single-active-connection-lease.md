# ADR 0003: Use A Single Active Connection Lease

## Status

Accepted.

## Context

The first version is single-user, but the same user may open the client from multiple devices. Codex operations can start turns, answer approvals, change permissions, and affect the local host. Concurrent browser owners would create race conditions and confusing approval ownership.

Authentication alone does not solve this. A logged-in but backgrounded browser can still have stale UI state, old pending actions, or delayed WebSocket messages.

## Decision

Exactly one browser connection may hold the active lease. Privileged reads and writes require that lease.

The active lease includes connection id, epoch, fencing token, device session, and heartbeat data. Takeover requires explicit password re-entry, increments the epoch, and revokes the old connection. Stale epoch messages and stale lease headers are rejected.

Read APIs are lease-gated too. A logged-in browser without the lease may see only busy/takeover state.

## Alternatives Considered

- Allow multiple active browser sessions: rejected for MVP because approval and turn ownership would become ambiguous.
- Gate only writes: rejected because reads can expose sensitive workspace and conversation metadata to a stale or non-active device.
- Rely only on WebSocket connection state: rejected because HTTP requests and delayed messages also need fencing.

## Consequences

Every privileged route must check active lease headers in addition to authentication and CSRF where relevant.

Tests should cover stale epochs, stale HTTP lease headers, takeover races, and duplicate approval/turn actions from an old connection.

Same-device reload behavior needs grace handling so normal refreshes do not feel like cross-device takeover.
