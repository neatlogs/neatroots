import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { redactRecord } from "../src/audit/redact-record.js";
import { compileRules, type RedactionHit } from "../src/relay/redact.js";
import { createApp } from "../src/server/app.js";
import { verifyArchive } from "../src/audit/manifest.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { await t?.close(); });

it("keeps every colliding value and reserves existing and future ordinal-like key names", () => {
  const input = Object.fromEntries([
    ["alice@example.com", { password: 123, keep: "first" }],
    ["bob@example.com", { client_secret: false, keep: "second" }],
    ["carol@example.com#2", "third"],
    ["[redacted:email]", "existing"],
    ["[redacted:email]#2", "existing ordinal"],
    ["[redacted:email]#3", "another ordinal"],
    ["[redacted:email]#2#2", "nested ordinal"],
  ]);
  const before = structuredClone(input);
  const hits: RedactionHit[] = [];
  const actual = redactRecord(input, compileRules([]), hits);
  expect(actual).toEqual({
    "[redacted:email]#4": { password: "[redacted:password]", keep: "first" },
    "[redacted:email]#5": { client_secret: "[redacted:password]", keep: "second" },
    "[redacted:email]#2#3": "third",
    "[redacted:email]": "existing",
    "[redacted:email]#2": "existing ordinal",
    "[redacted:email]#3": "another ordinal",
    "[redacted:email]#2#2": "nested ordinal",
  });
  expect(Object.keys(actual as object)).toHaveLength(Object.keys(input).length);
  expect(redactRecord(input, compileRules([]), [])).toEqual(actual);
  expect(input).toEqual(before);
  expect(hits.filter(h => h.where === "audit sidecar key")).toHaveLength(3);
});

it("preserves prototype-named own data and nested custom collisions without changing prototypes", () => {
  const input = JSON.parse('{"__proto__":{"password":"hidden","private-a":{"count":1},"private-b":{"count":2}},"constructor":[{"prototype":{"pwd":false}}],"prototype":null}');
  const actual = redactRecord(input, compileRules(["private-[ab]"]), []) as Record<string, any>;
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(Object.hasOwn(actual, "__proto__")).toBe(true);
  expect(actual.__proto__).toEqual({ password: "[redacted:password]", "[redacted:custom]": { count: 1 }, "[redacted:custom]#2": { count: 2 } });
  expect(actual.constructor).toEqual([{ prototype: { pwd: "[redacted:password]" } }]);
  expect(Object.hasOwn(actual, "prototype")).toBe(true);
  expect(actual.prototype).toBeNull();
  expect(Object.hasOwn(Object.prototype, "password")).toBe(false);
  expect(input.__proto__).toEqual({ password: "hidden", "private-a": { count: 1 }, "private-b": { count: 2 } });
});

it("exports every colliding sidecar field through the share API and leaves original bytes intact", async () => {
  t = await makeRoots({ noEngine: true });
  const traceId = hex(16);
  t.roots.ingest([batch([span({ traceId, name: "agent", kind: "workflow" })])]);
  const detail = Object.fromEntries([
    ["alice@example.com", { password: "first-secret", label: "first" }],
    ["bob@example.com", { client_secret: 123, label: "second" }],
    ["[redacted:email]#2", false],
    ["__proto__", { pwd: false, label: "inert" }],
  ]);
  t.roots.store.insertFinding({ trace_id: traceId, check_id: "collisions", check_kind: "rule", title: "collision",
    probability: null, status: "raised", evidence_span_ids: [], model: null, triage_score: null, explanation_id: null, detail });
  const app = createApp(t.roots);
  const post = (body: unknown) => app.request("http://localhost/api/audit/export", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const exported = await (await post({ trace_id: traceId })).json();
  const directory = path.join(t.roots.home, "audit");
  const names = ["manifest.jsonl", exported.path, `${path.dirname(exported.path)}/record.json`];
  const originals = names.map(name => fs.readFileSync(path.join(directory, name)));
  const options = { trace_id: traceId, redacted: true, output: path.join(t.roots.home, "share") };
  const preview = await (await post({ ...options, preview: true })).json();
  const repeated = await (await post({ ...options, preview: true })).json();
  expect(repeated.preview_token).toBe(preview.preview_token);
  const response = await post({ ...options, preview_token: preview.preview_token });
  expect(response.status).toBe(200);
  const shared = await response.json();
  const text = fs.readFileSync(path.join(options.output, path.dirname(shared.path), "record.json"), "utf8");
  const actual = JSON.parse(text).record.findings[0].detail;
  expect(actual).toEqual(JSON.parse('{"[redacted:email]":{"password":"[redacted:password]","label":"first"},"[redacted:email]#3":{"client_secret":"[redacted:password]","label":"second"},"[redacted:email]#2":false,"__proto__":{"pwd":"[redacted:password]","label":"inert"}}'));
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(Object.hasOwn(actual, "__proto__")).toBe(true);
  for (const secret of ["alice@example.com", "bob@example.com", "first-secret"]) expect(text).not.toContain(secret);
  expect(verifyArchive(options.output, shared.head).ok).toBe(true);
  names.forEach((name, i) => expect(fs.readFileSync(path.join(directory, name))).toEqual(originals[i]));
  expect(t.roots.store.findingsForTrace(traceId)[0].detail).toEqual(detail);
});
