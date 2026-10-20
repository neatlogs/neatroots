import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, loadConfig } from "../src/config.js";

describe("loadConfig with a hand-edited value of the wrong shape", () => {
  const prev = process.env.NEATROOTS_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.NEATROOTS_HOME;
    else process.env.NEATROOTS_HOME = prev;
    vi.restoreAllMocks();
  });

  const load = (yaml: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-config-"));
    fs.writeFileSync(path.join(home, "config.yaml"), yaml);
    process.env.NEATROOTS_HOME = home;
    return loadConfig();
  };

  it("keeps the default section when one is written as a scalar, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = defaultConfig();
    const cfg = load("retention: 5\nllm: ollama\nclassifier:\n  laya: off\ncloud: https://example.com\nport: 4200\n");
    expect(cfg.retention).toEqual(d.retention);
    expect(cfg.llm).toEqual(d.llm);
    expect(cfg.classifier.laya).toEqual(d.classifier.laya);
    expect(cfg.cloud).toEqual(d.cloud);
    expect(cfg.port).toBe(4200);
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    for (const key of ["retention", "llm", "classifier.laya", "cloud"]) expect(said).toContain(`ignoring ${key} `);
  });

  it("turns a list setting given as one string into a one-item list", () => {
    const cfg = load("checkDirs: ./checks\ncloud:\n  redactPatterns: ACME-[0-9]+\n");
    expect(cfg.checkDirs).toEqual(["./checks"]);
    expect(cfg.cloud.redactPatterns).toEqual(["ACME-[0-9]+"]);
  });

  it("ignores a list setting given as a number", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(load("checkDirs: 3\n").checkDirs).toEqual([]);
  });

  it("still merges well-formed settings", () => {
    const cfg = load("retention:\n  days: 30\nllm:\n  model: qwen3\nrerun:\n  agent:\n    command: python agent.py\n");
    expect(cfg.retention).toEqual({ days: 30, maxGb: 5 });
    expect(cfg.llm.model).toBe("qwen3");
    expect(cfg.llm.baseUrl).toBe(defaultConfig().llm.baseUrl);
    expect(cfg.rerun.agent.command).toBe("python agent.py");
  });
});
