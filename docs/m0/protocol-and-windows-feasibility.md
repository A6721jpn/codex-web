# M0 Protocol And Windows Feasibility

Date: 2026-05-11

## Scope

This is only the M0 spike. It verifies whether Node/TypeScript can start and speak to the real `codex app-server --listen stdio://` on this Windows host. It does not implement React UI, authentication, SQLite, the BFF server, approval UI, history sync, or responsive UI.

The M0 harness is intentionally not a browser-accessible JSON-RPC proxy. It is a local script that sends an allow-listed set of probe calls.

## How To Run

```powershell
npm test
npm run m0:generate-protocol
npm run m0:probe -- --prompt "M0 smoke: reply with one short sentence."
```

The combined local check is:

```powershell
npm run m0:check
```

Outputs:

- `docs/m0/generated/app-server-protocol/` contains generated TypeScript and JSON Schema snapshots from the installed Codex app-server.
- `docs/m0/generated/app-server-protocol/manifest.json` records generation commands and hashes.
- `docs/m0/probe-result.redacted.json` records the latest redacted probe summary.

## Runtime Identifiers

| Item | Value |
| --- | --- |
| Codex CLI version | `codex-cli 0.130.0-alpha.5` |
| Primary Codex binary | `%USERPROFILE%\AppData\Local\OpenAI\Codex\bin\codex.exe` |
| WindowsApps Codex paths | `C:\Program Files\WindowsApps\OpenAI.Codex_26.506.3741.0_x64__2p2nqsd0c76g0\app\resources\codex`, `...\codex.exe` |
| Generated JSON Schema hash | `6277f291a7b47ae5a981ca8d29a25daa6e92db94bc6cf6e94429a132471b0801` |
| Generated TypeScript hash | `46f64ff8cbbf3f33ff8fd397aa835a9f7c9a8b54a824f6d8b9253e68033f4705` |

Hash policy for M1: generate protocol snapshots from the pinned Codex CLI/app-server version during release preparation, canonicalize JSON object key order before hashing the generated JSON Schema directory, and compare that hash during BFF startup. Raw JSON Schema file bytes were not stable across repeated generation, but the canonical JSON Schema hash was stable across back-to-back runs. A mismatch should be a startup warning or fail-closed compatibility gate until the schema is reviewed.

## Command Support Matrix

| Command or method | M0 result | Notes |
| --- | --- | --- |
| `codex app-server --listen stdio://` | Supported | Help lists `stdio://` as supported and default. Node child process launched successfully. |
| JSON-RPC over stdio | Supported | Newline-delimited JSON messages worked. The harness omits the wire `jsonrpc` field by default. |
| `initialize` | Supported | Handshake completed with `clientInfo.name = "codex_web_m0"` and `capabilities.experimentalApi = true`. |
| `model/list` | Supported | Returned a paged model list. |
| `thread/list` | Supported | Returned paged thread data using explicit `sourceKinds: ["appServer", "cli", "vscode"]`. |
| `windowsSandbox/readiness` | Supported | Returned `status: "ready"` through app-server. |
| `thread/start` | Supported | Started a thread with `approvalPolicy: "on-request"`, `approvalsReviewer: "user"`, `sandbox: "workspace-write"`. |
| `turn/start` | Supported | Started a turn and returned an in-progress turn id. |
| Streaming notifications | Supported | Observed `thread/status/changed`, `turn/started`, and `turn/completed` notifications. The M0 summary does not persist body text, reasoning, output, or diffs. |
| `turn/interrupt` | Supported | Interrupt request succeeded during an active turn. |
| `thread/resume` | Supported | Resumed the just-created thread after the turn lifecycle. |
| `codex app-server generate-ts --experimental --out <dir>` | Supported | Generated TypeScript bindings. |
| `codex app-server generate-json-schema --experimental --out <dir>` | Supported | Generated JSON Schema bundle. |
| `codex app-server proxy` | Present, not used | Out of scope for the BFF design. |
| app-server WebSocket transport | Present in help, not used | M0 and MVP use stdio only. |

## Protocol Findings

Generated schema confirms the protocol support needed for MVP design:

- `approvalPolicy` accepts `"untrusted"`, `"on-failure"`, `"on-request"`, `"never"`, and a granular object with `sandbox_approval`, `rules`, `skill_approval`, `request_permissions`, and `mcp_elicitations`.
- `approvalsReviewer` accepts `"user"`, `"auto_review"`, and legacy-compatible `"guardian_subagent"`.
- Named permissions are represented as `{ "type": "profile", id: string, modifications?: [...] }`. Generated comments mention built-in profile ids such as `:workspace`, but M0 did not enumerate all configured profile ids.
- `thread/start`, `thread/resume`, and `turn/start` expose permission/profile and approval fields. `turn/start` uses `sandboxPolicy`; `thread/start` and `thread/resume` use legacy `sandbox` mode plus permission-profile support.
- `SandboxPolicy` supports `readOnly`, `workspaceWrite`, `externalSandbox`, and `dangerFullAccess`. The MVP should not expose `dangerFullAccess`.

## Windows Findings

- Normal sandboxed shell execution in this Codex Desktop session currently fails before PowerShell launches with:
  `windows sandbox: CreateProcessWithLogonW failed: 1385`
- Elevated PowerShell commands run successfully. All M0 filesystem, test, generation, and app-server commands were run with explicit escalation because the default sandbox could not start commands.
- App-server `windowsSandbox/readiness` returned `ready`, so app-server readiness and this session's command-runner sandbox behavior are not equivalent signals. M1 preflight should report both the app-server readiness result and an actual local command execution probe.
- Effective Codex home appears to be `%USERPROFILE%\.codex`; `CODEX_HOME` was unset in the observed command environment.
- Visible sandbox artifacts include `%USERPROFILE%\.codex\.sandbox`, `.sandbox-bin`, `.sandbox-secrets`, `sandbox.log`, and `setup_error.json`.
- `setup_error.json` contained `{"code":"helper_unknown_error","message":"read ACL run had errors"}` during M0.
- `CODEX_SANDBOX_NETWORK_DISABLED=1` was present in the command environment. The probe used a turn-level `workspaceWrite` sandbox policy with `networkAccess: false`.
- App-server startup attempted remote plugin sync and received `403 Forbidden`; the report stores only redacted summaries. M1 logs must cap stderr/stdout and redact HTML bodies and secrets.
- A process lifecycle probe confirmed a child PowerShell process can survive parent PowerShell exit on Windows. M1 must implement explicit process-tree containment and cleanup for app-server and any child processes, preferably Windows Job Objects with a tree-kill fallback.
- The final app-server probe process id was no longer running after harness cleanup.

## Redaction And Persistence

M0 stores only summaries:

- No prompt body beyond the fixed smoke prompt in command invocation.
- No assistant message content.
- No reasoning text.
- No command output body.
- No diffs.
- User home paths are redacted in generated manifests and probe summaries.

M1 should keep this stance: SQLite stores metadata and audit rows, not conversation bodies, reasoning, raw output, or diffs.

## Go/No-Go

Go for M1 with constraints.

The stdio protocol path is feasible: Node can start the real app-server, initialize it, call the required thread/turn methods, receive lifecycle notifications, interrupt an active turn, resume a thread, and generate protocol snapshots.

The main risks to carry into M1 are Windows-specific:

- Default sandbox command execution can fail with Error 1385 even when app-server reports sandbox readiness.
- App-server stderr can include large remote-service error bodies unless aggressively capped and redacted.
- Windows child processes can outlive parents without explicit tree cleanup.
- Approval and permission support exists in protocol, but the exact configured permission profile ids still need startup-time discovery or a conservative built-in allow-list before exposing presets.
