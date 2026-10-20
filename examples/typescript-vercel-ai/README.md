# typescript-vercel-ai

A Vercel AI SDK `generateText` agent with a tool, traced with the Neatlogs TypeScript SDK (`wrapAISDK`).

```bash
npm install
npm start -- "What's the weather in Berlin?"
```

Runs against neatroots' mock LLM (`neatroots mock-llm`); `REAL_LLM=1` uses your `OPENAI_API_KEY`.
