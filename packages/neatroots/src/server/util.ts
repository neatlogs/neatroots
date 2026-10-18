import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export function err(c: Context, status: number, message: string) {
  return c.json({ error: message }, status as 400);
}

/** Parse a query param as an integer and clamp it to [min, max]; non-numbers fall back to `dflt`. */
export function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * A request's JSON body as an object. No body reads as {}; anything else that isn't a JSON object
 * (malformed JSON, null, an array, a number) is a 400, so a route never reads fields off null.
 */
export async function body<T = Record<string, unknown>>(c: Context): Promise<T> {
  const text = await c.req.text().catch(() => "");
  if (!text.trim()) return {} as T;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HTTPException(400, { message: "the request body is not valid JSON" });
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HTTPException(400, { message: "the request body must be a JSON object" });
  return v as T;
}

/** True for a non-empty array of non-empty strings, the only trace_ids shape a route should accept. */
export function isTraceIds(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0);
}
