import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

export type StaticAsset = {
  body: Buffer | string;
  headers: Record<string, string>;
  status: number;
};

export function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

export async function readStaticAsset(urlPath: string, input: { root: string }): Promise<StaticAsset> {
  const root = resolve(input.root);
  const clientRoot = resolve(root, "dist/client");
  const fallbackClientRoot = resolve(root, "src/client");
  const cleanPath = new URL(`http://local${urlPath}`).pathname;
  const relative = cleanPath === "/" ? "index.html" : cleanPath.slice(1);
  const headers = {
    ...securityHeaders(),
    "cache-control": isHashedAsset(relative) ? "public, max-age=31536000, immutable" : "no-cache",
    "content-type": contentType(relative),
  };
  for (const base of [clientRoot, fallbackClientRoot]) {
    const candidate = resolve(join(base, relative));
    if (!candidate.startsWith(base)) {
      continue;
    }
    try {
      return {
        body: await readFile(candidate),
        headers,
        status: 200,
      };
    } catch {
      // Try the next static root.
    }
  }
  return { body: "Not found", headers: { ...headers, "content-type": "text/plain; charset=utf-8" }, status: 404 };
}

function isHashedAsset(relative: string): boolean {
  return /^assets\/.+[-.][A-Za-z0-9_-]{8,}\.(?:js|css|png|jpg|jpeg|webp|svg)$/.test(relative);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
