import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { Store } from "../src/store/db.js";
import { decodeLogsJson } from "../src/otlp/codec.js";
import { plainToAny } from "../src/otlp/types.js";
import { batch, hex, makeRoots, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });

it("reconciles GenAI content while rebuilding legacy search IDs across both chunk sizes", async () => {
  t = await makeRoots({ noEngine: true });
  await until(() => t!.roots.store.getMeta("search_index"));
  const traceId = hex(16);
  const root = span({ traceId, name: "chat", kind: "llm" });
  const spans = [root, ...Array.from({ length: 1100 }, () => span({ traceId, parent: root.spanId, name: "chat", kind: "llm" }))].map((sp) => ({ ...sp, events: [{ name: "gen_ai.choice", timeUnixNano: "100", attributes: [{ key: "message", value: plainToAny({ content: "legacyderivedanswer" }) }] }] }));
  t.roots.ingest([batch(spans)]);
  // Both upgrades are outstanding: old previews/FTS and no search-row identity map.
  t.roots.store.db.exec("UPDATE spans SET output_preview = NULL; UPDATE runs SET output_preview = NULL; UPDATE span_fts SET body = 'oldplaceholder'; DROP TABLE span_fts_ids");
  t.roots.store.setMeta("search_index", "4");
  const home = t.roots.home, config = t.roots.config; t.roots.close();
  const startupIds = vi.spyOn(Store.prototype, "rebuildSearchIds");
  const reopened = new Roots({ home, config, noEngine: true });
  t = { ...t, roots: reopened, close: async () => { reopened.close(); fs.rmSync(home, { recursive: true, force: true }); } };
  expect(startupIds).toHaveBeenCalledTimes(1);
  const updates: string[] = []; reopened.bus.on("trace", (u) => updates.push(u.traceId));
  await until(() => reopened.store.getMeta("search_index") === "5");
  expect(await new Promise<boolean>((resolve) => reopened.store.rebuildSearchIds((_n, ready) => resolve(ready)))).toBe(true);
  const exactIds = () => expect(reopened.store.db.prepare("SELECT id, trace_id, span_id FROM span_fts_ids ORDER BY id").all()).toEqual(reopened.store.db.prepare("SELECT rowid AS id, trace_id, span_id FROM span_fts ORDER BY rowid").all());
  exactIds(); expect(updates).toContain(traceId);
  expect(reopened.store.searchSpans("legacyderivedanswer", 2000, [traceId])).toHaveLength(spans.length);
  expect(reopened.store.searchSpans("oldplaceholder", 2000, [traceId])).toEqual([]);
  expect(reopened.store.countMatchingRuns({ text: "legacyderivedanswer" })).toBe(1);
  expect(reopened.store.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(traceId)).toEqual({ state: "checking" });
  expect(reopened.store.getRun(traceId)?.content_revision).toBeGreaterThan(0);
  expect(reopened.store.getOtlpSpan(traceId, root.spanId)?.span).toEqual(spans[0]);
  reopened.ingestLogs(decodeLogsJson({ resourceLogs: [{ resource: batch(spans).resource, scopeLogs: [{ logRecords: [{ traceId, spanId: root.spanId, eventName: "gen_ai.client.inference.operation.details", timeUnixNano: "200", body: plainToAny({ "gen_ai.output.messages": [{ role: "assistant", content: "replacementanswer" }] }) }] }] }] }));
  exactIds();
  expect(reopened.store.searchSpans("replacementanswer", 10, [traceId]).map((r) => r.span_id)).toEqual([root.spanId]);
  expect(reopened.store.searchSpans("legacyderivedanswer", 2000, [traceId])).toHaveLength(spans.length - 1);
  expect(reopened.store.getOtlpSpan(traceId, root.spanId)?.span).toEqual(spans[0]);
  reopened.store.deleteRun(traceId); exactIds();
  expect(reopened.store.searchSpans("replacementanswer", 10, [traceId])).toEqual([]);
  expect(reopened.store.db.prepare("SELECT COUNT(*) AS n FROM span_fts_ids").get()).toEqual({ n: 0 });
});
