# typescript-openai

The support agent on the OpenAI Node SDK, traced with the Neatlogs TypeScript SDK (`wrapOpenAI`, `span`).

```bash
npm install
npm start -- "Please refund order 1001"
```

Runs against neatroots' mock LLM (`neatroots mock-llm`); `REAL_LLM=1` uses your `OPENAI_API_KEY`.

## Optional steering and native response helpers

From a source checkout, run `pnpm install && pnpm build` at the repository root first.
Then install this example's pinned dependencies and run it:

```bash
npm ci
npm exec -- tsx steering.ts "Hello"
```

This example uses the mock provider only. Enable steering for `example-typescript-openai` in
neatroots to inject guidance. It passes the raw OpenAI client plus `{ telemetry: neatlogs }`,
rather than nesting the two provider wrappers, and prints the actual response status/request ID.

The optional script imports `../../packages/steer-ts/dist/index.js` from that build; it does not
require an unpublished package from npm or a temporary no-save installation. Run these commands
inside `examples/typescript-openai`. The existing package-lock pins Neatlogs, OpenAI and tsx.
