import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type CodexWebConfig = {
  appDataPath: string;
  codexBin: string;
  dbPath: string;
  host: string;
  logsPath: string;
  port: number;
  publicOrigin: string;
  sessionSecret: string;
};

export async function getConfig(env: NodeJS.ProcessEnv = process.env): Promise<CodexWebConfig> {
  const dbPath = resolve(env.CODEX_WEB_DB_PATH || "./data/codex-web.sqlite");
  const appDataPath = resolve(env.CODEX_WEB_APP_DATA_PATH || dirname(dbPath));
  const logsPath = resolve(env.CODEX_WEB_LOGS_PATH || "./logs");
  const port = Number.parseInt(env.CODEX_WEB_PORT || "8787", 10);
  const sessionSecret = env.CODEX_WEB_SESSION_SECRET || "";

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("CODEX_WEB_PORT must be a TCP port number");
  }
  if (sessionSecret.length < 32) {
    throw new Error("CODEX_WEB_SESSION_SECRET must be at least 32 characters");
  }

  await mkdir(dirname(dbPath), { recursive: true });
  await mkdir(appDataPath, { recursive: true });
  await mkdir(logsPath, { recursive: true });

  return {
    appDataPath,
    codexBin: env.CODEX_WEB_CODEX_BIN || "codex",
    dbPath,
    host: env.CODEX_WEB_HOST || "127.0.0.1",
    logsPath,
    port,
    publicOrigin: env.CODEX_WEB_PUBLIC_ORIGIN || "http://localhost:8787",
    sessionSecret,
  };
}
