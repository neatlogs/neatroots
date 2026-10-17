import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serve, type ServerType } from "@hono/node-server";
import type { Roots } from "../core.js";
import { BlobReadError } from "../store/blobs.js";
import { mountCollector } from "./collector.js";
import { mountApi } from "./api.js";
import { mountMcpHttp } from "../mcp/http.js";
import { log } from "../util/log.js";
import { VERSION } from "../version.js";
import { ingestAllowOriginHeader, ingestOriginAllowed } from "./ingest-guard.js";

export { VERSION };

export function findUiDir(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const candidate of [path.join(dir, "ui"), path.join(dir, "dist", "ui"), path.join(dir, "..", "ui", "dist")]) {
      if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * neatroots listens on loopback only. The Host check blocks DNS-rebinding pages, and the
 * Origin check stops other websites from calling the app API from a browser. The OTLP
 * routes take browser traces from pages on this machine, and from other sites only when
 * they are listed in ingest.allowedOrigins, so a website can't plant runs that coding
 * agents read over MCP.
 */
function securityMiddleware(roots: Roots) {
  return async (c: import("hono").Context, next: () => Promise<void>) => {
    const port = roots.config.port;
    const host = (c.req.header("host") ?? "").toLowerCase();
    const hostOk = ["localhost", "127.0.0.1", "[::1]"].some((h) => host === h || host === `${h}:${port}`);
    if (!hostOk) return c.json({ error: "neatroots only answers on localhost" }, 403);
    const origin = c.req.header("origin");
    const isOtlp = c.req.path.startsWith("/v1/");
    if (isOtlp) {
      const { allowedOrigins } = roots.config.ingest;
      if (!ingestOriginAllowed(origin, allowedOrigins)) {
        return c.json({ error: `traces from ${origin} are not accepted; add this origin to ingest.allowedOrigins in config.yaml to send from that page` }, 403);
      }
      const allowOrigin = ingestAllowOriginHeader(origin, allowedOrigins);
      if (c.req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": allowOrigin,
            vary: "origin",
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type, content-encoding, authorization, x-api-key, x-neatlogs-doctor",
            "access-control-max-age": "86400",
          },
        });
      }
      await next();
      c.res.headers.set("access-control-allow-origin", allowOrigin);
      c.res.headers.append("vary", "origin");
      return;
    }
    if (origin) {
      const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
      if (process.env.NEATROOTS_DEV_ORIGIN) allowed.add(process.env.NEATROOTS_DEV_ORIGIN);
      if (!allowed.has(origin.toLowerCase())) return c.json({ error: "cross-origin requests are not allowed" }, 403);
    }
    await next();
  };
}

export function createApp(roots: Roots): Hono {
  const app = new Hono();
  app.use("*", securityMiddleware(roots));
  // Errors answer as JSON like every other API error: a bad request with its message, anything
  // unexpected as a 500 (logged, never with a stack in the response).
  app.onError((e, c) => {
    if (e instanceof HTTPException) return c.json({ error: e.message }, e.status);
    if (e instanceof BlobReadError) {
      log.error(`${c.req.method} ${c.req.path} failed: ${e.message}`);
      return c.json({ error: "stored_payload_unavailable", reason: e.kind, sha: e.sha, message: e.message }, 500);
    }
    log.error(`${c.req.method} ${c.req.path} failed: ${e.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, name: "neatroots", version: VERSION, uptime_ms: Date.now() - roots.startedMs }));

  mountCollector(app, roots);
  mountApi(app, roots);
  mountMcpHttp(app, roots);

  const uiDir = findUiDir();
  app.get("*", (c) => {
    // Unmatched API/collector routes must not fall through to the SPA: a script,
    // SDK or coding agent calling the API should get a 404 JSON error, not HTML 200.
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/v1/")) {
      return c.json({ error: "not found" }, 404);
    }
    if (!uiDir) {
      return c.html(
        `<!doctype html><title>neatroots</title><body style="font-family:system-ui;padding:2rem"><h1>neatroots is running</h1><p>The app UI is not built. Run <code>pnpm build</code> in the neatroots repo.</p><p>Collector: <code>POST /v1/traces</code></p></body>`,
      );
    }
    let rel = "";
    try {
      rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
    } catch {
      // A malformed percent-escape is an unknown path, not a server error: the fallback below serves the app shell.
    }
    let file = path.join(uiDir, rel);
    // Append path.sep before the prefix check so a sibling directory whose name starts
    // with the same string as uiDir (e.g. ui-x/) cannot be reached via path traversal.
    if (!file.startsWith(uiDir + path.sep) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(uiDir, "index.html");
    const ext = path.extname(file);
    const headers: Record<string, string> = { "content-type": MIME[ext] ?? "application/octet-stream" };
    if (rel.startsWith("assets/")) headers["cache-control"] = "public, max-age=31536000, immutable";
    return new Response(fs.readFileSync(file), { headers });
  });
  return app;
}

export function startServer(roots: Roots, app: Hono): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: roots.config.port, hostname: roots.config.host }, (info) => {
      log.info(`listening on http://localhost:${info.port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}
