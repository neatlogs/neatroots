import { createHash } from "node:crypto";
import type { Check } from "./types.js";

/** Parsed definitions, sorted by UTF-16 code units; compatible with offline check manifests. */
export function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, entry]) => [k, canonical(entry)]));
    return v;
  };
  return JSON.stringify(canonical(value));
}

export const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");

export function checkRevision(check: Check): { id: string; check_id: string; definition: Check; canonical: string } {
  const canonical = canonicalJson({ ...check, enabled: check.enabled ?? true });
  return { id: fingerprint(canonical), check_id: check.id, definition: JSON.parse(canonical), canonical };
}
