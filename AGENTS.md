# AGENTS.md

## Goal

Build a self-hosted Codex remote client that runs on a Windows 11 Pro host inside a VPN and recreates the core Codex app experience in a web browser for one user across phone, iPad, and Mac.

The first version should be a chat-centered daily-use client:

- Single-user login with local password authentication.
- Exactly one active remote browser connection at a time.
- Server-side project and conversation history shared across all devices.
- Arbitrary workspace paths on the host.
- Codex app-server integration through a TypeScript/Node BFF.
- Official-app-like approval flows for default permissions, auto review, and custom permissions.

## Development Rules

- Keep the server as the source of truth. Devices should not own project, thread, or approval state.
- Prefer a BFF architecture: browser UI talks to the web server; the web server talks to `codex app-server`.
- Use the Codex app-server thread, turn, item, approval, and resume APIs as the primary model. Store only client-specific metadata locally.
- Start with the chat-centered UI. Add side panels, IDE-like views, and richer file tools only after the main loop is reliable.
- Use sub-agents aggressively for isolated research, code exploration, review, and implementation slices to keep the main context clean.
- At key design and implementation checkpoints, use Chrome with ChatGPT Pro to review the direction and check for missing considerations.
- Keep changes scoped. Avoid broad refactors unless they directly support the current milestone.
- Verify behavior before calling work complete.
