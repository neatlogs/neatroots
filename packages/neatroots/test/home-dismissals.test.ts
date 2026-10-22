import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { newFindingStatus } from "../src/engine/findings.js";
import type { FindingStatus } from "../src/types.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let tb: TestRoots;
let app: ReturnType<typeof createApp>;
let clock: number;
beforeEach(async () => {
  tb = await makeRoots({ noEngine: true });
  app = createApp(tb.roots);
  clock = Date.now() - 10000;
});
afterEach(async () => { await tb?.close(); });

function finding(project: string, status: FindingStatus = "raised", checkId = "noise") {
  const traceId = hex(16);
  tb.roots.store.ingest([batch([span({ traceId, name: "agent", kind: "workflow" })], project)]);
  const f = tb.roots.store.insertFinding({ trace_id: traceId, check_id: checkId, title: "Noisy check", check_kind: "rule", status,
    probability: null, evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  tb.roots.store.db.prepare("UPDATE findings SET created_ms = ? WHERE id = ?").run(++clock, f.id);
  return f;
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`http://localhost${path}`, { ...init, headers: { host: "localhost", ...init.headers } });
}

function dismiss(id: string, project = "alpha", check = "noise") {
  return request("/api/insights/dismiss", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ finding_id: id, project, check_id: check }) });
}

async function insights() { return (await request("/api/insights?window=24h")).json(); }

describe("Home project dismissal", () => {
  it("targets the newest open finding per project and uses lifetime dismissal progress", async () => {
    const historical = finding("alpha", "dismissed");
    tb.roots.store.db.prepare("UPDATE runs SET started_ms = ? WHERE trace_id = ?").run(Date.now() - 40 * 86400000, historical.trace_id);
    const older = finding("alpha");
    const newest = finding("alpha", "active");
    finding("alpha", "dismissed"); // Latest finding overall is already dismissed.
    finding("alpha", "quiet");
    finding("alpha", "resolved");
    finding("alpha", "failed");
    const beta = finding("beta");
    const i = await insights();
    expect(i.quiet_after).toBe(3);
    expect(i.problems[0].dismissal_projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ project: "alpha", dismissed: 2, newest_finding_id: newest.id }),
      expect.objectContaining({ project: "beta", dismissed: 0, newest_finding_id: beta.id }),
    ]));
    const res = await dismiss(newest.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ finding_id: newest.id, dismissed: 3 });
    expect(tb.roots.store.getFinding(older.id)?.status).toBe("raised");
    expect(tb.roots.store.getFinding(beta.id)?.status).toBe("raised");
    expect(newFindingStatus(tb.roots.store, "noise", "alpha")).toBe("quiet");
    expect(newFindingStatus(tb.roots.store, "noise", "beta")).toBe("raised");
  });

  it("retries the exact dismissed identity without advancing to the next finding", async () => {
    const older = finding("alpha");
    const newest = finding("alpha");
    const results = await Promise.all([dismiss(newest.id), dismiss(newest.id), dismiss(newest.id)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(tb.roots.store.dismissalsIn("noise", "alpha")).toBe(1);
    expect(tb.roots.store.getFinding(older.id)?.status).toBe("raised");
    expect((await insights()).problems[0].dismissal_projects[0].newest_finding_id).toBe(older.id);
  });

  it("withdraws only this finding's pending notes and preserves the run-level controls", async () => {
    const target = finding("alpha");
    const other = finding("beta");
    const note = (f: typeof target) => tb.roots.store.insertNote({ trace_id: f.trace_id, finding_id: f.id, kind: "template", text: "Check this", status: "pending", checks: null });
    const targetNote = note(target);
    const otherNote = note(other);
    expect((await dismiss(target.id)).status).toBe(200);
    expect(tb.roots.store.getNote(targetNote.id)?.status).toBe("expired");
    expect(tb.roots.store.getNote(otherNote.id)?.status).toBe("pending");
    expect(tb.roots.store.getRun(target.trace_id)?.open_finding_count).toBe(0);
    const reopen = await request(`/api/findings/${target.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "raised" }) });
    expect(reopen.status).toBe(200);
    expect(tb.roots.store.dismissalsIn("noise", "alpha")).toBe(0);
    expect(tb.roots.store.getRun(target.trace_id)?.open_finding_count).toBe(1);
  });

  it("rejects a stale newest target and a target that resolved while the request was in flight", async () => {
    const old = finding("alpha");
    expect((await insights()).problems[0].dismissal_projects[0].newest_finding_id).toBe(old.id);
    const current = finding("alpha");
    expect((await dismiss(old.id)).status).toBe(409);
    tb.roots.store.setFindingStatus(current.id, "resolved");
    expect((await dismiss(current.id)).status).toBe(409);
    expect(tb.roots.store.dismissalsIn("noise", "alpha")).toBe(0);
    expect(tb.roots.store.getFinding(old.id)?.status).toBe("raised");
    expect((await dismiss(old.id)).status).toBe(200);
  });

  it("never crosses project/check identities, including on idempotent retries", async () => {
    const beta = finding("beta");
    expect((await dismiss(beta.id)).status).toBe(409);
    expect((await dismiss(beta.id, "beta", "other")).status).toBe(409);
    expect(tb.roots.store.getFinding(beta.id)?.status).toBe("raised");
    expect((await dismiss(beta.id, "beta")).status).toBe(200);
    expect((await dismiss(beta.id)).status).toBe(409);
    expect(tb.roots.store.dismissalsIn("noise", "alpha")).toBe(0);
  });

  it("handles empty, missing and non-open targets without dismissing anything else", async () => {
    expect((await insights()).problems).toEqual([]);
    expect((await dismiss("missing")).status).toBe(404);
    const resolved = finding("alpha", "resolved");
    expect((await insights()).problems[0].dismissal_projects[0].newest_finding_id).toBeNull();
    expect((await dismiss(resolved.id)).status).toBe(409);
    const response = await request("/api/insights/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ finding_id: resolved.id, project: 42, check_id: "noise" }) });
    expect(response.status).toBe(400);
    expect(tb.roots.store.getFinding(resolved.id)?.status).toBe("resolved");
  });

  it("does not mistake a missing project for a real project named unknown, or target doctor findings", async () => {
    const legacy = finding("legacy");
    tb.roots.store.db.prepare("UPDATE runs SET project = NULL, workflow = 'unknown' WHERE trace_id = ?").run(legacy.trace_id);
    const real = finding("unknown");
    const doctor = finding("unknown");
    tb.roots.store.db.prepare("UPDATE runs SET doctor = 1 WHERE trace_id = ?").run(doctor.trace_id);
    const rows = (await insights()).problems[0].dismissal_projects;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ project: null, newest_finding_id: null }),
      expect.objectContaining({ project: "unknown", newest_finding_id: real.id }),
    ]));
    expect((await dismiss(legacy.id, "unknown")).status).toBe(409);
    expect((await dismiss(doctor.id, "unknown")).status).toBe(409);
    expect((await dismiss(real.id, "unknown")).status).toBe(200);
  });
});
