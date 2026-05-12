import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { createCodexWebApp } from "./app.ts";

const app = await createCodexWebApp();
const root = resolve(import.meta.dirname, "../..");
const clientRoot = resolve(root, "dist/client");
const fallbackClientRoot = resolve(root, "src/client");

const server = createServer(async (req, res) => {
  const host = req.headers.host ?? `${app.config.host}:${app.config.port}`;
  const request = new Request(`${app.config.publicOrigin}${req.url ?? "/"}`, {
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    duplex: "half",
    headers: req.headers as HeadersInit,
    method: req.method,
  } as RequestInit);

  if (new URL(request.url).pathname.startsWith("/api/")) {
    const response = await app.fetch(request);
    writeResponse(res, response);
    return;
  }

  const file = await readStatic(req.url ?? "/");
  res.writeHead(file.status, file.headers);
  res.end(file.body);
});

server.on("upgrade", (req, socket) => {
  const request = new Request(`${app.config.publicOrigin}${req.url ?? "/"}`, {
    headers: req.headers as HeadersInit,
    method: "GET",
  });
  void app.handleUpgrade(request, socket);
});

server.listen(app.config.port, app.config.host, () => {
  console.log(`codex-web listening on http://${app.config.host}:${app.config.port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown(): Promise<void> {
  server.close();
  await app.close();
}

async function writeResponse(res: import("node:http").ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function readStatic(urlPath: string): Promise<{ body: Buffer | string; headers: Record<string, string>; status: number }> {
  const cleanPath = new URL(`http://local${urlPath}`).pathname;
  const relative = cleanPath === "/" ? "index.html" : cleanPath.slice(1);
  const candidates = [join(clientRoot, relative), join(fallbackClientRoot, relative)];
  for (const candidate of candidates) {
    try {
      return {
        body: await readFile(candidate),
        headers: {
          "cache-control": "no-cache",
          "content-type": contentType(candidate),
        },
        status: 200,
      };
    } catch {
      // Try the next candidate.
    }
  }
  return { body: "Not found", headers: { "content-type": "text/plain; charset=utf-8" }, status: 404 };
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
