import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { batch, hex, makeRoots, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });
const mockForward = () => vi.spyOn(t!.roots.relay, "forward").mockResolvedValue({ id: "mock", trace_ids: [],
  endpoint: "http://127.0.0.1", status: "ok", http_status: 200, span_count: 0, bytes: 0,
  redactions: 0, error: null, initiated_by: "auto", created_ms: 0 });

// Deliberately uses only APIs available on the base revision: fails there by forwarding the file.
it("never auto-forwards an OTLP file imported into a forward-enabled project", async () => {
  t = await makeRoots({ noEngine: true, config: (c) => { c.projects["test-agent"] = { forward: true }; } });
  const forwarding = mockForward();
  const traceId = hex(16); const source = batch([span({ traceId, name: "imported", kind: "workflow" })]);
  const response = await createApp(t.roots).request(`http://localhost:${t.roots.config.port}/api/imports/file`, {
    method: "POST", headers: { host: `localhost:${t.roots.config.port}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "trace.json", content: JSON.stringify({ resourceSpans: [{ resource: source.resource, scopeSpans: [{ scope: source.scope, spans: source.spans }] }] }) }),
  });
  expect(response.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 1800));
  expect(forwarding).not.toHaveBeenCalled();
  expect(t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM forwards").get()).toEqual({ n: 0 });
  expect(t.roots.store.getMeta(`import-source:${traceId}`)).toBe("file");
  t.roots.store.deleteRun(traceId);
  expect(t.roots.store.getMeta(`import-source:${traceId}`)).toBeUndefined();
});

it("re-derives findings when a just-deleted run is imported again in the same server", async () => {
  t = await makeRoots();
  const traceId = hex(16); const source = batch([span({ traceId, name: "failed run", kind: "workflow", status: 2 })]);
  t.roots.ingest([source]);
  await until(() => t!.roots.store.findingsForTrace(traceId).length > 0);
  expect(await t.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
  const before = t.roots.store.findingsForTrace(traceId);
  t.roots.store.deleteRun(traceId);
  const response = await createApp(t.roots).request(`http://localhost:${t.roots.config.port}/api/imports/file`, {
    method: "POST", headers: { host: `localhost:${t.roots.config.port}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "trace.json", content: JSON.stringify({ resourceSpans: [{ resource: source.resource, scopeSpans: [{ scope: source.scope, spans: source.spans }] }] }) }),
  });
  expect(response.ok).toBe(true);
  await until(() => t!.roots.store.findingsForTrace(traceId).some((f) =>
    f.check_id === "run-failed" && before.every((previous) => previous.id !== f.id)));
  const after = t.roots.store.findingsForTrace(traceId);
  expect(after.some((f) => f.check_id === "run-failed")).toBe(true);
  expect(after.every((f) => before.every((previous) => previous.id !== f.id))).toBe(true);
});

it("preserves ordinary live-run automatic forwarding", async () => {
  t = await makeRoots({ noEngine: true, config: (c) => { c.projects["test-agent"] = { forward: true }; } });
  const forwarding = mockForward();
  const traceId = hex(16);
  t.roots.ingest([batch([span({ traceId, name: "live", kind: "workflow" })])]);
  await until(() => forwarding.mock.calls.length > 0);
  expect(forwarding).toHaveBeenCalledExactlyOnceWith([traceId], "auto");
});
