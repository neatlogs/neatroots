import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { makeRoots } from "./helpers.js";

describe("start flags are runtime-only", () => {
  it("keeps the configured ports and Laya setting when another setting is saved", async () => {
    const t = await makeRoots({ noEngine: true, config: (c) => {
      c.port = 4100;
      c.grpcPort = 4317;
      c.classifier.laya.enabled = true;
    } });
    try {
      const { roots } = t;
      roots.applyStartOverrides({ port: 5000, grpcPort: 0, disableLaya: true });
      roots.config.retention.days = 30;
      roots.saveConfig();

      const saved = YAML.parse(fs.readFileSync(path.join(roots.home, "config.yaml"), "utf8"));
      expect(saved.port).toBe(4100);
      expect(saved.grpcPort).toBe(4317);
      expect(saved.classifier.laya.enabled).toBe(true);
      expect(saved.retention.days).toBe(30);
      expect(roots.config.port).toBe(5000);
      expect(roots.config.grpcPort).toBe(0);
      expect(roots.config.classifier.laya.enabled).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("still persists settings normally without start overrides", async () => {
    const t = await makeRoots({ noEngine: true });
    try {
      t.roots.config.port = 5500;
      t.roots.config.classifier.laya.enabled = true;
      t.roots.saveConfig();
      const saved = YAML.parse(fs.readFileSync(path.join(t.roots.home, "config.yaml"), "utf8"));
      expect(saved.port).toBe(5500);
      expect(saved.classifier.laya.enabled).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("persists an explicit Laya setting despite --no-laya", async () => {
    const t = await makeRoots({ noEngine: true, config: (c) => { c.classifier.laya.enabled = true; } });
    try {
      t.roots.applyStartOverrides({ disableLaya: true });
      t.roots.config.classifier.laya.enabled = false;
      t.roots.saveConfig({ layaEnabled: false });
      const saved = YAML.parse(fs.readFileSync(path.join(t.roots.home, "config.yaml"), "utf8"));
      expect(saved.classifier.laya.enabled).toBe(false);
    } finally {
      await t.close();
    }
  });
});
