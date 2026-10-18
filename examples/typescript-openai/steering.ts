/** Optional steering example. Build packages/steer-ts first; see README.md for setup. */
import * as neatlogs from "neatlogs";
import OpenAI from "openai";
import { configure, wrapOpenAI } from "../../packages/steer-ts/dist/index.js";

await neatlogs.init({
  workflowName: "example-typescript-openai", endpoint: process.env.NEATLOGS_ENDPOINT ?? "http://localhost:4100",
  apiKey: "neatroots-local", flushInterval: 0.5,
});
configure({ neatlogs });
// Pass a raw SDK client; the adapter records the prepared request once.
const client = wrapOpenAI(new OpenAI({ baseURL: process.env.MOCK_LLM_URL ?? "http://127.0.0.1:4110/v1", apiKey: "mock" }), { telemetry: neatlogs });
try {
  const { data, response, request_id } = await client.chat.completions.create({
    model: "mock", messages: [{ role: "user", content: process.argv.slice(2).join(" ") || "Hello" }],
  }).withResponse();
  console.log({ text: data.choices[0]?.message.content, status: response.status, request_id });
} finally {
  await neatlogs.flush();
  await neatlogs.shutdown();
}
