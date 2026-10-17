import { afterEach, expect, it, vi } from "vitest";
import { decodeTraceJson } from "../src/otlp/codec.js";
import { prepareDiagnosticExport } from "../src/server/api-diagnostic-export.js";
import { checkDiagnosticSource, DIAGNOSTIC_SOURCE_LIMIT, DiagnosticExportTooLarge } from "../src/server/diagnostic-export-budget.js";
import { hex, makeRoots, until } from "./helpers.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });

for (const field of ["spanId", "parentSpanId", "traceId", "startTimeUnixNano", "endTimeUnixNano", "aggregate", "root multiplicity"] as const) {
  it(`counts accepted noncanonical ${field} scalar bytes before bulk reads`, async () => {
    const tb = await makeRoots({ noEngine: true }); cleanup.push(tb.close);
    await until(() => tb.roots.store.getMeta("search_index"));
    const normal = { traceId: hex(16), spanId: hex(8), name: "accepted scalars", startTimeUnixNano: "1000000", endTimeUnixNano: "2000000" };
    const count = field === "aggregate" ? 6 : 1;
    const wire = Array.from({ length: count }, (_, i) => ({ ...normal, spanId: Buffer.alloc(field === "aggregate" ? 200_000 : field === "root multiplicity" ? 600_000 : 8, i + 1).toString("base64"), ...(field !== "aggregate" && field !== "root multiplicity" ? { [field]: field.endsWith("Nano") ? "0".repeat(2_100_000) + "1000000" : Buffer.alloc(1_100_000, 1).toString("base64") } : {}) }));
    const decoded = decodeTraceJson({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: wire }] }] });
    expect(decoded[0].spans).toHaveLength(count);
    tb.roots.ingest(decoded);
    const traceId = decoded[0].spans[0].traceId;
    const stored = tb.roots.store.db.prepare("SELECT span_id,parent_span_id,start_ns,end_ns FROM spans WHERE trace_id=?").get(traceId);
    expect(stored).toEqual({ span_id: decoded[0].spans[0].spanId, parent_span_id: decoded[0].spans[0].parentSpanId || null, start_ns: decoded[0].spans[0].startTimeUnixNano, end_ns: decoded[0].spans[0].endTimeUnixNano }); // actual accepted bytes, not a direct SQL oversized fixture
    const bulk: string[] = [];
    const prepare = tb.roots.store.db.prepare.bind(tb.roots.store.db);
    vi.spyOn(tb.roots.store.db, "prepare").mockImplementation((sql: string) => { const st = prepare(sql); const all = st.all.bind(st); vi.spyOn(st, "all").mockImplementation((...args: unknown[]) => { bulk.push(sql); return all(...args); }); return st; });
    const hydrate = vi.spyOn(tb.roots.store, "batchesForTraces"); const blobs = vi.spyOn(tb.roots.store.blobs, "get");
    expect(() => checkDiagnosticSource(tb.roots, traceId)).toThrow(DiagnosticExportTooLarge);
    expect(() => prepareDiagnosticExport(tb.roots, traceId)).toThrow(DiagnosticExportTooLarge);
    expect(bulk).toEqual([]); expect(hydrate).not.toHaveBeenCalled(); expect(blobs).not.toHaveBeenCalled();
    expect(tb.roots.store.db.prepare("SELECT span_id,parent_span_id,start_ns,end_ns FROM spans WHERE trace_id=?").get(traceId)).toEqual(stored);
  });
}
