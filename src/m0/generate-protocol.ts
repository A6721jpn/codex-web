import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { hashDirectory, hashJsonDirectory, redactForReport } from "./redaction.ts";

const root = resolve(import.meta.dirname, "../..");
const generatedRoot = resolve(root, "docs/m0/generated/app-server-protocol");
const tsOut = resolve(generatedRoot, "ts");
const schemaOut = resolve(generatedRoot, "json-schema");

async function main(): Promise<void> {
  await rm(tsOut, { force: true, recursive: true });
  await rm(schemaOut, { force: true, recursive: true });
  await mkdir(tsOut, { recursive: true });
  await mkdir(schemaOut, { recursive: true });

  const commands = [
    ["app-server", "generate-ts", "--experimental", "--out", tsOut],
    ["app-server", "generate-json-schema", "--experimental", "--out", schemaOut],
  ];
  const results = [];

  for (const args of commands) {
    results.push(await runCodex(args));
  }

  const schemaHash = await hashJsonDirectory(schemaOut);
  const tsHash = await hashDirectory(tsOut);
  const manifest = {
    generatedAt: new Date().toISOString(),
    codexBin: process.env.CODEX_WEB_CODEX_BIN || "codex",
    commands: results.map((result) => redactForReport(result)),
    schemaHash,
    tsHash,
  };

  await writeFile(resolve(generatedRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

function runCodex(args: string[]): Promise<{ args: string[]; exitCode: number | null; stderrTail: string; stdoutTail: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.CODEX_WEB_CODEX_BIN || "codex", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = tail(stdout + chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(stderr + chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const result = { args, exitCode, stderrTail: stderr, stdoutTail: stdout };
      if (exitCode === 0) {
        resolvePromise(result);
      } else {
        reject(new Error(`codex ${args.join(" ")} failed: ${JSON.stringify(result)}`));
      }
    });
  });
}

function tail(value: string): string {
  return value.length > 16_384 ? value.slice(-16_384) : value;
}

await main();
