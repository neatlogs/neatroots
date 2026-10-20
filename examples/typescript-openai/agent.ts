/**
 * A support agent on the OpenAI Node SDK, traced by the Neatlogs TypeScript SDK into neatroots.
 *
 *   npm install && npm start -- "Please refund order 1001"
 *
 * Runs against neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your OPENAI_API_KEY.
 */
import { flush, init, shutdown, span, wrapOpenAI } from "neatlogs";
import OpenAI from "openai";

const real = process.env.REAL_LLM === "1";
await init({
  endpoint: process.env.NEATLOGS_ENDPOINT ?? "http://localhost:4100",
  apiKey: process.env.NEATLOGS_API_KEY ?? "neatroots-local",
  workflowName: "example-typescript-openai",
  flushInterval: 0.5,
});

const client = wrapOpenAI(new OpenAI(real ? {} : { baseURL: process.env.MOCK_LLM_URL ?? "http://127.0.0.1:4110/v1", apiKey: "mock" }));
const MODEL = process.env.MODEL ?? "gpt-4o-mini";
const ORDERS: Record<string, { order_id: string; amount: number; status: string }> = { "1001": { order_id: "1001", amount: 42, status: "delivered" } };

const lookupOrder = span({ kind: "TOOL", name: "lookup_order" }, (orderId: string) => {
  const order = ORDERS[orderId];
  if (!order) throw new Error(`404: order ${orderId} not found`);
  return order;
});
const issueRefund = span({ kind: "TOOL", name: "issue_refund" }, (orderId: string, amount: number) => ({ refunded: Math.min(amount, lookupOrder(orderId).amount), orderId }));

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: "function", function: { name: "lookup_order", description: "Look up an order by its id", parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } } },
  { type: "function", function: { name: "issue_refund", description: "Refund an order", parameters: { type: "object", properties: { order_id: { type: "string" }, amount: { type: "number" } }, required: ["order_id", "amount"] } } },
];

function call(name: string, args: Record<string, unknown>): string {
  try {
    return JSON.stringify(name === "lookup_order" ? lookupOrder(String(args.order_id)) : issueRefund(String(args.order_id), Number(args.amount)));
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

const run = span({ kind: "WORKFLOW", name: "support" }, async (request: string) => {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: "You are a support agent. Look up an order before refunding it." },
    { role: "user", content: request },
  ];
  for (let step = 0; step < 6; step++) {
    const reply = (await client.chat.completions.create({ model: MODEL, messages, tools })).choices[0].message;
    if (!reply.tool_calls?.length) return reply.content ?? "";
    messages.push(reply);
    for (const t of reply.tool_calls) {
      if (t.type !== "function") continue;
      messages.push({ role: "tool", tool_call_id: t.id, content: call(t.function.name, JSON.parse(t.function.arguments || "{}")) });
    }
  }
  return "Stopped after too many steps.";
});

console.log(await run(process.argv.slice(2).join(" ") || "Please refund order 1001"));
await flush();
await shutdown();
