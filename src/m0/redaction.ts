import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";

const REDACTED_KEYS = new Set([
  "content",
  "diff",
  "message",
  "output",
  "prompt",
  "reasoning",
  "text",
]);

export function redactForReport<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForReport(item)) as T;
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      redacted[key] = REDACTED_KEYS.has(key) ? "<redacted>" : redactForReport(nested);
    }
    return redacted as T;
  }
  return value;
}

export function redactString(value: string): string {
  const home = homedir();
  let redacted = value;
  if (home) {
    redacted = redacted.split(home).join("<USER_HOME>");
    redacted = redacted.split(home.replaceAll("\\", "\\\\")).join("<USER_HOME_ESCAPED>");
  }
  return redacted
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+/g, "<USER_HOME>")
    .replace(/[A-Z]:\\\\Users\\\\[^\\\r\n"]+/g, "<USER_HOME_ESCAPED>")
    .replace(/token=[^\s"'\\]+/gi, "token=<redacted>")
    .replace(/(prompt|message|reasoning|output|diff|body)\b[^}\r\n]*/gi, "$1=<redacted>");
}

export async function hashDirectory(input: string | Map<string, string | Buffer>): Promise<string> {
  const files = input instanceof Map ? input : await readDirectoryFiles(input);
  return hashFileMap(files);
}

export async function hashJsonDirectory(input: string | Map<string, string | Buffer>): Promise<string> {
  const files = input instanceof Map ? input : await readDirectoryFiles(input);
  const canonicalFiles = new Map<string, string | Buffer>();
  for (const [file, content] of files) {
    if (file.endsWith(".json")) {
      canonicalFiles.set(file, `${JSON.stringify(sortJson(JSON.parse(content.toString("utf8"))))}\n`);
    } else {
      canonicalFiles.set(file, content);
    }
  }
  return hashFileMap(canonicalFiles);
}

function hashFileMap(files: Map<string, string | Buffer>): string {
  const hash = createHash("sha256");

  for (const [file, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

async function readDirectoryFiles(root: string): Promise<Map<string, Buffer>> {
  const output = new Map<string, Buffer>();

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        if (fileStat.size > 0) {
          output.set(relative(root, fullPath).split(sep).join("/"), await readFile(fullPath));
        }
      }
    }
  }

  await walk(root);
  return output;
}
