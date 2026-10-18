import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { Replays } from "../src/replay/replay.js";
import { batch, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

function send(t: TestRoots, trace: string, claim?: string) {
  const root = span({ traceId: trace, name: "association", kind: "workflow", attrs: [s("neatlogs.workflow.output", "Done")] });
  root.startTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
  root.endTimeUnixNano = (BigInt(Date.now() + 1) * 1_000_000n).toString();
  const b = batch([root], "association-agent");
  if (claim) b.resource.attributes.push(s("neatroots.replay.id", claim));
  t.roots.ingest([b]);
}

async function setup(conflictBeforeFinish = false, explicit = true, delayed = false) {
  const t = await makeRoots({ noEngine: true }); cleanup.push(t.close);
  const original = hex(16), produced = hex(16); send(t, original);
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const id = JSON.parse(body).replay_id;
    send(t, produced, explicit ? id : undefined);
    if (conflictBeforeFinish) send(t, produced, "foreign");
    if (delayed) await new Promise(resolve => setTimeout(resolve, 100));
    res.end("ok");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  t.roots.config.rerun["association-agent"] = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/run` };
  const result = await t.roots.replayBatches.start(original, 1).done;
  return { t, produced, batchId: result.id, replayId: result.repeats[0].replay_id! };
}

it("clears completed replay navigation after a later foreign claim and retains that decision on restart", async () => {
  const { t, produced, batchId, replayId } = await setup();
  expect(t.roots.replays.originOf(produced)?.id).toBe(replayId);
  send(t, produced, "foreign");
  expect(t.roots.replayBatches.get(batchId)).toMatchObject({ linked: 0, unlinked: 1 });
  expect(t.roots.replays.get(replayId)).toMatchObject({ new_trace_id: null, output_preview: null });
  expect(t.roots.replays.originOf(produced)).toBeUndefined();
  send(t, produced, replayId);
  expect(new Replays(t.roots).originOf(produced)).toBeUndefined();
}, 15_000);

it("does not let async replay completion restore an association already known to conflict", async () => {
  const { t, produced, batchId, replayId } = await setup(true);
  expect(t.roots.replayBatches.get(batchId)).toMatchObject({ linked: 0, unlinked: 1 });
  expect(t.roots.replays.get(replayId)?.new_trace_id).toBeNull();
  expect(t.roots.replays.originOf(produced)).toBeUndefined();
}, 15_000);

it("clears navigation when two distinct traces claim the same attempt", async () => {
  const { t, produced, batchId, replayId } = await setup();
  send(t, hex(16), replayId);
  expect(t.roots.replayBatches.get(batchId)).toMatchObject({ linked: 0, unlinked: 1 });
  expect(t.roots.replays.originOf(produced)).toBeUndefined();
}, 15_000);

it("preserves fallback navigation when no explicit evidence exists, without certifying the batch", async () => {
  const { t, produced, batchId, replayId } = await setup(false, false);
  expect(t.roots.replayBatches.get(batchId)).toMatchObject({ linked: 0, unlinked: 1 });
  expect(t.roots.replays.originOf(produced)?.id).toBe(replayId);
}, 15_000);

it("reconciles a late completion even after the batch watchdog has already returned", async () => {
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    original(fn, ms === 15 * 60_000 + 11_000 ? 20 : ms, ...args)) as typeof setTimeout);
  const { t, produced, batchId, replayId } = await setup(true, true, true);
  expect(t.roots.replayBatches.get(batchId)?.state).toBe("failed");
  await until(() => t.roots.replays.get(replayId)?.state !== "running");
  expect(t.roots.replays.get(replayId)?.new_trace_id).toBeNull();
  expect(t.roots.replays.originOf(produced)).toBeUndefined();
}, 15_000);
