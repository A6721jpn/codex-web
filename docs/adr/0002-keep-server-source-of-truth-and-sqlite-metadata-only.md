# ADR 0002: Keep Server Source Of Truth And SQLite Metadata-Only

## Status

Accepted.

## Context

The same user may connect from a phone, iPad, or Mac, but the Windows host runs the actual Codex environment. Devices can disconnect, sleep, reload, or be replaced during a session. Conversation content, command output, diffs, and reasoning may contain sensitive data.

The Codex app-server already owns the thread, turn, item, approval, and resume model. codex-web needs local state for browser UX and auditing, but duplicating app-server conversation bodies would increase privacy and synchronization risk.

## Decision

The server is authoritative for browser-visible state. Devices do not own project, thread, workspace, approval, or active-connection state.

SQLite stores only local metadata and redacted audit information. It must not store user prompts, assistant messages, reasoning, command output, full diffs, turn item bodies, streaming deltas, or raw app-server request/response/notification payloads.

The thread index stores ids, source kind, title/status/timestamps, workspace references, and UI metadata only.

## Alternatives Considered

- Let each browser cache project and thread state: rejected because state would diverge across devices and stale approvals could be acted on.
- Mirror full app-server histories into SQLite: rejected because it duplicates sensitive bodies and creates a second source of truth.
- Store HMAC digests for all sensitive bodies by default: deferred because even correlations over sensitive payloads need an explicit retention and key-rotation design.

## Consequences

Conversation content is loaded lazily from app-server APIs when needed.

Auditing must use ids, categories, timestamps, lease metadata, and redacted summaries rather than raw payloads.

Debugging cannot rely on raw transcript dumps in SQLite. Any future raw capture needs a separate opt-in design with retention, redaction, and key handling.
