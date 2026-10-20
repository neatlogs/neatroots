import { afterEach, expect, it } from "vitest";
import { makeRoots, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

it("a refused settings request changes nothing, not even its valid parts", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const headers = { "content-type": "application/json", origin: t.url.replace("127.0.0.1", "localhost") };
  const save = (b: unknown) => fetch(`${t!.url}/api/settings`, { method: "POST", headers, body: JSON.stringify(b) });
  for (const b of [
    { steering_enabled: true, project: "shop", steering: "gate", llm_model: "other-model", cloud_endpoint: "https://evil.example.com" },
    { retention_days: 7, classifier_backend: "bogus" },
    { redact_patterns: ["("], forward: true, project: "shop2" },
    { llm_model: "other-model", project: "shop3", steering: "nope" },
  ]) {
    const before = JSON.stringify(t.roots.config);
    expect((await save(b)).status, JSON.stringify(b)).toBe(400);
    expect(JSON.stringify(t.roots.config), JSON.stringify(b)).toBe(before);
  }
});
