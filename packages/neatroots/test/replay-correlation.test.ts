import { afterEach, expect, it, vi } from "vitest";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let t: TestRoots;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });

function ingest(id = hex(16), replayId?: string, project = "support-agent", childOnly = false) {
  const root = span({ traceId: id, name: "support", kind: "workflow", attrs: replayId && !childOnly ? [s("neatroots.replay.id", replayId)] : [] });
  // Keep these candidates eligible for the original time-based fallback too.
  root.startTimeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
  root.endTimeUnixNano = String(BigInt(root.startTimeUnixNano) + 1_000_000n);
  const spans = [root];
  if (childOnly) spans.push(span({ traceId: id, parent: root.spanId, name: "child", kind: "tool", attrs: [s("neatroots.replay.id", replayId!)] }));
  t.roots.ingest([batch(spans, project)]);
  return id;
}

function polling(onPoll: (n: number) => void) {
  const native = globalThis.setTimeout.bind(globalThis);
  let polls = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, delay, ...args) =>
    native(() => { if (delay === 500) onPoll(++polls); fn(...args); }, delay === 500 ? 0 : delay));
  return () => polls;
}

it.each(["matching", "missing", "wrong"])("accepts HTTP trace API/Browser payload with %s root correlation", async (mode) => {
  t = await makeRoots({ noEngine: true, serve: true });
  const original = ingest();
  let emitted = "";
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (url !== "http://replay.test/") return nativeFetch(url, init);
    const body = JSON.parse(init!.body as string) as { replay_id: string };
    if (mode === "matching") ingest(); // Explicit root correlation wins over a same-project decoy.
    const response = await nativeFetch(t.url + "/v1/trace", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "browser replay", project: "support-agent", input: "hello", output: "answer",
        attributes: mode === "missing" ? {} : { "neatroots.replay.id": mode === "matching" ? body.replay_id : "wrong-id" } }),
    });
    expect(response.status).toBe(200);
    emitted = ((await response.json()) as { trace_id: string }).trace_id;
    return new Response("ok");
  });
  const polls = polling(() => {});
  t.roots.config.rerun["support-agent"] = { url: "http://replay.test/" };
  const replay = await t.roots.replays.startRun(original).done;
  expect(replay).toMatchObject(mode === "wrong" ? { state: "failed", new_trace_id: null } : { state: "succeeded", new_trace_id: emitted });
  expect(emitted).toBeTruthy();
  expect(polls()).toBe(mode === "matching" ? 0 : 20);
});

it.each(["two candidates", "wrong project", "wrong id", "child id"])("rejects fallback with %s", async (mode) => {
  t = await makeRoots({ noEngine: true });
  const original = ingest();
  let replayId = "";
  polling((n) => {
    if (n === 1) ingest(hex(16), mode === "wrong id" ? "other" : mode === "child id" ? replayId : undefined, mode === "wrong project" ? "other-agent" : "support-agent", mode === "child id");
    if (n === 19 && mode === "two candidates") ingest();
    // A child correlation cannot prove this run belongs to the replay; make fallback ambiguous.
    if (n === 2 && mode === "child id") ingest();
  });
  t.roots.config.rerun["support-agent"] = { command: "node -e 0" };
  const started = t.roots.replays.startRun(original);
  replayId = started.replay.id;
  expect(await started.done).toMatchObject({ state: "failed", new_trace_id: null });
});

it("accepts a root arriving after a child created the run, without considering an older run", async () => {
  t = await makeRoots({ noEngine: true });
  const original = ingest();
  const next = hex(16);
  let replayId = "";
  polling((n) => {
    if (n === 1) t.roots.ingest([batch([span({ traceId: next, parent: hex(8), name: "child", kind: "tool" })], "support-agent")]);
    if (n === 2) ingest(original, replayId);
    if (n === 3) ingest(next, replayId);
  });
  t.roots.config.rerun["support-agent"] = { command: "node -e 0" };
  const started = t.roots.replays.startRun(original);
  replayId = started.replay.id;
  expect(await started.done).toMatchObject({ state: "succeeded", new_trace_id: next });
});

it("disables fallback for both overlapping replays even after one finishes explicitly", async () => {
  t = await makeRoots({ noEngine: true });
  const original = ingest();
  let firstId = "";
  let secondStarted: ReturnType<typeof t.roots.replays.startRun> | undefined;
  const exact = hex(16);
  polling((n) => {
    if (n === 1) {
      secondStarted = t.roots.replays.startRun(original);
      ingest(exact, firstId);
      ingest();
    }
  });
  t.roots.config.rerun["support-agent"] = { command: "node -e 0" };
  const first = t.roots.replays.startRun(original);
  firstId = first.replay.id;
  const a = await first.done;
  const b = await secondStarted!.done;
  expect(a).toMatchObject({ state: "succeeded", new_trace_id: exact });
  expect(b).toMatchObject({ state: "failed", new_trace_id: null });
});

it("rejects one uncorrelated candidate shared by two overlapping replays", async () => {
  t = await makeRoots({ noEngine: true });
  const original = ingest();
  polling((n) => { if (n === 1) ingest(); });
  t.roots.config.rerun["support-agent"] = { command: "node -e 0" };
  const a = t.roots.replays.startRun(original);
  const b = t.roots.replays.startRun(original);
  for (const r of await Promise.all([a.done, b.done])) expect(r).toMatchObject({ state: "failed", new_trace_id: null });
});

it("rejects conflicting root/resource IDs and remembers an earlier wrong resource ID", async () => {
  t = await makeRoots({ noEngine: true });
  const original = ingest();
  const next = hex(16);
  let replayId = "";
  polling((n) => {
    if (n === 1) {
      const b = batch([span({ traceId: next, name: "root", kind: "workflow", attrs: [s("neatroots.replay.id", replayId)] })], "support-agent");
      b.resource.attributes.push(s("neatroots.replay.id", "wrong"));
      t.roots.ingest([b]);
    }
    if (n === 2) ingest(next); // A later uncorrelated root cannot turn it into a fallback candidate.
  });
  t.roots.config.rerun["support-agent"] = { command: "node -e 0" };
  const started = t.roots.replays.startRun(original);
  replayId = started.replay.id;
  expect(await started.done).toMatchObject({ state: "failed", new_trace_id: null });
});
