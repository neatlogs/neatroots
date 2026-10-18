import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { parseChecks } from "../src/checks/registry.js";
import { batch, hex, makeRoots, span, tmpHome } from "./helpers.js";
const exec = promisify(execFile);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const addCheck = (s: Store, id = "metric-case") => s.upsertCheckRow({ id, kind: "rule", source: "user", path: null, body: "test" });
const columns = (s: Store, table: string) => (s.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((x) => x.name);
function legacy(s: Store) {
  s.db.prepare("UPDATE checks SET hits=30, dismissed=14 WHERE id='metric-case'").run();
  if (columns(s, "checks").includes("metric_basis")) s.db.prepare("UPDATE checks SET metric_basis='legacy_mixed' WHERE id='metric-case'").run();
}
for (const pre341 of [true, false]) it(`preserves ${pre341 ? "pre341" : "341"} legacy totals without certifying their basis`, () => {
  const home = tmpHome(); let store = new Store(home);
  cleanup.push(() => { if (store.db.open) store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  addCheck(store); legacy(store);
  if (columns(store, "checks").includes("metric_basis")) store.db.exec("ALTER TABLE checks DROP COLUMN metric_basis");
  if (pre341) {
    store.db.exec("ALTER TABLE findings DROP COLUMN metric_counted; ALTER TABLE findings DROP COLUMN metric_generation; ALTER TABLE checks DROP COLUMN metric_generation");
  }
  store.close(); store = new Store(home);
  expect(store.checkStats()["metric-case"]).toMatchObject({ hits: 30, dismissed: 14, basis: "legacy_mixed" });
  addCheck(store); store.setCheckEnabled("metric-case", false); store.setCheckEnabled("metric-case", true);
  store.close(); store = new Store(home);
  expect(store.checkStats()["metric-case"]).toMatchObject({ hits: 30, dismissed: 14, basis: "legacy_mixed" });
});
it("keeps a new check's actionable basis through edits, status cycles and retention", () => {
  const home = tmpHome(); const s = new Store(home);
  cleanup.push(() => { s.close(); fs.rmSync(home, { recursive: true, force: true }); });
  addCheck(s); const t = hex(16); s.ingest([batch([span({ traceId: t, name: "root", kind: "workflow" })])]);
  const insert = (status: "raised" | "failed" | "quiet") => s.insertFinding({ trace_id: t, check_id: "metric-case", check_kind: "rule", title: "test", probability: null, status, evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  const first = insert("raised"); s.updateFinding(first.id, { status: "dismissed" }); s.updateFinding(first.id, { status: "raised" }); s.updateFinding(first.id, { status: "dismissed" });
  for (let i=1; i<20; i++) { const f=insert("raised"); if (i<14) s.updateFinding(f.id, { status: "dismissed" }); }
  for (let i=0; i<10; i++) insert(i%2 ? "failed" : "quiet");
  addCheck(s); s.setCheckEnabled("metric-case", false); s.setCheckEnabled("metric-case", true);
  expect(s.checkStats()["metric-case"]).toMatchObject({ hits: 20, dismissed: 14, basis: "actionable_v1" });
  s.deleteRun(t);
  expect(s.checkStats()["metric-case"]).toMatchObject({ hits: 20, dismissed: 14, basis: "actionable_v1" });
});
it("isolates the basis and counters of a re-added check from old findings", () => {
  const home=tmpHome();const s=new Store(home);cleanup.push(()=>{s.close();fs.rmSync(home,{recursive:true,force:true});});
  addCheck(s);legacy(s);
  const f=s.insertFinding({trace_id:hex(16),check_id:"metric-case",check_kind:"rule",title:"old",probability:null,status:"raised",evidence_span_ids:[],detail:{},model:null,triage_score:null,explanation_id:null});
  s.db.prepare("DELETE FROM checks WHERE id='metric-case'").run();addCheck(s);
  s.updateFinding(f.id,{status:"dismissed"});
  expect(s.checkStats()["metric-case"]).toMatchObject({hits:0,dismissed:0,basis:"actionable_v1"});
});
async function servedLegacy() {
 const t=await makeRoots({serve:true,noEngine:true});cleanup.push(t.close);
 t.roots.checks.save(parseChecks("id: metric-case\nkind: rule\nrule: {type: count, at_least: 1}\n").checks[0],"user");legacy(t.roots.store);return t;
}
it("exposes legacy uncertainty and fresh noisy metrics through the real API", async () => {
 const t=await servedLegacy();
 const read=async()=>((await(await fetch(t.url+"/api/checks")).json()).checks as {id:string;precision:unknown}[]).find(c=>c.id==="metric-case")!.precision;
 expect(await read()).toMatchObject({hits:30,dismissed:14,precision:null,noisy:false,basis:"legacy_mixed",assessment_known:false});
 t.roots.store.db.prepare("UPDATE checks SET metric_basis='actionable_v1', hits=20, dismissed=14 WHERE id='metric-case'").run();
 expect(await read()).toMatchObject({hits:20,dismissed:14,precision:expect.closeTo(0.3),noisy:true,basis:"actionable_v1",assessment_known:true});
});
it("CLI labels legacy totals instead of printing a kept percentage", async () => {
 const t=await servedLegacy();
 const result=await exec(process.execPath,["--import","tsx","src/cli.ts","checks","list","--port",String(t.roots.config.port)],{env:{...process.env,NEATROOTS_HOME:t.roots.home},timeout:15000});
 const line=result.stdout.split("\n").find(x=>x.includes("metric-case"))!;
 expect(line).toContain("30 historical records");expect(line).toContain("kept rate unavailable");expect(line).toContain("Noisy assessment unknown");expect(line).not.toMatch(/53%|precision 53/);
});
