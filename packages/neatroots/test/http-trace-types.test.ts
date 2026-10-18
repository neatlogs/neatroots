import { afterEach, expect, it } from "vitest";
import { HttpTraceError, httpTraceToBatches } from "../src/ingest/http-trace.js";
import { makeRoots, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// These used to crash in the converter (kind.trim, logs.map, tags.join) and come back as a 500.
it.each([
  [{ name: "a", kind: 5 }, "kind"],
  [{ name: "a", logs: "oops" }, "logs"],
  [{ name: "a", tags: "prod" }, "tags"],
  [{ name: "a", children: [{ name: "b", logs: [null] }] }, "children[0].logs[0]"],
])("rejects %j with a validation error naming %s", async (body, field) => {
  let e: unknown;
  try {
    httpTraceToBatches(body);
  } catch (x) {
    e = x;
  }
  expect(e).toBeInstanceOf(HttpTraceError);
  t ??= await makeRoots({ noEngine: true, serve: true });
  const r = await fetch(`${t.url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(400);
  expect(JSON.stringify(await r.json())).toContain(field);
});

it("still takes well-typed kind, tags and logs", () => {
  const r = httpTraceToBatches({ name: "a", kind: "workflow", tags: ["prod"], logs: [{ level: "info", message: "hi" }] });
  expect(r.spans).toBe(1);
});
