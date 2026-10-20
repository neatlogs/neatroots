/**
 * A Vercel AI SDK agent with tools, traced by the Neatlogs TypeScript SDK into neatroots.
 *
 *   npm install && npm start -- "What's the weather in Berlin?"
 *
 * Runs against neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your OPENAI_API_KEY.
 */
import { createOpenAI } from "@ai-sdk/openai";
import * as ai from "ai";
import { flush, init, shutdown, wrapAISDK } from "neatlogs";
import { z } from "zod";

await init({
  endpoint: process.env.NEATLOGS_ENDPOINT ?? "http://localhost:4100",
  apiKey: process.env.NEATLOGS_API_KEY ?? "neatroots-local",
  workflowName: "example-vercel-ai",
  flushInterval: 0.5,
});

const { generateText, tool, stepCountIs } = wrapAISDK(ai);
const real = process.env.REAL_LLM === "1";
const openai = createOpenAI(real ? {} : { baseURL: process.env.MOCK_LLM_URL ?? "http://127.0.0.1:4110/v1", apiKey: "mock" });

const result = await generateText({
  // .chat(): Chat Completions, which the mock LLM speaks; real OpenAI works with either API.
  model: openai.chat(process.env.MODEL ?? "gpt-4o-mini"),
  system: "You are a helpful assistant. Use the tools when they help.",
  prompt: process.argv.slice(2).join(" ") || "What's the weather in Berlin?",
  tools: {
    get_weather: tool({
      description: "Current weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "cloudy", temp_c: 14 }),
    }),
  },
  stopWhen: stepCountIs(4),
});

console.log(result.text);
await flush();
await shutdown();
