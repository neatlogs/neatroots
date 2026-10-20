import type { Store } from "../store/db.js";
import { buildView } from "../semantics/view.js";
import { kvToPlain, type KeyValue, type OtlpSpan } from "../otlp/types.js";

/** Resolve the store's fallback name without reading or hydrating any non-project values. */
export function namedUnknownProjects(store: Store): string[] {
  const rows = store.db.prepare(`SELECT s.trace_id,
    (SELECT json_group_array(json(a.value)) FROM json_each(
      CASE WHEN json_valid(s.attributes) THEN s.attributes ELSE '[]' END) a
      WHERE json_extract(a.value, '$.key') IN ('neatlogs.workflow_name', 'neatlogs.workflow.name')) AS attrs,
    (SELECT json_group_array(json(a.value)) FROM json_each(
      CASE WHEN json_valid(res.json) THEN res.json ELSE '{}' END, '$.attributes') a
      WHERE json_extract(a.value, '$.key') IN ('service.name', 'neatlogs.workflow_name', 'neatlogs.workflow.name')) AS resource
    FROM spans s JOIN resources res ON res.id = s.resource_id JOIN runs r ON r.trace_id = s.trace_id
    WHERE r.project = 'unknown' AND r.doctor = 0 ORDER BY s.seq`).all() as { trace_id: string; attrs: string; resource: string }[];
  const named = new Set<string>();
  for (const row of rows) {
    const resource = JSON.parse(row.resource) as KeyValue[];
    const span: OtlpSpan = { traceId: row.trace_id, spanId: "", parentSpanId: "", name: "", kind: 0,
      startTimeUnixNano: "0", endTimeUnixNano: "0", attributes: JSON.parse(row.attrs), events: [], links: [], status: { code: 0 } };
    // kvToPlain preserves duplicate-key last-value behavior; buildView supplies the same
    // workflow null/empty/type semantics used by both ingestion and the existing hold.
    if (kvToPlain(resource)["service.name"] != null || buildView(span, resource).workflow) named.add(row.trace_id);
  }
  return [...named];
}
