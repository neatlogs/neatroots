import { afterEach, expect, it } from "vitest";
import { decodeLogsJson } from "../src/otlp/codec.js";
import { makeRoots, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// A string used to be iterated character by character: "xyz" became three empty log records.
it.each([
  { resourceLogs: "xyz" },
  { resourceLogs: [{ scopeLogs: "xyz" }] },
  { resourceLogs: [{ scopeLogs: [{ logRecords: "xyz" }] }] },
  { resourceLogs: [{ scopeLogs: [{ logRecords: [1] }] }] },
])("rejects OTLP logs whose lists aren't lists of objects, as traces do: %j", async (body) => {
  expect(() => decodeLogsJson(body)).toThrow(/must be an (array|object)/);
  t ??= await makeRoots({ noEngine: true, serve: true });
  const r = await fetch(`${t.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(400);
});

it("still reads well-formed logs and treats a missing list as empty", () => {
  expect(decodeLogsJson({})).toEqual([]);
  expect(decodeLogsJson({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: "1", body: { stringValue: "hi" } }] }] }] })).toHaveLength(1);
});
