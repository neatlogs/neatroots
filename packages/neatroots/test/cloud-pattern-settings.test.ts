import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const t = await makeRoots({ serve: true, noEngine: true, config: (c) => { c.cloud.redactPatterns = ["secret_[0-9]+"]; } });
  cleanup.push(t.close);
  t.roots.saveConfig();
  return t;
}

it("round-trips saved, edited and cleared cloud patterns without changing an omitted value", async () => {
  const { roots, url } = await setup();
  const patterns = async () => ((await (await fetch(`${url}/api/status`)).json()) as { cloud: { redact_patterns: string[] } }).cloud.redact_patterns;
  const save = (body: unknown) => fetch(`${url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(await patterns()).toEqual(["secret_[0-9]+"]);
  expect((await save({ cloud_endpoint: "https://eu.ingest.neatlogs.com" })).status).toBe(200);
  expect(await patterns()).toEqual(["secret_[0-9]+"]);
  for (const value of [["secret_[0-9]+"], ["cust_[0-9]+", "account_[A-Z]+"], []]) {
    expect((await save({ redact_patterns: value })).status).toBe(200);
    expect(await patterns()).toEqual(value);
    expect(roots.config.cloud.redactPatterns).toEqual(value);
    expect(fs.readFileSync(path.join(roots.home, "config.yaml"), "utf8")).toContain(value.length ? value[0] : "redactPatterns: []");
  }
  expect(roots.config.cloud.endpoint).toBe("https://eu.ingest.neatlogs.com");
});

it.each([null, {}, 5, "secret", [1], [true], ["valid", null], ["["], ["(a+)+$"]])("refuses invalid patterns %j before any mutation or side effect", async (value) => {
  const { roots, url } = await setup();
  const before = structuredClone(roots.config);
  const file = path.join(roots.home, "config.yaml");
  const bytes = fs.readFileSync(file);
  const save = vi.spyOn(roots, "saveConfig");
  const start = vi.spyOn(roots, "startModels");
  const stop = vi.spyOn(roots.laya, "stop");
  const reset = vi.spyOn(roots.decisions, "reset");
  const emit = vi.spyOn(roots.bus, "emit");
  const mode = vi.spyOn(roots.steering, "setMode");
  const reload = vi.spyOn(roots.checks, "reload");
  const result = await fetch(`${url}/api/settings`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redact_patterns: value, cloud_endpoint: "https://eu.ingest.neatlogs.com", retention_days: 21, steering_enabled: false, laya_enabled: true, project: "untouched", steering: "advisory", check_dir: path.join(roots.home, "new-checks") }),
  });
  expect(result.status).toBe(400);
  expect((await result.json()).error).toMatch(/redact_patterns|invalid pattern/);
  expect(roots.config).toEqual(before);
  expect(fs.readFileSync(file)).toEqual(bytes);
  for (const spy of [save, start, stop, reset, emit, mode, reload]) expect(spy).not.toHaveBeenCalled();
});
