import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { traceReadback } from "../src/server/readback.js";
import { batch, closeTrackedStores, hex, llmSpan, markerSpan, s, span, tmpHome, toolSpan, trackedStore } from "./helpers.js";

const homes: string[] = [];
function store(): Store {
  const h = tmpHome();
  homes.push(h);
  return trackedStore(path.join(h, "data"));
}
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe("store", () => {
  it("aggregates a run from child spans, root and completion marker", () => {
    const st = store();
    const t = hex(16);
    const root = hex(8);
    const u1 = st.ingest([batch([llmSpan(t, root, { system: "sys", user: "refund 4512", toolCalls: [{ name: "lookup_order", args: '{"order_id":"4512"}' }] }), toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404 not found")])]);
    expect(u1[0]).toMatchObject({ runCreated: true, rootEnded: false });
    let run = st.getRun(t)!;
    expect(run).toMatchObject({ status: "running", span_count: 2, llm_calls: 1, tool_calls: 1, error_count: 1, total_tokens: 15, project: "test-agent" });
    const u2 = st.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow", attrs: [s("neatlogs.session.id", "sess-9"), s("neatlogs.workflow.input", '{"q":"refund"}'), s("neatlogs.workflow.output", '"done"')] })])]);
    expect(u2[0].rootEnded).toBe(true);
    run = st.getRun(t)!;
    expect(run).toMatchObject({ status: "ok", root_span_id: root, root_name: "refund", session_id: "sess-9", span_count: 3 });
    const u3 = st.ingest([batch([markerSpan(t, root)])]);
    expect(u3[0].completed).toBe(true);
    expect(st.getRun(t)!.complete).toBe(1);
    expect(st.getRun(t)!.span_count).toBe(3);
    // re-sent spans do not double count
    st.ingest([batch([toolSpan(t, root, "x", "{}")].map((x) => ({ ...x, spanId: st.getSpans(t)[1].span_id })))]);
    expect(st.getRun(t)!.span_count).toBe(3);
  });

  it("reconciles run aggregates when a span is updated", () => {
    const st = store();
    const t = hex(16);
    const root = hex(8);
    const original = llmSpan(t, root, { user: "first" });
    st.ingest([batch([original])]);
    expect(st.getRun(t)).toMatchObject({ span_count: 1, llm_calls: 1, tool_calls: 0, error_count: 0, total_tokens: 15 });

    // An identical exporter retry stays idempotent.
    st.ingest([batch([original])]);
    expect(st.getRun(t)).toMatchObject({ span_count: 1, llm_calls: 1, tool_calls: 0, error_count: 0, total_tokens: 15 });

    // A completed export of the same logical span replaces provisional usage and status.
    const completed = span({
      traceId: t,
      spanId: original.spanId,
      parent: root,
      name: original.name,
      kind: "llm",
      status: 2,
      attrs: [
        s("neatlogs.llm.token_count.prompt", 30),
        s("neatlogs.llm.token_count.completion", 12),
        s("neatlogs.llm.token_count.total", 42),
      ],
    });
    st.ingest([batch([completed])]);
    expect(st.getRun(t)).toMatchObject({ span_count: 1, llm_calls: 1, tool_calls: 0, error_count: 1, prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 });

    const updated = toolSpan(t, root, "lookup_order", "{}", undefined, "timeout");
    updated.spanId = original.spanId;
    st.ingest([batch([updated])]);
    expect(st.getRun(t)).toMatchObject({ span_count: 1, llm_calls: 0, tool_calls: 1, error_count: 1, total_tokens: 0 });

    const marker = markerSpan(t, root);
    marker.spanId = original.spanId;
    st.ingest([batch([marker])]);
    expect(st.getRun(t)).toMatchObject({ span_count: 0, llm_calls: 0, tool_calls: 0, error_count: 0, total_tokens: 0 });

    st.ingest([batch([updated])]);
    expect(st.getRun(t)).toMatchObject({ span_count: 1, llm_calls: 0, tool_calls: 1, error_count: 1, total_tokens: 0 });
  });

  it("offloads large payloads to blobs and restores them losslessly", () => {
    const st = store();
    const t = hex(16);
    const big = "x".repeat(100_000);
    const sp = span({ traceId: t, name: "big", kind: "tool", attrs: [s("neatlogs.tool.output", big), s("n", 3)] });
    const b = batch([sp]);
    st.ingest([b]);
    const raw = st.db.prepare("SELECT attributes, blobs FROM spans").get() as { attributes: string; blobs: string };
    expect(raw.attributes.length).toBeLessThan(2000);
    expect(JSON.parse(raw.blobs)).toHaveLength(1);
    const [back] = st.batchesForTraces([t]);
    expect(back.spans[0].attributes).toEqual(sp.attributes);
    expect(back.resource).toEqual(b.resource);
    st.deleteRun(t);
    expect(st.blobs.size()).toBe(0);
  });

  it("reclaims superseded payloads through repeated updates and run deletion", () => {
    const st = store();
    const traceId = hex(16);
    const spanId = hex(8);
    const oldPayload = `old payload ${"o".repeat(40_000)}`;
    const newPayload = `new payload ${"n".repeat(40_000)}`;
    const latestPayload = `latest payload ${"z".repeat(40_000)}`;
    const write = (payload: string) => span({ traceId, spanId, name: "replace", kind: "tool", attrs: [s("payload", payload)] });

    st.ingest([batch([write(oldPayload)])]);
    const readSha = () => {
      const raw = st.db.prepare("SELECT blobs FROM spans WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) as { blobs: string };
      return (JSON.parse(raw.blobs) as string[])[0];
    };
    const oldSha = readSha();
    expect(st.blobs.sizeOf(oldSha)).toBe(Buffer.byteLength(oldPayload, "utf8"));
    st.ingest([batch([write(oldPayload)])]); // an identical retry still references the same content
    expect(readSha()).toBe(oldSha);
    expect(st.blobs.sizeOf(oldSha)).toBe(Buffer.byteLength(oldPayload, "utf8"));

    st.ingest([batch([write(newPayload)])]);
    const newSha = readSha();
    expect(st.blobs.sizeOf(oldSha)).toBe(0);
    expect(st.blobs.sizeOf(newSha)).toBe(Buffer.byteLength(newPayload, "utf8"));

    st.ingest([batch([write(latestPayload)])]);
    const latestSha = readSha();
    expect(st.blobs.sizeOf(newSha)).toBe(0);
    expect(st.blobs.sizeOf(latestSha)).toBe(Buffer.byteLength(latestPayload, "utf8"));
    const [roundTrip] = st.batchesForTraces([traceId]);
    expect(roundTrip.spans[0].attributes.find((attribute) => attribute.key === "payload")?.value).toEqual({ stringValue: latestPayload });
    expect(st.blobs.size()).toBe(Buffer.byteLength(latestPayload, "utf8"));

    const smallPayload = "small replacement";
    st.ingest([batch([write(smallPayload)])]);
    expect(st.blobs.sizeOf(latestSha)).toBe(0);
    expect(st.blobs.size()).toBe(0);
    const [smallRoundTrip] = st.batchesForTraces([traceId]);
    expect(smallRoundTrip.spans[0].attributes.find((attribute) => attribute.key === "payload")?.value).toEqual({ stringValue: smallPayload });

    st.deleteRun(traceId);
    expect(st.blobs.size()).toBe(0);
  });

  it("keeps shared payloads across spans and pinned runs during retention", () => {
    const st = store();
    const pinnedTrace = hex(16);
    const unpinnedTrace = hex(16);
    const pinnedSpanA = hex(8);
    const pinnedSpanB = hex(8);
    const unpinnedSpan = hex(8);
    const shared = `shared prompt ${"s".repeat(40_000)}`;
    const replacementA = `replacement A ${"a".repeat(40_000)}`;
    const replacementB = `replacement B ${"b".repeat(40_000)}`;
    const blobSha = (traceId: string, spanId: string) => {
      const row = st.db.prepare("SELECT blobs FROM spans WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) as { blobs: string };
      return (JSON.parse(row.blobs) as string[])[0];
    };

    st.ingest([
      batch([
        span({ traceId: pinnedTrace, spanId: pinnedSpanA, name: "pinned-a", kind: "tool", attrs: [s("payload", shared)] }),
        span({ traceId: pinnedTrace, spanId: pinnedSpanB, name: "pinned-b", kind: "tool", attrs: [s("payload", shared)] }),
      ]),
      batch([span({ traceId: unpinnedTrace, spanId: unpinnedSpan, name: "unpinned", kind: "tool", attrs: [s("payload", shared)] })]),
    ]);
    const sharedSha = blobSha(pinnedTrace, pinnedSpanA);
    expect(blobSha(pinnedTrace, pinnedSpanB)).toBe(sharedSha);
    expect(blobSha(unpinnedTrace, unpinnedSpan)).toBe(sharedSha);
    expect(st.blobs.size()).toBe(Buffer.byteLength(shared, "utf8"));

    st.setPinned(pinnedTrace, true);
    st.db.prepare("UPDATE runs SET received_ms = 1, ended_ms = 1 WHERE trace_id IN (?, ?)").run(pinnedTrace, unpinnedTrace);
    expect(st.sweep(14, Number.POSITIVE_INFINITY)).toBe(1);
    expect(st.getRun(pinnedTrace)).toBeDefined();
    expect(st.getRun(unpinnedTrace)).toBeUndefined();
    expect(st.blobs.sizeOf(sharedSha)).toBe(Buffer.byteLength(shared, "utf8"));

    st.ingest([batch([span({ traceId: pinnedTrace, spanId: pinnedSpanA, name: "pinned-a", kind: "tool", attrs: [s("payload", replacementA)] })])]);
    expect(st.blobs.sizeOf(sharedSha)).toBe(Buffer.byteLength(shared, "utf8")); // the second span in the pinned run still references it
    st.ingest([batch([span({ traceId: pinnedTrace, spanId: pinnedSpanB, name: "pinned-b", kind: "tool", attrs: [s("payload", replacementB)] })])]);
    expect(st.blobs.sizeOf(sharedSha)).toBe(0);
    expect(st.getRun(pinnedTrace)).toBeDefined();
    expect(st.blobs.size()).toBe(Buffer.byteLength(replacementA, "utf8") + Buffer.byteLength(replacementB, "utf8"));
  });

  it("keeps the old payload when the span update transaction rolls back", () => {
    const st = store();
    const traceId = hex(16);
    const spanId = hex(8);
    const oldPayload = `committed payload ${"c".repeat(40_000)}`;
    const failedPayload = `rolled back payload ${"r".repeat(40_000)}`;
    const write = (payload: string) => span({ traceId, spanId, name: "transaction", kind: "tool", attrs: [s("payload", payload)] });
    st.ingest([batch([write(oldPayload)])]);
    const before = st.db.prepare("SELECT attributes, blobs FROM spans WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) as { attributes: string; blobs: string };
    const [oldSha] = JSON.parse(before.blobs) as string[];

    const prepare = st.db.prepare.bind(st.db);
    st.db.prepare = ((sql: string) => {
      if (sql.includes("INSERT INTO span_fts")) throw new Error("injected failure after blob write");
      return prepare(sql);
    }) as typeof st.db.prepare;
    try {
      expect(() => st.ingest([batch([write(failedPayload)])])).toThrow("injected failure after blob write");
    } finally {
      st.db.prepare = prepare;
    }

    const after = st.db.prepare("SELECT attributes, blobs FROM spans WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) as { attributes: string; blobs: string };
    expect(after).toEqual(before);
    expect(st.blobs.sizeOf(oldSha)).toBe(Buffer.byteLength(oldPayload, "utf8"));
    const [roundTrip] = st.batchesForTraces([traceId]);
    expect(roundTrip.spans[0].attributes.find((attribute) => attribute.key === "payload")?.value).toEqual({ stringValue: oldPayload });
  });

  it("searches span content and keeps pinned runs through retention", () => {
    const st = store();
    const a = hex(16);
    const b = hex(16);
    st.ingest([batch([toolSpan(a, "", "lookup_order", '{"order_id":"77"}', '{"owner":"zelda"}')]), batch([toolSpan(b, "", "other", "{}", "{}")])]);
    expect(st.searchSpans("zelda").map((h) => h.trace_id)).toEqual([a]);
    st.setPinned(a, true);
    st.db.prepare("UPDATE runs SET received_ms = 0, ended_ms = 0").run();
    expect(st.sweep(14, 5 * 1024 ** 3)).toBe(1);
    expect(st.getRun(a)).toBeDefined();
    expect(st.getRun(b)).toBeUndefined();
  });

  it("finds text anywhere in long outputs, including the very end", () => {
    const st = store();
    const t = hex(16);
    const filler = (n: number) => "x ".repeat(n / 2);
    const out = `${filler(1_000)} QA_AT_1K ${filler(9_000)} QA_AT_10K ${filler(15_000)} QA_AT_25K ${filler(25_000)} QA_TAIL`;
    st.ingest([batch([toolSpan(t, "", "fetch_page", '{"url":"x"}', JSON.stringify(out))])]);
    for (const marker of ["QA_AT_1K", "QA_AT_10K", "QA_AT_25K", "QA_TAIL"]) expect(st.searchSpans(marker).map((h) => h.trace_id)).toEqual([t]);
  });

  it("lists every run whose spans match a search, newest first, not just the best-ranked 500 spans", () => {
    const st = store();
    const ids: string[] = [];
    // 300 older runs mention the error a lot (they rank high); each has 2 matching spans
    for (let i = 0; i < 300; i++) {
      const t = hex(16);
      const root = hex(8);
      ids.push(t);
      st.ingest([batch([span({ traceId: t, spanId: root, name: "agent", kind: "workflow" }), toolSpan(t, root, "db", '{"q":"a"}', "ECONNRESET ECONNRESET retry"), toolSpan(t, root, "db", '{"q":"b"}', "ECONNRESET again")])]);
      st.db.prepare("UPDATE runs SET started_ms = ?, received_ms = ? WHERE trace_id = ?").run(1_000 + i, 1_000 + i, t);
    }
    // the newest run mentions it once, deep in a long output (it ranks low)
    const newest = hex(16);
    const root = hex(8);
    st.ingest([batch([span({ traceId: newest, spanId: root, name: "agent", kind: "workflow" }), toolSpan(newest, root, "db", '{"q":"c"}', `${"unrelated words ".repeat(300)} ECONNRESET`)])]);
    st.db.prepare("UPDATE runs SET started_ms = ?, received_ms = ? WHERE trace_id = ?").run(999_999, 999_999, newest);
    const first = st.listRuns({ text: "ECONNRESET", limit: 150 });
    expect(first[0]?.trace_id).toBe(newest); // was missing: only the best-ranked 500 spans were considered
    const all = [...first, ...st.listRuns({ text: "ECONNRESET", limit: 150, offset: 150 }), ...st.listRuns({ text: "ECONNRESET", limit: 150, offset: 300 })];
    expect(new Set(all.map((r) => r.trace_id)).size).toBe(301); // was 250 (500 spans, 2 per run)
    expect(st.listRuns({ text: "no-such-word-here" })).toEqual([]);
  });

  it("re-indexes spans that were stored with the old 4,000-character index", async () => {
    const st = store();
    const t = hex(16);
    st.ingest([batch([toolSpan(t, "", "fetch_page", "{}", JSON.stringify(`${"y ".repeat(5_000)} OLD_TAIL`))])]);
    // As a database written by an earlier version: a truncated index, no version marker.
    st.db.prepare("UPDATE span_fts SET body = substr(body, 1, 4000)").run();
    st.db.prepare("DELETE FROM meta WHERE key = 'search_index'").run();
    expect(st.searchSpans("OLD_TAIL")).toEqual([]);
    const n = await new Promise<number>((r) => st.reindexSearch(r));
    expect(n).toBe(1);
    expect(st.searchSpans("OLD_TAIL").map((h) => h.trace_id)).toEqual([t]);
  });

  it("does not delete every run when retention days is 0", () => {
    const st = store();
    for (let i = 0; i < 4; i++) st.ingest([batch([span({ traceId: hex(16), spanId: hex(8), name: "r", kind: "workflow", attrs: [s("neatlogs.workflow.input", `"req ${i}"`)] })])]);
    // Even with ended/received times in the past, days=0 must NOT wipe everything.
    st.db.prepare("UPDATE runs SET received_ms = 1, ended_ms = 1").run();
    expect(st.sweep(0, 5 * 1024 ** 3)).toBe(0);
    expect(st.listRuns({ limit: 500 }).length).toBe(4);
    // a normal positive retention still prunes old runs
    expect(st.sweep(14, 5 * 1024 ** 3)).toBe(4);
    expect(st.listRuns({ limit: 500 }).length).toBe(0);
  });

  it("trims to the size cap by removing the oldest runs, not every run", () => {
    // Bytes of data the store holds, measured independently of the code under test: the search
    // index is compacted first (deleted rows leave markers until then), then database pages in use
    // plus every blob file on disk.
    const held = (st: Store, home: string) => {
      st.db.prepare("INSERT INTO span_fts(span_fts) VALUES('optimize')").run();
      const pages = (st.db.pragma("page_count", { simple: true }) as number) - (st.db.pragma("freelist_count", { simple: true }) as number);
      const blobDir = path.join(home, "data", "blobs");
      const files = fs.existsSync(blobDir) ? fs.readdirSync(blobDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()) : [];
      return pages * (st.db.pragma("page_size", { simple: true }) as number) + files.reduce((n, e) => n + fs.statSync(path.join(e.parentPath, e.name)).size, 0);
    };
    let seed = 1;
    const word = () => ((seed = (seed * 48271) % 2147483647) % 1e9).toString(36);
    const words = (n: number) => Array.from({ length: n }, word).join(" ");
    const shared = words(6000); // over the blob threshold, and the same in every run (e.g. a big system prompt)
    const payloads: Record<string, (i: number) => ReturnType<typeof s>[]> = {
      "repeated text": () => [s("input.value", "lorem ipsum ".repeat(400))],
      "unique words": () => [s("input.value", words(1500))], // full-text index keeps deleted markers until compacted
      "big values stored as blobs": () => [s("input.value", words(6000))],
      "a blob shared by every run": () => [s("system.prompt", shared), s("input.value", words(300))],
    };
    for (const [label, attrs] of Object.entries(payloads)) {
      const h = tmpHome();
      homes.push(h);
      const st = trackedStore(path.join(h, "data"));
      const ids: string[] = [];
      for (let i = 0; i < 60; i++) {
        const t = hex(16);
        ids.push(t);
        st.ingest([batch([span({ traceId: t, spanId: hex(8), name: `r${i}`, kind: "workflow", attrs: attrs(i) })])]);
        st.db.prepare("UPDATE runs SET received_ms = ?, ended_ms = ? WHERE trace_id = ?").run(1_000 + i, 1_000 + i, t);
      }
      st.setPinned(ids[0], true); // the oldest run, but pinned
      const cap = Math.floor(held(st, h) * 0.6);
      let compactions = 0;
      const orig = st.db.prepare.bind(st.db);
      st.db.prepare = ((sql: string) => {
        if (sql.includes("'optimize'")) compactions++;
        return orig(sql);
      }) as typeof st.db.prepare;
      const removed = st.sweep(999_999, cap);
      st.db.prepare = orig;
      // was: every unpinned run deleted (59 of 59), because the measured size never dropped
      expect(removed, label).toBeGreaterThan(0);
      expect(removed, label).toBeLessThan(50);
      expect(compactions, label).toBeLessThanOrEqual(1); // the search index is rewritten at most once a sweep
      const after = held(st, h);
      expect(after, label).toBeLessThanOrEqual(cap);
      expect(after, label).toBeLessThan(cap * 0.97); // trimmed toward the low-water mark, not just under the cap
      expect(st.getRun(ids[0]), label).toBeDefined(); // pinned survives
      expect(st.getRun(ids[59]), label).toBeDefined(); // newest survives
      for (const t of ids.slice(1, 1 + removed)) expect(st.getRun(t), label).toBeUndefined(); // exactly the oldest went
      for (const t of ids.slice(1 + removed)) expect(st.getRun(t), label).toBeDefined();
      expect(st.sweep(999_999, cap), label).toBe(0); // the next sweep has nothing to do
    }
  });

  it("doesn't compact or trim a store that is under its cap", () => {
    const st = store();
    for (let i = 0; i < 10; i++) st.ingest([batch([span({ traceId: hex(16), spanId: hex(8), name: `r${i}`, kind: "workflow", attrs: [s("input.value", "hello ".repeat(200))] })])]);
    let compactions = 0;
    const orig = st.db.prepare.bind(st.db);
    st.db.prepare = ((sql: string) => {
      if (sql.includes("'optimize'")) compactions++;
      return orig(sql);
    }) as typeof st.db.prepare;
    expect(st.sweep(14, 5 * 1024 ** 3)).toBe(0);
    st.db.prepare = orig;
    expect(compactions).toBe(0);
  });

  it("clamps bad limit/offset values instead of crashing or ignoring them", () => {
    const st = store();
    for (let i = 0; i < 5; i++) st.ingest([batch([span({ traceId: hex(16), spanId: hex(8), name: "r", kind: "workflow", attrs: [s("neatlogs.workflow.input", `"req ${i}"`)] })])]);
    // NaN (e.g. from Number("abc")) must not throw and must not return everything via a NaN LIMIT
    expect(() => st.listRuns({ limit: NaN })).not.toThrow();
    expect(st.listRuns({ limit: NaN }).length).toBe(5);
    // a negative limit must not be treated as "no limit": clamps to >= 1
    expect(st.listRuns({ limit: -5 }).length).toBe(1);
    // normal and over-max still behave
    expect(st.listRuns({ limit: 2 }).length).toBe(2);
    expect(st.listRuns({ limit: 9999 }).length).toBe(5);
  });

  it("treats LIKE wildcards (% and _) in run search as literal text", () => {
    const st = store();
    const underscore = hex(16);
    const plain = hex(16);
    // one run whose input literally contains an underscore, one that does not
    st.ingest([batch([span({ traceId: underscore, spanId: hex(8), name: "r", kind: "workflow", attrs: [s("neatlogs.workflow.input", '"order_id lookup"')] })])]);
    st.ingest([batch([span({ traceId: plain, spanId: hex(8), name: "r", kind: "workflow", attrs: [s("neatlogs.workflow.input", '"plain request"')] })])]);

    // "%" and "_" must NOT behave as wildcards (they'd otherwise match every run)
    expect(st.listRuns({ text: "%" }).length).toBe(0);
    // "_" matches only the run that literally contains an underscore, not everything
    const us = st.listRuns({ text: "_" }).map((r) => r.trace_id);
    expect(us).toContain(underscore);
    expect(us).not.toContain(plain);
    // a normal substring search still works
    expect(st.listRuns({ text: "plain" }).map((r) => r.trace_id)).toContain(plain);
    expect(st.listRuns({ text: "nope-nothing" }).length).toBe(0);
  });

  it("serves the doctor read-back shape", () => {
    const st = store();
    const t = hex(16);
    const root = hex(8);
    const agent = hex(8);
    const doctorAttrs = [s("neatlogs.doctor", true), s("neatlogs.doctor.version", "v1"), s("service.name", "neatlogs.doctor.v2"), s("telemetry.sdk.version", "1.4.24")];
    st.ingest([
      batch([
        span({ traceId: t, spanId: agent, parent: root, name: "doctor.probe.agent", kind: "agent", attrs: [...doctorAttrs, s("input.value", '{"prompt":"generated diagnostic input"}'), s("output.value", '{"text":"generated diagnostic output"}')] }),
        span({ traceId: t, parent: agent, name: "doctor.probe.llm", kind: "llm", status: 0, attrs: [...doctorAttrs, s("input.value", '{"messages":[{"role":"user","content":"generated diagnostic input"}]}'), s("output.value", '{"text":"generated diagnostic output"}'), s("neatlogs.llm.token_count.prompt", "11"), s("neatlogs.llm.token_count.completion", "7"), s("neatlogs.llm.token_count.total", "18")] }),
      ], "neatlogs.doctor.v2"),
    ]);
    expect(traceReadback(st, t).status).toBe(202);
    expect(traceReadback(st, hex(16)).status).toBe(404);
    st.ingest([batch([span({ traceId: t, spanId: root, name: "doctor.probe.root", kind: "workflow", status: 0, attrs: [...doctorAttrs, s("input.value", '{"prompt":"generated diagnostic input"}'), s("output.value", '{"result":{"value":2}}')] }), markerSpan(t, root)], "neatlogs.doctor.v2")]);
    const r = traceReadback(st, t);
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body).toMatchObject({ _id: t, status: "success", spanCount: 3, promptTokens: 11, completionTokens: 7, totalTokensUsed: 18 });
    const byName = Object.fromEntries(body.spans.map((x: any) => [x.node_name, x]));
    expect(byName["doctor.probe.agent"].node_type).toBe("agent_action");
    expect(byName["doctor.probe.llm"].data.input_value).toEqual({ messages: [{ role: "user", content: "generated diagnostic input" }] });
    expect(byName["doctor.probe.root"].data.output_value).toEqual({ result: { value: 2 } });
    expect(byName["doctor.probe.root"].span_metadata["neatlogs.doctor"]).toBe(true);
    expect(byName["doctor.probe.root"].span_metadata["telemetry.sdk.language"]).toBe("python");
    expect(body.spans.some((x: any) => x.node_name === "neatlogs.trace.complete")).toBe(false);
  });
});
