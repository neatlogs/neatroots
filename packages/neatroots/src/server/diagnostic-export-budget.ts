import type { RedactionLimits } from "../relay/redact.js";
import type { Roots } from "../core.js";

export const DIAGNOSTIC_SOURCE_LIMIT = 2 * 1024 * 1024;
export const DIAGNOSTIC_JSON_LIMIT = 4 * 1024 * 1024;
export class DiagnosticExportTooLarge extends Error {
  constructor() { super("Diagnostic export is too large. Limits include 2 MiB of source data, 4 MiB of JSON and bounded redaction work. Choose a smaller run."); }
}

export const DIAGNOSTIC_REDACTION_MATCH_LIMIT = 10_000;
export const DIAGNOSTIC_REDACTION_WORK_LIMIT = 64 * 1024 * 1024;

/** Shared across trace and metadata passes, including repeated redaction of trace strings.
 * Work counts every rule's output, not just final JSON. No per-match samples are retained. */
export class DiagnosticRedactionBudget implements RedactionLimits {
  readonly counts = new Map<string, number>();
  private matches = 0;
  private bytes = 0;
  private nodes = 0;
  node(depth: number): void {
    if (++this.nodes > 50_000 || depth > 64) throw new DiagnosticExportTooLarge();
  }
  output(fragment: string, stringLength: number): void {
    this.bytes += Buffer.byteLength(fragment, "utf8");
    if (stringLength > DIAGNOSTIC_JSON_LIMIT || this.bytes > DIAGNOSTIC_REDACTION_WORK_LIMIT) throw new DiagnosticExportTooLarge();
  }
  match(kind: string): void {
    if (++this.matches > DIAGNOSTIC_REDACTION_MATCH_LIMIT) throw new DiagnosticExportTooLarge();
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
  }
}

/** Counts JSON bytes without constructing its serialized representation. Undefined members
 * are conservatively counted too. A node/depth bound also limits object overhead.
 * Both the wire response and UI download use compact JSON, without a pretty-print expansion. */
export function jsonBudget(value: unknown, limit: number): number {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let bytes = 0;
  let nodes = 0;
  while (stack.length) {
    const { value: item, depth } = stack.pop()!;
    if (++nodes > 50_000 || depth > 64) throw new DiagnosticExportTooLarge();
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8") + 2;
      for (let i = 0; i < item.length; i++) {
        const c = item.charCodeAt(i);
        if (c === 34 || c === 92) bytes++;
        else if (c < 32) bytes += [8, 9, 10, 12, 13].includes(c) ? 1 : 5;
        else if (c >= 0xd800 && c <= 0xdfff) bytes += 3; // conservative for lone surrogates
      }
    } else if (item && typeof item === "object") {
      const entries = Array.isArray(item) ? item.map((v) => [undefined, v] as const) : Object.entries(item);
      if (entries.length + nodes + stack.length > 50_000) throw new DiagnosticExportTooLarge();
      bytes += 2 + entries.length; // braces/brackets and commas
      for (const [key, child] of entries) {
        if (key !== undefined) { bytes++; stack.push({ value: key, depth: depth + 1 }); }
        stack.push({ value: child, depth: depth + 1 });
      }
    } else bytes += 24; // upper bound for JSON numbers, booleans and null
    if (bytes > limit) throw new DiagnosticExportTooLarge();
  }
  return bytes;
}

/** Read scalar SQL byte totals first, never SELECT * / hydrate blob contents to size a run.
 * Account for every blob occurrence (including a shared blob used repeatedly in one span). */
export function checkDiagnosticSource(roots: Roots, traceId: string): number {
  const db = roots.store.db;
  let bytes = 0;
  const add = (n: number) => { bytes += n; if (bytes > DIAGNOSTIC_SOURCE_LIMIT) throw new DiagnosticExportTooLarge(); };
  const total = (sql: string, bindings = 1) => add((db.prepare(sql).get(...Array(bindings).fill(traceId)) as { bytes: number }).bytes);
  // Every column selected by later SELECT * contributes, including noncanonical IDs/raw
  // timestamps and derived/omitted columns. Schema enumeration avoids silently missing a scalar.
  const columns = (table: string) => [...db.prepare(`PRAGMA table_info(${table})`).iterate() as Iterable<{ name: string }>].map(({ name }) => `COALESCE(length(CAST("${name}" AS BLOB)),0)`).join(" + ");
  for (const table of ["spans", "runs", "findings", "decisions"]) total(`SELECT COALESCE(SUM(${table === "spans" ? 2048 : 512} + ${columns(table)}),0) bytes FROM ${table} WHERE trace_id=?`);
  total(`SELECT COALESCE(SUM(${columns("explanations")}+512),0) bytes FROM explanations WHERE trace_id=? OR id IN (SELECT explanation_id FROM findings WHERE trace_id=?)`, 2);
  total(`SELECT COALESCE(SUM(${columns("plans")}+512),0) bytes FROM plans WHERE id=(SELECT plan_id FROM runs WHERE trace_id=?)`);
  total(`SELECT COALESCE(SUM(length(CAST(r.json AS BLOB))+length(CAST(c.json AS BLOB))+1024),0) bytes
    FROM (SELECT DISTINCT resource_id,scope_id FROM spans WHERE trace_id=?) s JOIN resources r ON r.id=s.resource_id JOIN scopes c ON c.id=s.scope_id`);
  const sizes = new Map<string, number>();
  for (const field of ["attributes", "events"]) {
    const refs = db.prepare(`SELECT json_extract(j.value,'$.sha') sha, json_extract(j.value,'$.len') len
      FROM spans s,json_tree(s.${field}) j WHERE s.trace_id=? AND j.key='blobRef'`);
    for (const ref of refs.iterate(traceId) as Iterable<{ sha: string; len: number }>) {
      let size = sizes.get(ref.sha);
      if (size === undefined) { size = roots.store.blobs.sizeOf(ref.sha); sizes.set(ref.sha, size); }
      add(Math.max(size, ref.len));
    }
  }
  // Check cached current definitions before callers bulk-read findings/decisions/plans.
  // Stream only identity/enabled columns; never materialize all check bodies to size them.
  const run = db.prepare("SELECT project,workflow FROM runs WHERE trace_id=?").get(traceId) as { project: string | null; workflow: string | null } | undefined;
  if (!run) return bytes;
  const ids = new Set<string>();
  const refs = db.prepare(`SELECT check_id id FROM findings WHERE trace_id=? UNION SELECT check_id id FROM decisions WHERE trace_id=?
    UNION SELECT j.value id FROM plans p,json_each(p.check_ids) j WHERE p.id=(SELECT plan_id FROM runs WHERE trace_id=?)
    UNION SELECT j.key id FROM plans p,json_each(p.body,'$.params') j WHERE p.id=(SELECT plan_id FROM runs WHERE trace_id=?)`);
  for (const row of refs.iterate(traceId, traceId, traceId, traceId) as Iterable<{ id: string }>) ids.add(row.id);
  const matches = (value: string | string[] | undefined, actual: string | null) => value === undefined || (Array.isArray(value) ? value : [value]).includes(actual ?? "");
  for (const row of db.prepare("SELECT id FROM checks WHERE kind='rule' AND enabled=1").iterate() as Iterable<{ id: string }>) {
    const check = roots.checks.get(row.id)?.check;
    if (check?.kind === "rule" && check.enabled !== false && matches(check.applies_to?.project, run.project) && matches(check.applies_to?.workflow, run.workflow)) ids.add(row.id);
  }
  for (const id of ids) {
    const check = roots.checks.get(id)?.check;
    if (check) add(jsonBudget(check, DIAGNOSTIC_SOURCE_LIMIT));
  }
  return bytes;
}
