import { afterEach, expect, it } from "vitest";
import { makeRoots, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// A JS Error sent as `error: err` arrives as {}; an object in a string field used to 500 or store "[object Object]".
it.each([
  [{ name: "a", children: [{ name: "b", tool_name: "search", error: {} }] }, "children[0].error"],
  [{ name: "a", project: { x: 1 } }, "project"],
  [{ name: "a", model: { id: "gpt" } }, "model"],
  [{ name: "a", provider: ["openai"] }, "provider"],
  [{ name: "a", tool_name: 5 }, "tool_name"],
  [{ name: "a", session_id: { id: 1 } }, "session_id"],
  [{ name: "a", user_id: { id: 1 } }, "user_id"],
])("rejects %j with a validation error naming %s", async (body, field) => {
  t ??= await makeRoots({ noEngine: true, serve: true });
  const r = await fetch(`${t.url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(400);
  expect((await r.json()).details).toHaveProperty([field], "must be a string");
});
