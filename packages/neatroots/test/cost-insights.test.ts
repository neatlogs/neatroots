import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { computeInsights } from "../src/store/insights.js";
import { runCost } from "../src/store/costs.js";
import * as costs from "../src/store/costs.js";
import { runDetail } from "../src/server/api.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { batch, closeTrackedStores, hex, makeRoots, s, span, tmpHome, trackedStore } from "./helpers.js";
const homes: string[] = [];
afterEach(() => { closeTrackedStores(); for (const h of homes.splice(0)) fs.rmSync(h, {recursive:true, force:true}); });
function call(traceId: string, model = "gpt-4.1-mini", kind = "llm") {
  return span({ traceId, name: "call", kind, attrs: [s("neatlogs.llm.model_name", model), s("neatlogs.llm.provider", "openai"), s("neatlogs.llm.token_count.prompt", 1000), s("neatlogs.llm.token_count.completion", 100)] });
}
it("derives the same costs across run, model, project and period without changing storage", () => {
  const home=tmpHome(); homes.push(home); const st=trackedStore(path.join(home,"data"));
  const schema=st.db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
  const a=hex(16), b=hex(16), old=hex(16);
  st.ingest([batch([call(a),call(a,"unknown"),call(a,"gpt-4.1-mini","agent")],"A"),batch([call(b)],"B"),batch([call(old)],"old")]);
  st.db.prepare("UPDATE runs SET started_ms=? WHERE trace_id=?").run(Date.now()-10*86400000,old);
  const raw=st.db.prepare("SELECT attributes,total_tokens FROM spans").all();
  const i=computeInsights(st.db,"7d",[]);
  expect(i.totals.cost_usd).toBeCloseTo(.00112); expect(i.totals.unpriced_calls).toBe(1);
  expect(i.projects.reduce((s,p)=>s+(p.cost_usd??0),0)).toBeCloseTo(i.totals.cost_usd!);
  expect(i.models.reduce((s,p)=>s+(p.cost_usd??0),0)).toBeCloseTo(i.totals.cost_usd!);
  expect(runCost(st.db,a)).toMatchObject({ cost_usd:.00056, unpriced_calls:1, priced_calls:1 });
  expect(computeInsights(st.db,"30d",[]).totals.cost_usd).toBeCloseTo(.00168);
  const override=[{provider:"openai",model:"gpt-4.1-mini",input:1,output:2,inputMode:"includes-cache" as const}];
  expect(runCost(st.db,a,override).cost_usd).toBeCloseTo(.0012);
  expect(st.db.prepare("SELECT attributes,total_tokens FROM spans").all()).toEqual(raw);
  expect(st.db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all()).toEqual(schema);
});
it("includes all selected rows beyond the old insights page cap", () => {
  const home=tmpHome();homes.push(home);const st=trackedStore(path.join(home,"data"));const a=hex(16);st.ingest([batch([call(a)],"A")]);
  const r=st.db.prepare("SELECT * FROM runs WHERE trace_id=?").get(a) as Record<string,unknown>;
  const keys=Object.keys(r); const insert=st.db.prepare(`INSERT INTO runs (${keys.join(',')}) VALUES (${keys.map(k=>'@'+k).join(',')})`);
  st.db.transaction(()=>{ for(let i=0;i<20001;i++) insert.run({...r,trace_id:`extra${i}`}); })();
  const result=computeInsights(st.db,"7d",[]);expect(result.totals.runs).toBe(20002);expect(result.totals.cost_usd).toBeCloseTo(.00056);
});
it("serializes per-run API cost and validates persisted local overrides", async () => {
  const t=await makeRoots({noEngine:true, serve:true});
  try {
    const id=hex(16);t.roots.store.ingest([batch([call(id)])]);
    expect(runDetail(t.roots,id)?.run.cost.cost_usd).toBeCloseTo(.00056);
    t.roots.config.pricing.overrides=[{provider:"openai",model:"gpt-4.1-mini",input:1,output:2,inputMode:"includes-cache"}];
    const run=await (await fetch(`${t.url}/api/runs/${id}`)).json();
    const insights=await (await fetch(`${t.url}/api/insights?window=7d`)).json();
    expect(run.run.cost.cost_usd).toBeCloseTo(.0012);
    expect(insights.totals.cost_usd).toBe(run.run.cost.cost_usd);
    expect(insights.projects[0].cost_usd).toBe(run.run.cost.cost_usd);
    expect(insights.models[0].cost_usd).toBe(run.run.cost.cost_usd);
  }
  finally { await t.close(); }
  const home=tmpHome();homes.push(home);const previous=process.env.NEATROOTS_HOME;process.env.NEATROOTS_HOME=home;
  try { const c=defaultConfig();c.pricing.overrides=[{provider:"local",model:"model",input:2,output:3,inputMode:"includes-cache"}];saveConfig(c);expect(loadConfig().pricing).toEqual(c.pricing);
    c.pricing.overrides[0].input=-1;expect(()=>saveConfig(c)).toThrow();
  } finally {if (previous === undefined) delete process.env.NEATROOTS_HOME; else process.env.NEATROOTS_HOME=previous;}
});

it("keeps missing-LLM-usage runs visible in mixed projects and periods", () => {
  const home=tmpHome();homes.push(home);const st=trackedStore(path.join(home,"data"));
  const priced=hex(16), missing=hex(16), other=hex(16);
  st.ingest([batch([call(priced)],"A"),batch([call(missing,"gpt-4.1-mini","agent")],"A"),batch([call(other,"gpt-4.1-mini","agent")],"B")]);
  expect(runCost(st.db,missing)).toMatchObject({cost_usd:null, missing_usage_runs:1, unpriced_calls:0});
  let i=computeInsights(st.db,"7d",[]);
  expect(i.totals).toMatchObject({missing_usage_runs:2, unpriced_calls:0});
  expect(i.projects.find(p=>p.name==="A")).toMatchObject({missing_usage_runs:1, cost_usd:.00056});
  expect(i.projects.find(p=>p.name==="B")).toMatchObject({missing_usage_runs:1, cost_usd:null});
  st.db.prepare("UPDATE runs SET started_ms=? WHERE trace_id=?").run(Date.now()-10*86400000,other);
  i=computeInsights(st.db,"7d",[]);expect(i.totals.missing_usage_runs).toBe(1);
});


it("prices only the current window and preserves cost-free previous metrics", () => {
  const home=tmpHome();homes.push(home);const st=trackedStore(path.join(home,"data"));
  const current=hex(16), previous=hex(16), now=Date.now();
  st.ingest([batch([call(current)],"A"),batch([call(previous)],"A")]);
  const start=now-10*86400000;
  st.db.prepare("UPDATE runs SET started_ms=?, ended_ms=?, status='error' WHERE trace_id=?").run(start,start+1234,previous);
  st.insertFinding({trace_id:previous,check_id:"previous-problem",check_kind:"question",title:"Previous problem",status:"raised",probability:.9,evidence_span_ids:[],detail:{},model:null,triage_score:3,explanation_id:null});
  const row=st.db.prepare("SELECT attributes FROM spans WHERE trace_id=?").get(previous) as {attributes:string};
  const previousRaw=JSON.stringify([...JSON.parse(row.attributes),s("review.previous.only","sentinel")]);
  st.db.prepare("UPDATE spans SET attributes=? WHERE trace_id=?").run(previousRaw,previous);
  const price=vi.spyOn(costs,"readCosts"), parse=vi.spyOn(JSON,"parse");
  try {
    const result=computeInsights(st.db,"7d",[],now);
    expect(price).toHaveBeenCalledTimes(1);
    expect(price.mock.calls[0][2]).toEqual({from:now-7*86400000,to:now+5*60000});
    expect(parse.mock.calls.some(([raw])=>raw===previousRaw)).toBe(false);
    expect(result.totals.cost_usd).toBeCloseTo(.00056);
    expect(result.previous).toEqual({runs:1,failed:1,with_problems:1,tokens:1100,llm_calls:1,tool_calls:0,p50_ms:1234,p95_ms:1234});
  } finally {price.mockRestore();parse.mockRestore();}
});
