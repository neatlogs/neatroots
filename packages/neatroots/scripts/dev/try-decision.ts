import { defaultConfig } from "../../src/config.js";
import { LlmClient } from "../../src/models/llm.js";
import { DecisionModel } from "../../src/models/decision.js";

const cfg = defaultConfig();
cfg.classifier.backend = "llm";
const llm = new LlmClient(cfg.llm);
console.log(await llm.probe(true));
const dm = new DecisionModel(cfg.classifier, llm);
const state = `Span s7 TOOL lookup_order input {"order_id":"4512"} → ERROR 404 order not found
Span s9 TOOL lookup_order input {"order_id":"4512"} → ERROR 404 order not found
Span s11 TOOL lookup_order input {"order_id":"4512"} → ERROR 404 order not found`;
const r = await dm.decide(state, [
  { name: "repeat", type: "yes_no", ask: "Did the agent repeat the same tool call without getting new information?" },
  { name: "refund", type: "yes_no", ask: "Did the agent issue a refund?" },
  { name: "label", type: "choice", ask: "How did the last tool call end?", options: { success: "returned useful data", empty: "returned nothing", error: "failed or returned an error", partial: "returned incomplete data" } },
  { name: "triage", type: "score", ask: "How much does this run need a closer look?", levels: ["fine", "minor", "worth a look", "likely broken", "clearly broken"] },
]);
console.log(JSON.stringify(r, null, 1));
