import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace, matchesSelector } from "../src/engine/trace.js";
import { buildView } from "../src/semantics/view.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, makeRoots, mockLlm, s, span, tmpHome, until } from "./helpers.js";

// Issue #387: the SDK marks a streamed reply the caller stopped reading with neatlogs.stream.cancelled.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

function testStore(): Store {
  const h = tmpHome();
  const st = new Store(path.join(h, "data"));
  cleanup.push(() => {
    st.close();
    fs.rmSync(h, { recursive: true, force: true });
  });
  return st;
}

const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const rule = (id: string) => lib.find((c) => c.id === id)!;
const cancelled = s("neatlogs.stream.cancelled", true);

/** One run whose only span is an LLM call with the given attributes and status code. */
function oneCall(st: Store, attrs = [cancelled], status = 1, kind = "llm") {
  const t = hex(16);
  st.ingest([batch([span({ traceId: t, name: "chat", kind, attrs, status })])]);
  return loadTrace(st, t);
}

describe("the span view", () => {
  it("reads neatlogs.stream.cancelled, sent as a boolean or as the string true", () => {
    expect(buildView(span({ traceId: hex(16), name: "chat", kind: "llm", attrs: [cancelled] }), []).streamCancelled).toBe(true);
    expect(buildView(span({ traceId: hex(16), name: "chat", kind: "llm", attrs: [s("neatlogs.stream.cancelled", "true")] }), []).streamCancelled).toBe(true);
    expect(buildView(span({ traceId: hex(16), name: "chat", kind: "llm", attrs: [s("neatlogs.stream.cancelled", false)] }), []).streamCancelled).toBeUndefined();
    expect(buildView(span({ traceId: hex(16), name: "chat", kind: "llm" }), []).streamCancelled).toBeUndefined();
  });
});

describe("the stream_cancelled selector", () => {
  it("matches only flagged spans when true, and only unflagged ones when false", () => {
    const st = testStore();
    const [flagged] = oneCall(st).spans;
    const [plain] = oneCall(st, []).spans;
    expect(matchesSelector(flagged, { stream_cancelled: true })).toBe(true);
    expect(matchesSelector(plain, { stream_cancelled: true })).toBe(false);
    expect(matchesSelector(plain, { stream_cancelled: false })).toBe(true);
    expect(matchesSelector(flagged, { stream_cancelled: false })).toBe(false);
  });
});

describe("the stream-abandoned rule", () => {
  it("fires on an abandoned reply, with status OK or left unset", () => {
    const st = testStore();
    for (const status of [1, 0]) {
      const hit = evaluateRule(rule("stream-abandoned"), oneCall(st, [cancelled], status), false);
      expect(hit?.firing).toBe(true);
      expect(hit?.evidenceSpanIds).toHaveLength(1);
    }
  });

  it("stays quiet on a reply that finished, and on a non-LLM span carrying the flag", () => {
    const st = testStore();
    expect(evaluateRule(rule("stream-abandoned"), oneCall(st, [s("neatlogs.llm.finish_reason", "stop")]), false)).toBeNull();
    expect(evaluateRule(rule("stream-abandoned"), oneCall(st, [cancelled], 1, "tool"), false)).toBeNull();
  });

  it("leaves a stream that failed with an error to llm-call-failed, so the call is reported once", () => {
    const st = testStore();
    const t = oneCall(st, [cancelled], 2);
    expect(evaluateRule(rule("stream-abandoned"), t, false)).toBeNull();
    expect(evaluateRule(rule("llm-call-failed"), t, false)?.firing).toBe(true);
  });

  it("counts every abandoned reply in the run", () => {
    const st = testStore();
    const t = hex(16);
    st.ingest([batch([0, 1, 2].map((i) => span({ traceId: t, name: `chat ${i}`, kind: "llm", attrs: i < 2 ? [cancelled] : [], status: 1 })))]);
    const hit = evaluateRule(rule("stream-abandoned"), loadTrace(st, t), false);
    expect(hit?.evidenceSpanIds).toHaveLength(2);
    expect(hit?.params?.count).toBe("2");
  });
});

describe("a run with an abandoned stream", () => {
  it("marks the call in the run page's spans, and clears it when a corrected span drops the flag", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(() => tb.close());
    const t = hex(16);
    const id = hex(8);
    const send = (attrs: ReturnType<typeof s>[]) => tb.roots.ingest([batch([span({ traceId: t, spanId: id, name: "chat", kind: "llm", attrs, status: 1 })])]);
    const flagOnPage = async () => {
      const r = await fetch(`${tb.url}/api/runs/${t}`, { headers: { origin: tb.url.replace("127.0.0.1", "localhost") } });
      return ((await r.json()) as { spans: { span_id: string; stream_cancelled: number | null }[] }).spans.find((x) => x.span_id === id)?.stream_cancelled;
    };
    send([cancelled]);
    expect(await flagOnPage()).toBe(1);
    send([]);
    expect(await flagOnPage()).toBe(0);
  });

  it("gets a stream-abandoned finding from the running engine", async () => {
    const llm = await mockLlm({});
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const t = hex(16);
    tb.roots.ingest([batch([span({ traceId: t, name: "chat", kind: "llm", attrs: [cancelled], status: 1 })])]);
    const f = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "stream-abandoned"), 10_000);
    expect(f.status).toBe("raised");
  });
});

describe("a store from before the flag was read", () => {
  it("gains the column on open, leaving its spans unlabelled", () => {
    const h = tmpHome();
    const dir = path.join(h, "data");
    const st = new Store(dir);
    const t = hex(16);
    st.ingest([batch([span({ traceId: t, name: "chat", kind: "llm", attrs: [cancelled], status: 1 })])]);
    st.db.exec("ALTER TABLE spans DROP COLUMN stream_cancelled");
    st.close();
    const reopened = new Store(dir);
    cleanup.push(() => {
      reopened.close();
      fs.rmSync(h, { recursive: true, force: true });
    });
    expect(reopened.getSpans(t)[0].stream_cancelled).toBeNull();
    // The check reads the stored attribute, so it still finds the old abandoned call.
    expect(evaluateRule(rule("stream-abandoned"), loadTrace(reopened, t), false)?.firing).toBe(true);
  });
});
