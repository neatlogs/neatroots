import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { Roots } from "../src/core.js";
import { defaultConfig, type RootsConfig } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { tmpHome } from "./helpers.js";

const instances: Roots[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const roots of instances.splice(0)) {
    roots.close();
    fs.rmSync(roots.home, { recursive: true, force: true });
  }
});
function setup(runtime?: { port?: number; grpcPort?: number; layaEnabled?: boolean }) {
  const config = defaultConfig();
  config.port = 4108;
  config.grpcPort = 4318;
  config.classifier.backend = "llm";
  config.classifier.laya.enabled = true;
  config.classifier.laya.consent = "no";
  const roots = new Roots({ home: tmpHome(), config, noEngine: true, runtime });
  instances.push(roots);
  return { roots, app: createApp(roots) };
}
function saved(roots: Roots): RootsConfig {
  return YAML.parse(fs.readFileSync(path.join(roots.home, "config.yaml"), "utf8"));
}
function update(app: ReturnType<typeof createApp>, body: object) {
  return app.request("http://localhost/api/settings", {
    method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body),
  });
}

describe("one-process start configuration", () => {
  it("keeps listener and Laya overrides out of repeated unrelated settings saves", async () => {
    const { roots, app } = setup({ port: 4208, grpcPort: 0, layaEnabled: false });
    for (const days of [17, 23]) {
      expect((await update(app, { retention_days: days })).status).toBe(200);
      const disk = saved(roots);
      expect([disk.port, disk.grpcPort, disk.classifier.laya.enabled]).toEqual([4108, 4318, true]);
      expect(disk.retention.days).toBe(days);
      expect([roots.config.port, roots.config.grpcPort, roots.config.classifier.laya.enabled]).toEqual([4208, 0, false]);
    }
  });
  it.each([false, true])("persists an explicit Laya setting of %s even during --no-laya", async (enabled) => {
    const { roots, app } = setup({ layaEnabled: false });
    vi.spyOn(roots, "startModels").mockImplementation(() => {});
    expect((await update(app, { laya_enabled: enabled })).status).toBe(200);
    expect((await update(app, { retention_days: 19 })).status).toBe(200);
    expect(saved(roots).classifier.laya.enabled).toBe(enabled);
    expect(roots.config.classifier.laya.enabled).toBe(enabled);
  });
  it("persists the explicit install action during --no-laya", async () => {
    const { roots, app } = setup({ layaEnabled: false });
    vi.spyOn(roots.laya, "ensure").mockResolvedValue(undefined);
    const response = await app.request("http://localhost/api/classifier/laya", {
      method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ action: "install" }),
    });
    expect(response.status).toBe(200);
    expect(saved(roots).classifier.laya.enabled).toBe(true);
    expect(saved(roots).classifier.laya.consent).toBe("yes");
  });
  it("saves ordinary configuration edits without startup overrides", () => {
    const { roots } = setup();
    roots.config.port = 4200;
    roots.config.grpcPort = 4320;
    roots.config.classifier.laya.enabled = false;
    roots.saveConfig();
    expect([saved(roots).port, saved(roots).grpcPort, saved(roots).classifier.laya.enabled]).toEqual([4200, 4320, false]);
  });
});
