import type { Store } from "../store/db.js";

/** Only local import metadata is authoritative; sender-supplied fields remain lossless inert data. */
export function importedSource(store: Store, traceId: string): string | null {
  return store.getMeta(`import-source:${traceId}`) || null;
}
