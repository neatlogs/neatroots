// Dev aid: tool-result labeling (choice) on Laya vs the LLM.
import { rootsHome, loadConfig } from "../../src/config.js";
import { LlmClient } from "../../src/models/llm.js";
import { DecisionModel } from "../../src/models/decision.js";
import { LayaManager } from "../../src/models/laya.js";

const options = { success: "it returned the data that was asked for", empty: "it returned nothing useful or an empty result", error: "it failed or returned an error message", partial: "it returned only part of what was asked for" };
const cases = [
  { label: "error", ev: `[t1] TOOL lookup_order status=OK\n  input: {"order_id":"4512"}\n  output: {"message":"Order not found","code":404}` },
  { label: "success", ev: `[t2] TOOL lookup_order status=OK\n  input: {"order_id":"1001"}\n  output: {"order_id":"1001","owner":"cust_9","amount":42}` },
  { label: "empty", ev: `[t3] TOOL search_docs status=OK\n  input: {"q":"refund policy"}\n  output: {"results":[],"total":0}` },
  { label: "error", ev: `[t4] TOOL fetch_url status=OK\n  input: {"url":"https://x"}\n  output: "Error: connection refused"` },
  { label: "partial", ev: `[t5] TOOL get_orders status=OK\n  input: {"ids":["1","2","3"]}\n  output: {"orders":[{"id":"1"}],"failed":["2","3"]}` },
  { label: "success", ev: `[t6] TOOL weather status=OK\n  input: {"city":"Paris"}\n  output: {"temp_c":18,"conditions":"cloudy"}` },
];
const cfg = loadConfig();
const laya = new LayaManager(rootsHome(), cfg.classifier);
const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm), { laya: async () => laya.token, jevCloud: async () => undefined });
for (const [name, b] of [["laya", dm.laya], ["llm", dm.llmBackend]] as const) {
  let ok = 0;
  const rows: string[] = [];
  for (const c of cases) {
    const r = await b.decide(c.ev, [{ name: "q", type: "choice", ask: "How did this tool call end?", options }]);
    const a = r.answers.q;
    if (a.choice === c.label) ok++;
    rows.push(`  ${a.choice === c.label ? "✓" : "✗"} want ${c.label.padEnd(8)} got ${String(a.choice).padEnd(8)} p=${a.probability.toFixed(2)} ${r.latencyMs}ms`);
  }
  console.log(`${name}: ${ok}/${cases.length}`);
  console.log(rows.join("\n"));
}
