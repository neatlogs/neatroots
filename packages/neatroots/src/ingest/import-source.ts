import type { Store } from "../store/db.js";

/** Only local import metadata is authoritative; sender-supplied fields remain lossless inert data. */
export function importedSource(store: Store, traceId: string): string | null {
  return store.getMeta(`import-source:${traceId}`) || null;
}

/** Historical rows without verifiable local origin must never auto-forward after upgrade. */
export function automaticForwardAllowed(store: Store, traceId: string): boolean {
  return !importedSource(store, traceId)
    && !store.db.prepare("SELECT 1 FROM import_provenance_unknown WHERE trace_id=?").get(traceId);
}
