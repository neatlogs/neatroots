import type { Store } from "../store/db.js";

/** File OTLP imports must keep their resource/span bytes; provenance lives beside the run. */
export function importedSource(store: Store, traceId: string): string | null {
  const source = store.getMeta(`import-source:${traceId}`);
  if (source) return source;
  const run = store.getRun(traceId);
  if (!run?.root_span_id) return null;
  const full = store.getOtlpSpan(traceId, run.root_span_id);
  const value = full?.resource.attributes.find((a) => a.key === "neatroots.import.source")?.value;
  return value && "stringValue" in value && value.stringValue !== "http" && value.stringValue !== "replay" ? value.stringValue : null;
}
