# typescript-openai

The support agent on the OpenAI Node SDK, traced with the Neatlogs TypeScript SDK (`wrapOpenAI`, `span`).

```bash
npm install
npm start -- "Please refund order 1001"
```

Runs against neatroots' mock LLM (`neatroots mock-llm`); `REAL_LLM=1` uses your `OPENAI_API_KEY`.
