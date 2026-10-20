import { afterEach, expect, it, vi } from "vitest";
import { BatchEvidence } from "../src/replay/batch-evidence.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });
async function setup() {
  t = await makeRoots({ noEngine: true });
  const store = t.roots.store, evidence = new BatchEvidence(store), id = "rp_0123456789ab", trace = hex(16);
  store.db.prepare("INSERT INTO replay_batch_members(batch_id,ordinal,replay_id) VALUES ('batch',1,?)").run(id);
  const ingest = (claim?: string, spanId = hex(8)) => {
    const b = batch([span({ traceId: trace, spanId, name: "streamed", kind: "tool", attrs: claim ? [s("neatroots.replay.id", claim)] : [] })]);
    store.ingest([b]); evidence.observe([b]); return spanId;
  };
  return { store, evidence, id, trace, ingest };
}

it("backfills once then inspects streaming and replaced claims without rehydrating history", async () => {
  const { store, evidence, id, trace, ingest } = await setup();
  for (let i = 0; i < 12; i++) ingest();
  const reads = vi.spyOn(store, "getOtlpSpan");
  const first = ingest(id);
  expect(reads).toHaveBeenCalledTimes(13);
  reads.mockClear();
  for (let i = 0; i < 520; i++) ingest();
  expect(evidence.uniqueTrace(id)).toBe(trace);
  expect(reads).not.toHaveBeenCalled();
  ingest("foreign", first);
  expect(evidence.uniqueTrace(id)).toBeNull();
  ingest(id, first);
  expect(evidence.uniqueTrace(id)).toBeNull();
  expect(reads).not.toHaveBeenCalled();
});

it("does not certify a first association whose prior history exceeds the backfill bound", async () => {
  const { evidence, id, ingest } = await setup();
  for (let i = 0; i < 513; i++) ingest();
  ingest(id);
  expect(evidence.uniqueTrace(id)).toBeNull();
});

it("keeps pre-match foreign claims sticky across a reader restart", async () => {
  const { store, evidence, id, trace, ingest } = await setup();
  const earlier = ingest("foreign"); ingest(id);
  expect(evidence.uniqueTrace(id)).toBeNull();
  const restarted = new BatchEvidence(store);
  const reads = vi.spyOn(store, "getOtlpSpan");
  const b = batch([span({ traceId: trace, spanId: earlier, name: "replacement", kind: "tool", attrs: [s("neatroots.replay.id", id)] })]);
  store.ingest([b]); restarted.observe([b]);
  expect(restarted.uniqueTrace(id)).toBeNull();
  expect(reads).not.toHaveBeenCalled();
});
