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

See [AGENTS.md](AGENTS.md) for project goals and development rules.
