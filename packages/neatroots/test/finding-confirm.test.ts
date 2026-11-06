import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { batch, closeTrackedStores, hex, makeRoots, span, tmpHome, type TestRoots } from "./helpers.js";

// Confirming a finding is real: with dismissals, it gives a check's accuracy over the findings someone reviewed.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  closeTrackedStores();
});

const CHECK = "repeated-tool-call";

async function setup() {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(() => tb.close());
  return tb;
}

function finding(tb: TestRoots, status: "raised" | "dismissed" | "failed" = "raised") {
  const t = hex(16);
  tb.roots.ingest([batch([span({ traceId: t, name: "agent", kind: "workflow" })])]);
  return tb.roots.store.insertFinding({ trace_id: t, check_id: CHECK, check_kind: "rule", title: "Same tool called repeatedly", probability: null, status, evidence_span_ids: [], detail: {}, model: null, triage_score: 2, explanation_id: null });
}

function post(tb: TestRoots, id: string, body: unknown) {
  return fetch(`${tb.url}/api/findings/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: tb.url.replace("127.0.0.1", "localhost") },
    body: JSON.stringify(body),
  });
}

describe("confirming a finding", () => {
  it("counts once toward the check's accuracy and can be taken back", async () => {
    const tb = await setup();
    const a = finding(tb);
    const b = finding(tb);
    const c = finding(tb);
    tb.roots.store.confirmFinding(a.id, true);
    tb.roots.store.confirmFinding(a.id, true); // a second confirm of the same finding is not a second vote
    tb.roots.store.confirmFinding(b.id, true);
    tb.roots.store.updateFinding(c.id, { status: "dismissed" });
    expect(tb.roots.checks.precision(CHECK)).toMatchObject({ hits: 3, confirmed: 2, dismissed: 1 });
    expect(tb.roots.checks.precision(CHECK).accuracy).toBeCloseTo(2 / 3);
    expect(tb.roots.store.getFinding(a.id)!.confirmed_ms).toBeGreaterThan(0);

    tb.roots.store.confirmFinding(b.id, false);
    expect(tb.roots.checks.precision(CHECK)).toMatchObject({ confirmed: 1, dismissed: 1, accuracy: 0.5 });
    expect(tb.roots.store.getFinding(b.id)!.confirmed_ms).toBeNull();
  });

  it("is taken back when the finding is dismissed, so one finding never counts both ways", async () => {
    const tb = await setup();
    const f = finding(tb);
    tb.roots.store.confirmFinding(f.id, true);
    const after = tb.roots.store.updateFinding(f.id, { status: "dismissed" })!;
    expect(after.confirmed_ms).toBeNull();
    expect(tb.roots.store.getFinding(f.id)!.confirmed_ms).toBeNull();
    expect(tb.roots.checks.precision(CHECK)).toMatchObject({ confirmed: 0, dismissed: 1, accuracy: 0 });
  });

  it("has no accuracy until someone reviews a finding", async () => {
    const tb = await setup();
    finding(tb);
    expect(tb.roots.checks.precision(CHECK)).toMatchObject({ hits: 1, confirmed: 0, accuracy: null, precision: 1 });
  });

  it("is set over the API and shows on the run's findings", async () => {
    const tb = await setup();
    const f = finding(tb);
    const r = await post(tb, f.id, { confirmed: true });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { confirmed_ms: number | null }).confirmed_ms).toBeGreaterThan(0);
    const detail = (await (await fetch(`${tb.url}/api/runs/${f.trace_id}`, { headers: { origin: tb.url.replace("127.0.0.1", "localhost") } })).json()) as {
      findings: { id: string; confirmed_ms: number | null; precision: { confirmed: number; accuracy: number | null } }[];
    };
    const shown = detail.findings.find((x) => x.id === f.id)!;
    expect(shown.confirmed_ms).toBeGreaterThan(0);
    expect(shown.precision).toMatchObject({ confirmed: 1, accuracy: 1 });

    expect((await post(tb, f.id, { confirmed: false })).status).toBe(200);
    expect(tb.roots.store.getFinding(f.id)!.confirmed_ms).toBeNull();
  });

  it("is refused for a dismissed or failed finding, a missing one and a bad body", async () => {
    const tb = await setup();
    const dismissed = finding(tb, "dismissed");
    const failed = finding(tb, "failed");
    const open = finding(tb);
    expect((await post(tb, dismissed.id, { confirmed: true })).status).toBe(409);
    expect((await post(tb, failed.id, { confirmed: true })).status).toBe(409);
    expect((await post(tb, "fnd_missing", { confirmed: true })).status).toBe(404);
    expect((await post(tb, open.id, { confirmed: "yes" })).status).toBe(400);
    expect((await post(tb, open.id, { confirmed: true, status: "dismissed" })).status).toBe(400);
    expect(tb.roots.checks.precision(CHECK).confirmed).toBe(0);
    // Taking back a confirmation the finding never had is a no-op, not an error.
    expect((await post(tb, dismissed.id, { confirmed: false })).status).toBe(200);
  });
});

describe("a store from before confirmations", () => {
  it("gains the column on open and keeps its findings", () => {
    const home = tmpHome();
    const dir = path.join(home, "data");
    fs.mkdirSync(dir, { recursive: true });
    const st = new Store(dir);
    const file = st.file;
    st.close();
    // Shape the findings table the way older versions wrote it.
    const db = new Database(file);
    db.exec("ALTER TABLE findings DROP COLUMN confirmed_ms");
    db.prepare(
      "INSERT INTO findings (id, trace_id, check_id, check_kind, title, probability, status, evidence_span_ids, detail, model, triage_score, explanation_id, created_ms, updated_ms) VALUES ('fnd_old', 't', 'c', 'rule', 'old', NULL, 'raised', '[]', '{}', NULL, NULL, NULL, 1, 1)",
    ).run();
    db.close();
    const reopened = new Store(dir);
    cleanup.push(() => {
      reopened.close();
      fs.rmSync(home, { recursive: true, force: true });
    });
    expect(reopened.getFinding("fnd_old")).toMatchObject({ title: "old", confirmed_ms: null });
  });
});
