# Decision Backlog

These topics are not accepted ADRs yet. Treat them as known design gaps, not implementation permission.

| Topic | Why it matters | Current status |
| --- | --- | --- |
| HTTPS/WSS termination | The project runs inside a VPN, but browser security and cookie posture depend on where TLS terminates. | Undecided. |
| Process-tree containment | Windows child processes can outlive parents; app-server supervision and emergency stop need cleanup guarantees. | Deferred; prefer Job Objects or tree-kill fallback after design. |
| Startup schema compatibility gate | App-server protocol is version-sensitive. Runtime schema drift can break approval/thread semantics. | Deferred; M0 generated snapshots exist. |
| Permission profile discovery and custom editor | Built-in profile ids and granular permission editing need safe mapping before UI exposure. | Custom editor deferred beyond MVP. |
| Pending approval reconnect restoration | M4 pending approvals are memory-only and lease-bound; reconnect semantics need explicit ownership rules. | Deferred. |
| Symlink/junction target enforcement | Windows reparse points can escape intended workspace boundaries. | Deferred pending Windows-specific design. |
| Session-scoped approval grants | Session scope can be broader than a turn and must show exact permission impact. | MVP keeps it limited; richer behavior needs a new ADR. |
