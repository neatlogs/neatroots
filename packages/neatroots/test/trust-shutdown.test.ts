import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store/db.js";
import { AmbientController } from "../src/ambient/controller.js";
import { ChromaOutput } from "../src/ambient/chroma.js";
import { batch, hex, makeRoots, markerSpan, mockLlm, span, tmpHome, until } from "./helpers.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
function store() {
  const home = tmpHome(); const dir = path.join(home, "data"); const store = new Store(dir);
  cleanup.push(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { store, dir };
}
it("flushes one shared dirty trust view before close and cancels its debounce", () => {
  vi.useFakeTimers(); const { store: st, dir } = store();
  const first = st.trustStore(), second = st.trustStore(); expect(second).toBe(first);
  first.record("question", true); second.record("question", false);
  st.close(); expect(() => st.close()).not.toThrow();
  expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  const reopened = new Store(dir);
  try { expect(reopened.trustStore().get("question")).toEqual({ n: 2, agree: 1 }); } finally { reopened.close(); }
});
it("ignores late comparisons, including a trust view first requested after close", () => {
  vi.useFakeTimers(); const { store: st } = store(); const trust = st.trustStore(); st.close();
  const write = vi.spyOn(st, "setMeta");
  expect(() => trust.record("late", true)).not.toThrow(); expect(trust.get("late").n).toBe(0);
  vi.advanceTimersByTime(2000); expect(write).not.toHaveBeenCalled();
  const other = store().store; other.close();
  expect(() => other.trustStore().record("late", true)).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});
it("retains normal debounced persistence and closes even when the final flush fails", () => {
  vi.useFakeTimers(); const { store: st } = store(); const trust = st.trustStore();
  trust.record("saved", true); vi.advanceTimersByTime(1000);
  expect(JSON.parse(st.getMeta("laya_trust")!)).toEqual({ saved: { n: 1, agree: 1 } });
  trust.record("dirty", false); const write = vi.spyOn(st, "setMeta").mockImplementation(() => { throw new Error("disk failure"); });
  expect(() => st.close()).toThrow("disk failure"); expect(st.db.open).toBe(false);
  write.mockRestore(); expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
});

it("real engine comparisons persist before delayed Chroma cleanup and late shadow results cannot write closed SQLite", async () => {
  const llm = await mockLlm({ plan: [{ id: "unfinished-task" }] }); cleanup.push(llm.close);
  let lateResponse: ServerResponse | undefined;
  const laya = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw || "{}");
    if (body.questions?.["late-shadow"]) { lateResponse = res; return; }
    res.end(JSON.stringify({ model: "fake-laya", answers: Object.fromEntries(Object.keys(body.questions ?? {}).map(q => [q, { type: "noul", noul: 0.1 }])) }));
  });
  await new Promise<void>(resolve => laya.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { laya.closeAllConnections(); await new Promise<void>(resolve => laya.close(() => resolve())); });
  const tb = await makeRoots({ llmUrl: llm.url, config: c => {
    c.classifier.backend = "auto"; c.classifier.baseUrl = ""; c.classifier.laya.enabled = true;
    c.classifier.laya.port = (laya.address() as { port: number }).port;
  } }); cleanup.push(tb.close);
  const trust = tb.roots.store.trustStore();
  const records = vi.spyOn(trust, "record");
  const id = hex(16), root = hex(8);
  tb.roots.ingest([batch([span({ traceId: id, spanId: root, name: "finished workflow", kind: "workflow" }), markerSpan(id, root)])]);
  await until(() => Object.values(trust.all()).some(v => v.n > 0), 8000, 5);
  expect(tb.roots.engine).toBeDefined(); expect(llm.requests.length).toBeGreaterThan(0);
  await tb.roots.engine!.waitIdle(id, 5000);
  // Real auto-mode LLM answer starts a Laya comparison that remains in flight across Store.close.
  await tb.roots.decisions.decide("late state", [{ name: "late-shadow", type: "yes_no", ask: "Did it fail?" }]);
  await until(() => lateResponse, 5000, 5);
  // Ensure a pending pre-close write independent of the engine's elapsed debounce.
  trust.record("pre-close", true);
  let closing = false, clearDone = false, deleteDone = false;
  let origin = "";
  const chroma = createServer((req, res) => {
    req.resume();
    if (req.method === "POST") { res.end(JSON.stringify({ sessionid: 1, uri: `${origin}/chromasdk` })); return; }
    if (closing && req.url === "/chromasdk/chromalink") { setTimeout(() => { clearDone = true; res.end('{"result":0}'); }, 1200); return; }
    if (req.method === "DELETE") deleteDone = true;
    res.end(JSON.stringify(req.url?.endsWith("heartbeat") ? { tick: 1 } : { result: 0 }));
  });
  await new Promise<void>(resolve => chroma.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(chroma.address() as { port: number }).port}`;
  cleanup.push(async () => { chroma.closeAllConnections(); await new Promise<void>(resolve => chroma.close(() => resolve())); });
  await tb.roots.ambient.close();
  const ambient = new AmbientController(tb.roots.store, tb.roots.bus, () => "unknown", { setState: () => {} }, options => new ChromaOutput({ ...options, baseUrl: `${origin}/razer/chromasdk` }));
  Object.defineProperty(tb.roots, "ambient", { value: ambient });
  ambient.configure({ enabled: true, outputs: { log: { enabled: false }, chroma: { enabled: true, animation: false, devices: ["chromalink"] } } });
  await until(() => ambient.status().chroma.phase === "ready", 5000, 5);
  const before = trust.all(); closing = true;
  const started = Date.now(); const done = tb.roots.close(); expect(tb.roots.store.db.open).toBe(false);
  const writes = vi.spyOn(tb.roots.store, "setMeta");
  lateResponse!.end(JSON.stringify({ model: "fake-laya", answers: { "late-shadow": { type: "noul", noul: 0.1 } } }));
  await done;
  expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
  expect(clearDone && deleteDone).toBe(true);
  expect(records.mock.calls.some(([q]) => q === "late-shadow")).toBe(true);
  expect(trust.get("late-shadow").n).toBe(0); expect(writes).not.toHaveBeenCalled();
  const reopened = new Store(path.join(tb.roots.home, "data"));
  try { expect(reopened.trustStore().all()).toEqual(before); } finally { reopened.close(); }
}, 20_000);
