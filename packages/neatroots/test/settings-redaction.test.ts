import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { makeRoots, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

it("status includes saved cloud redaction patterns as an array", async () => {
  const patterns = ["secret_[0-9]+", "\\bcust_[0-9]+\\b"];
  t = await makeRoots({ noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = patterns; } });
  const res = await createApp(t.roots).request("http://localhost/api/status", { headers: { host: "localhost" } });
  expect(res.status).toBe(200);
  expect((await res.json()).cloud.redact_patterns).toEqual(patterns);
});

it("saving cloud patterns replaces the list and persists an empty list when cleared", async () => {
  t = await makeRoots({ noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = ["secret_[0-9]+"]; } });
  const app = createApp(t.roots);
  for (const patterns of [["secret_[0-9]+", "cust_[0-9]+"], []]) {
    const res = await app.request("http://localhost/api/settings", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ redact_patterns: patterns }),
    });
    expect(res.status).toBe(200);
    const status = await app.request("http://localhost/api/status", { headers: { host: "localhost" } });
    expect((await status.json()).cloud.redact_patterns).toEqual(patterns);
    const saved = YAML.parse(fs.readFileSync(path.join(t.roots.home, "config.yaml"), "utf8"));
    expect(saved.cloud.redactPatterns).toEqual(patterns);
  }
});
