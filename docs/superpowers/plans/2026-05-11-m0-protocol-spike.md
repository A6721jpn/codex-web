# M0 Protocol Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify only the M0 `codex app-server --listen stdio://` feasibility spike.

**Architecture:** A small Node/TypeScript harness starts the real Codex app-server over stdio, sends allow-listed JSON-RPC calls from a script, records redacted observations, and exits cleanly. It is not a browser API, not a BFF server, and not a raw JSON-RPC proxy.

**Tech Stack:** Node.js 24 native TypeScript execution, built-in `node:test`, child process stdio, generated Codex app-server protocol snapshots.

---

### Task 1: Harness Core

**Files:**
- Create: `src/m0/json-rpc.ts`
- Create: `src/m0/redaction.ts`
- Create: `test/m0/json-rpc.test.ts`
- Create: `test/m0/redaction.test.ts`

- [x] **Step 1: Write tests for line-delimited JSON-RPC parsing, request ids, schema hashing, and redaction.**
- [x] **Step 2: Run `npm test` and confirm it fails because implementation files are missing.**
- [x] **Step 3: Implement minimal harness utilities.**
- [x] **Step 4: Run `npm test` and confirm the tests pass.**

### Task 2: Real App-Server Probe

**Files:**
- Create: `src/m0/codex-app-server-probe.ts`
- Create: `src/m0/generate-protocol.ts`

- [x] **Step 1: Implement a stdio child-process client for `codex app-server --listen stdio://`.**
- [x] **Step 2: Send `initialize` with `clientInfo.name = "codex_web_m0"` and `experimentalApi = true`.**
- [x] **Step 3: Probe `model/list`, `thread/list`, `thread/start`, `turn/start`, streaming notifications, `turn/interrupt`, and `thread/resume` where the installed protocol supports them.**
- [x] **Step 4: Generate TypeScript and JSON Schema snapshots with `--experimental`, then compute a stable SHA-256 hash.**

### Task 3: Report And Verification

**Files:**
- Create: `docs/m0/protocol-and-windows-feasibility.md`
- Create: `docs/m0/generated/app-server-protocol/**`
- Modify: `README.md`

- [x] **Step 1: Record Codex binary path, version, schema hash, and command support matrix.**
- [x] **Step 2: Record Windows sandbox/process lifecycle findings, including Error 1385 and cleanup risks.**
- [x] **Step 3: Record redacted probe results and M1 go/no-go.**
- [x] **Step 4: Run `npm test`, protocol generation, and the M0 probe before reporting completion.**
