import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { Roots } from "../src/core.js";
import { tmpHome } from "./helpers.js";

let roots: Roots | undefined;
afterEach(() => {
  const home = roots?.home;
  roots?.close();
  roots = undefined;
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

it("does not persist process-only start flags with later settings", () => {
  const home = tmpHome();
  roots = new Roots({ home, config: defaultConfig(), noEngine: true, runtime: { port: 5100, grpcPort: 5317, layaEnabled: false } });
  roots.config.retention.days = 30;
  roots.saveConfig();

  expect(roots.config).toMatchObject({ port: 5100, grpcPort: 5317, classifier: { laya: { enabled: false } }, retention: { days: 30 } });
  const saved = YAML.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf8"));
  expect(saved).toMatchObject({ port: 4100, grpcPort: 4317, classifier: { laya: { enabled: true } }, retention: { days: 30 } });

  roots.persistRuntimeSetting("layaEnabled");
  roots.saveConfig();
  expect(YAML.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf8"))).toMatchObject({ classifier: { laya: { enabled: false } } });
});
