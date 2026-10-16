/**
 * Who may write runs through the /v1 collector routes.
 *
 * SDKs, OpenTelemetry exporters and curl send no Origin header and are always let in. A browser
 * always sends one, so a request with an Origin comes from a web page: pages served from this
 * machine (localhost, 127.0.0.1, [::1], any port) are let in, and any other site only when the
 * person lists its origin in ingest.allowedOrigins ("*" lets every site in, as before).
 * Without this, any website open in the browser can plant runs that coding agents then read
 * over MCP.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A browser origin in its canonical form (scheme://host[:port], lowercase), or undefined. */
export function normalizeOrigin(origin: string): string | undefined {
  const o = origin.trim().toLowerCase();
  if (o === "null") return "null";
  try {
    const u = new URL(o);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  const o = normalizeOrigin(origin);
  if (!o || o === "null") return false;
  const host = new URL(o).hostname;
  // *.localhost is reserved for loopback (RFC 6761) and browsers resolve it to this machine.
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

/** Whether a /v1 request with this Origin header may write runs. */
export function ingestOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (origin === undefined) return true;
  if (allowedOrigins.includes("*")) return true;
  if (isLoopbackOrigin(origin)) return true;
  const o = normalizeOrigin(origin);
  if (!o) return false;
  return allowedOrigins.some((a) => normalizeOrigin(a) === o);
}

/** The access-control-allow-origin value for an allowed /v1 request. */
export function ingestAllowOriginHeader(origin: string | undefined, allowedOrigins: readonly string[]): string {
  if (origin === undefined || allowedOrigins.includes("*")) return "*";
  return normalizeOrigin(origin) ?? "*";
}
