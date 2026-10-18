import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import YAML from "yaml";
import { projectSettings } from "../src/config.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });

for (const change of ["global", "project", "inherit", "directory"] as const) {
  it(`keeps the active and saved audit policy after a partial config write: ${change}`, async () => {
    t = await makeRoots({ noEngine: true, serve: true, config: c => {
      c.audit.enabled = change === "global" || change === "directory";
      c.projects.covered = change === "project" || change === "inherit" ? { audit: true } : {};
    } });
    const roots = t.roots, file = path.join(roots.home, "config.yaml");
    roots.saveConfig();
    const original = fs.readFileSync(file), policy = structuredClone(roots.config);
    const id = hex(16);
    roots.store.ingest([batch([span({ traceId: id, name: "held", kind: "workflow" })], "covered")]);
    let events = 0;
    const off = roots.bus.on("settings", () => { events++; });
    const write = fs.writeFileSync;
    const fail = vi.spyOn(fs, "writeFileSync").mockImplementation(((target: any, data: any, options: any) => {
      if (typeof target === "string" && target.startsWith(file)) {
        write(target, "partial config", options);
        throw new Error("controlled config write failure");
      }
      return write(target, data, options);
    }) as typeof fs.writeFileSync);
    const audit = change === "global" ? { audit_enabled: false } : change === "directory"
      ? { audit_directory: path.join(roots.home, "replacement") } : { audit: change === "inherit" ? null : false };
    const response = await fetch(`${t.url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "covered", steering: "advisory", retention_days: 1, ...audit }) });
    fail.mockRestore(); off();
    expect.soft(response.status).toBe(500);
    expect.soft(fs.readFileSync(file)).toEqual(original);
    expect.soft(roots.config).toEqual(policy);
    expect.soft(events).toBe(0);
    expect.soft(projectSettings(roots.config, "covered").audit).toBe(true);
    expect.soft(roots.store.sweep(0, 1)).toBe(0);
    expect(() => roots.store.deleteRun(id)).toThrow(/audit hold/);
    expect(roots.store.getRun(id)).toBeDefined();
    expect(fs.readdirSync(roots.home).filter(n => n.startsWith("config.yaml."))).toEqual([]);
  });
}

it("persists an audit candidate before activating or emitting settings, including mixed updates", async () => {
  t = await makeRoots({ noEngine: true, serve: true, config: c => { c.audit.enabled = true; } });
  const roots = t.roots, file = path.join(roots.home, "config.yaml"), observations: boolean[] = [];
  roots.saveConfig();
  const off = roots.bus.on("settings", () => {
    observations.push(JSON.stringify(YAML.parse(fs.readFileSync(file, "utf8"))) === JSON.stringify(roots.config));
  });
  const post = (body: object) => fetch(`${t!.url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const directory = path.join(roots.home, "saved-archive");
  expect((await post({ project: "covered", audit: false, audit_directory: directory, steering: "advisory", retention_days: 2 })).status).toBe(200);
  expect(projectSettings(roots.config, "covered").audit).toBe(false);
  expect(roots.audit.directory()).toBe(directory);
  expect((await post({ project: "covered", audit: null })).status).toBe(200);
  expect(projectSettings(roots.config, "covered").audit).toBe(true);
  expect((await post({ audit_enabled: false })).status).toBe(200);
  expect(projectSettings(roots.config, "covered").audit).toBe(false);
  expect(YAML.parse(fs.readFileSync(file, "utf8"))).toEqual(roots.config);
  expect(observations.length).toBeGreaterThanOrEqual(3);
  expect(observations.every(Boolean)).toBe(true);
  off();
});
