# Runbook

Use this for local development, verification, and Windows host checks.

## Requirements

- Windows 11 Pro host inside the VPN for target operation.
- Node.js `>=24.0.0`.
- A Codex CLI/app-server installation available through `CODEX_WEB_CODEX_BIN` or `codex` on `PATH`.

## First Run

```powershell
copy .env.example .env
# Set CODEX_WEB_SESSION_SECRET to at least 32 random characters.
npm install
npm run dev
```

## Verification

```powershell
npm test
npm run build
npm run preflight
```

M0 protocol checks:

```powershell
npm run m0:generate-protocol
npm run m0:probe -- --prompt "M0 smoke: reply with one short sentence."
npm run m0:check
```

## Runtime Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the codex-web server and React/Vite flow through Node. |
| `npm run start` | Same server entry point as dev. |
| `npm test` | Run Node test files under `test/**/*.test.ts`. |
| `npm run build` | Type-check and build the client with Vite. |
| `npm run preflight` | Check Codex binary, app-server help, and local shell behavior. |
| `npm run m0:check` | Run M0 test/protocol/probe sequence. |

## Windows Notes

M0 found that app-server `windowsSandbox/readiness` can report ready while the Codex Desktop command runner fails local shell launch with Error 1385. Treat these as separate signals.

If Error 1385 appears, inspect the operator-visible Codex sandbox artifacts under `%USERPROFILE%\.codex`, especially `sandbox.log` and `setup_error.json`. Do not automatically persist their raw contents into SQLite or reports.

App-server stderr/stdout can include large or sensitive remote-service bodies. Diagnostics must be capped and redacted before logging.

Windows child processes can outlive parents. Before expanding long-running app-server supervision or emergency-stop behavior, design process-tree containment explicitly.
