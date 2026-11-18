import { afterEach, expect, it } from "vitest";
import { httpTraceToBatches } from "../src/ingest/http-trace.js";
import { makeRoots, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// A JS Error sent as `error: err` arrives as {}; an object in a string field used to 500 or store "[object Object]".
it.each([
  [{ name: "a", children: [{ name: "b", tool_name: "search", error: {} }] }, "children[0].error"],
  [{ name: "a", model: { id: "gpt" } }, "model"],
  [{ name: "a", provider: ["openai"] }, "provider"],
  [{ name: "a", tool_name: 5 }, "tool_name"],
])("rejects %j with a validation error naming %s", async (body, field) => {
  t ??= await makeRoots({ noEngine: true, serve: true });
  const r = await fetch(`${t.url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(400);
  expect((await r.json()).details).toHaveProperty([field], "must be a string");
});

// IDs and the project may be numbers, but not objects, arrays or booleans.
it.each([
  [{ name: "a", project: { x: 1 } }, "project"],
  [{ name: "a", project: true }, "project"],
  [{ name: "a", session_id: { id: 1 } }, "session_id"],
  [{ name: "a", sessionId: [7] }, "sessionId"],
  [{ name: "a", user_id: { id: 1 } }, "user_id"],
  [{ name: "a", end_user_id: false }, "end_user_id"],
  [{ name: "a", endUserId: [42] }, "endUserId"],
])("rejects %j with a validation error naming %s", async (body, field) => {
  t ??= await makeRoots({ noEngine: true, serve: true });
  const r = await fetch(`${t.url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(400);
  expect((await r.json()).details).toHaveProperty([field], "must be a string or a finite number");
});

it("accepts numeric session, user and project IDs and stores them as strings", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const r = await fetch(`${t.url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "a", project: 5, session_id: 7, user_id: 42 }) });
  expect(r.status).toBe(200);
  const { trace_id } = await r.json();
  expect(t.roots.store.getRun(trace_id)).toMatchObject({ project: "5", session_id: "7" });

  for (const body of [{ name: "a", sessionId: 7, endUserId: 42 }, { name: "a", session_id: 7, end_user_id: 42 }]) {
    const attrs = httpTraceToBatches(body).batches[0].spans[0].attributes;
    expect(attrs).toContainEqual({ key: "neatlogs.session.id", value: { stringValue: "7" } });
    expect(attrs).toContainEqual({ key: "neatlogs.user.id", value: { stringValue: "42" } });
  }
});
