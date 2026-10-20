import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

it("custom exports and verification preserve the configured archive observation and snapshot", async () => {
  t = await makeRoots({ serve: true, noEngine: true, config: c => { c.audit.enabled = true; } });
  const roots = t.roots, id = hex(16), configured = roots.audit.directory();
  roots.store.ingest([batch([span({ traceId: id, name: "archived", kind: "workflow" })])]);
  const post = async (route: string, body: object) => {
    const response = await fetch(`${t!.url}/api/audit/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); return response.json();
  };
  await post("export", { trace_id: id });
  const before = roots.audit.status();
  expect(before.observation_state).toBe("current");
  const custom = path.join(roots.home, "custom-archive");
  await post("export", { trace_id: id, directory: custom });
  expect(await post("verify", { directory: custom })).toMatchObject({ ok: true });
  expect(roots.audit.status()).toEqual(before);
  roots.config.audit.directory = custom;
  expect(roots.audit.status()).toMatchObject({ observation_state: "current", archive_entries: 1, archive_totals_known: true });
  expect(await post("verify", { directory: path.join(roots.home, "missing") })).toMatchObject({ ok: false });
  expect(roots.audit.status().observation_state).toBe("current");
  roots.config.audit.directory = configured;
  expect(roots.audit.status()).toEqual(before);
});

it("bounds remembered directories and forgets evicted measurements without claiming integrity", async () => {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; } });
  const roots = t.roots, id = hex(16), configured = roots.audit.directory();
  roots.store.ingest([batch([span({ traceId: id, name: "archived", kind: "workflow" })])]);
  const { AuditArchive } = await import("../src/audit/archive.js");
  const archive = new AuditArchive(roots);
  archive.export(id, { directory: configured });
  for (let i = 0; i < 16; i++) archive.export(id, { directory: path.join(roots.home, `custom-${i}`) });
  expect(roots.audit.status()).toMatchObject({ observation_state: "unknown", archive_totals_known: false, verified: null });
  expect(roots.store.db.prepare("SELECT COUNT(*) AS n FROM audit_status_snapshots").get()).toEqual({ n: 16 });
  expect(() => roots.store.deleteRun(id)).toThrow(/audit hold/); // No engine can authorize this run.
});
