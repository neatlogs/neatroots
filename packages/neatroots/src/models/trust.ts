import { createHash } from "node:crypto";
import type { DecisionQuestion } from "./decision.js";

export interface TrustStats { n: number; agree: number }
export interface StoredTrustRecord { activeSig?: string; defs: Record<string, TrustStats> }

/** Identity of the exact effective definition sent to the model, independent of option key order. */
export function questionSignature(q: DecisionQuestion): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    type: q.type,
    ask: q.ask,
    options: q.type === "choice" ? Object.fromEntries(Object.entries(q.options ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : undefined,
    levels: q.type === "score" ? q.levels ?? [] : undefined,
  })).digest("hex");
}

/** Name-only reads describe the last evaluated definition; only explicit definitions earn trust. */
export interface TrustStore {
  get(question: string | DecisionQuestion): TrustStats;
  record(question: string | DecisionQuestion, agreed: boolean): void;
  activate?(question: DecisionQuestion): void;
  all(): Record<string, TrustStats>;
}

function validStats(raw: unknown): raw is TrustStats {
  if (!raw || typeof raw !== "object") return false;
  const { n, agree } = raw as TrustStats;
  return Number.isSafeInteger(n) && Number.isSafeInteger(agree) && n >= 0 && agree >= 0 && agree <= n;
}

/** Loads only versioned definition records; legacy names and older normalized signatures stay untrusted. */
export function createTrustStore(initial?: Record<string, unknown>, onWrite?: (data: Record<string, StoredTrustRecord>) => void): TrustStore {
  const data: Record<string, StoredTrustRecord> = Object.create(null);
  for (const [name, raw] of Object.entries(initial ?? {})) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (!r.defs || typeof r.defs !== "object" || Array.isArray(r.defs)) continue;
    const defs: Record<string, TrustStats> = Object.create(null);
    for (const [sig, stats] of Object.entries(r.defs)) {
      if (/^[0-9a-f]{64}$/.test(sig) && validStats(stats)) defs[sig] = { n: stats.n, agree: stats.agree };
    }
    data[name] = { defs, activeSig: typeof r.activeSig === "string" && /^[0-9a-f]{64}$/.test(r.activeSig) ? r.activeSig : undefined };
  }
  const get = (q: string | DecisionQuestion): TrustStats => {
    const row = data[typeof q === "string" ? q : q.name];
    const sig = typeof q === "string" ? row?.activeSig : questionSignature(q);
    return { ...(sig ? row?.defs[sig] : undefined) ?? { n: 0, agree: 0 } };
  };
  return {
    get,
    record: (q, agreed) => {
      // Without a definition there is no evidence of which question was compared.
      if (typeof q === "string") return;
      const sig = questionSignature(q);
      const row = data[q.name] ?? (data[q.name] = { defs: Object.create(null), activeSig: sig });
      const prev = row.defs[sig] ?? { n: 0, agree: 0 };
      if (prev.n === Number.MAX_SAFE_INTEGER) return;
      row.defs[sig] = { n: prev.n + 1, agree: prev.agree + (agreed ? 1 : 0) };
      onWrite?.(data);
    },
    activate: q => {
      if (!q.name || q.name === "_") return;
      const sig = questionSignature(q);
      const row = data[q.name] ?? (data[q.name] = { defs: Object.create(null) });
      if (row.activeSig === sig) return;
      row.activeSig = sig;
      onWrite?.(data);
    },
    all: () => Object.fromEntries(Object.keys(data).map(name => [name, get(name)])),
  };
}

/** Isolated agreement counters for tests and decision models without a persistent Store. */
export function memoryTrust(): TrustStore { return createTrustStore(); }
