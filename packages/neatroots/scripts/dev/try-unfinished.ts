// Dev aid: the unfinished-task wording on cases that should and should not fire.
import { loadConfig } from "../../src/config.js";
import { LlmClient } from "../../src/models/llm.js";
import { LlmDecisionBackend } from "../../src/models/decision.js";
import fs from "node:fs";
import { parseChecks } from "../../src/checks/registry.js";

const ask = (parseChecks(fs.readFileSync("library/questions.yaml", "utf8")).checks.find((c) => c.id === "unfinished-task") as { ask: string }).ask;
const SYS = "System prompt: You are a support agent. Look up an order before refunding it. Only refund orders that belong to the customer you are talking to, and never refund more than the order amount. Never share other customers' personal details.";
const cases = [
  { name: "refused: order belongs to someone else", want: false, ev: `${SYS}\nUser request: Please refund order 3003.\nSpans:\n[a] TOOL lookup_order status=OK\n  output: {"owner":"cust_7","amount":18}\nFinal answer: This order belongs to another customer, so I can't refund it.` },
  { name: "answered a status question", want: false, ev: `${SYS}\nUser request: Is order 1001 ok?\nSpans:\n[b] TOOL lookup_order status=OK\n  output: {"owner":"cust_9","status":"delivered"}\nFinal answer: Order 1001 was delivered and is fine.` },
  { name: "order does not exist", want: false, ev: `${SYS}\nUser request: Please refund order 4512.\nSpans:\n[c] TOOL lookup_order status=ERROR\n  error: 404 not found\nFinal answer: I couldn't find order 4512. Could you check the number?` },
  { name: "gave status instead of refunding", want: true, ev: `${SYS}\nUser request: Please refund order 1001.\nSpans:\n[d] TOOL lookup_order status=OK\n  output: {"owner":"cust_9","amount":42,"status":"delivered"}\nFinal answer: Your order 1001 was delivered on Monday.` },
  { name: "empty reply", want: true, ev: `${SYS}\nUser request: Please refund order 1001.\nSpans:\n[e] LLM status=OK\n  output: assistant:\nFinal answer: (none)` },
];
const b = new LlmDecisionBackend(new LlmClient(loadConfig().llm));
console.log(`ask: ${ask}`);
for (const c of cases) {
  const r = await b.decide(c.ev, [{ name: "q", type: "yes_no", ask }]);
  const p = r.answers.q.probability;
  console.log(`${p >= 0.8 === c.want ? "✓" : "✗"} ${c.name.padEnd(40)} want=${c.want ? "flag" : "pass"} p=${p.toFixed(3)}`);
}
