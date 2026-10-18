import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { LayaManager } from "../src/models/laya.js";
import { askForLaya, layaAllowed, layaNextSteps, layaTakeover, shouldAskForLaya } from "../src/models/laya-consent.js";
import { freePort, makeRoots, poll, tmpHome, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("asking before downloading Laya", () => {
  it("asks only while Laya is on, not installed and not yet answered", () => {
    const cfg = defaultConfig();
    expect(shouldAskForLaya(cfg, false)).toBe(true);
    expect(shouldAskForLaya(cfg, true)).toBe(false);
    cfg.classifier.laya.consent = "no";
    expect(shouldAskForLaya(cfg, false)).toBe(false);
    cfg.classifier.laya.consent = undefined;
    cfg.classifier.laya.enabled = false;
    expect(shouldAskForLaya(cfg, false)).toBe(false);
  });

  it("says why before asking, and takes Enter as yes", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await askForLaya("/x/laya", async () => "")).toBe("yes");
      expect(await askForLaya("/x/laya", async () => " N ")).toBe("no");
      const pitch = out.mock.calls.map((c) => String(c[0])).join("\n");
      expect(pitch).toContain("yes/no questions");
      expect(pitch).toContain("neatroots jev login");
    } finally {
      out.mockRestore();
    }
  });

  it("doesn't download Laya without a yes, and points to Jev cloud instead", async () => {
    const home = tmpHome();
    try {
      const cfg = defaultConfig();
      cfg.classifier.laya.port = await freePort();
      const laya = new LayaManager(home, cfg.classifier);
      await laya.ensure();
      expect(laya.state.state).toBe("not_installed");
      expect(laya.state.message).toMatch(/Download Laya.*Jev cloud/);
      cfg.classifier.laya.consent = "no";
      await laya.ensure();
      expect(laya.state.state).toBe("not_installed");
      expect(laya.state.message).toMatch(/You chose not to download Laya/);
      expect(fs.existsSync(path.join(home, "laya", "install.log"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("cleans a failed Python environment and tells Ubuntu how to retry", async () => {
    const home = tmpHome();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-laya-bin-"));
    const python = path.join(bin, "python3.12");
    fs.writeFileSync(
      python,
      `#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[2] === "-c") process.exit(0);\nfs.mkdirSync(process.argv.at(-1), { recursive: true });\nprocess.exit(1);\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    try {
      const cfg = defaultConfig();
      cfg.classifier.laya.port = await freePort();
      const laya = new LayaManager(home, cfg.classifier);
      await laya.ensure({ install: true });
      expect(laya.state).toMatchObject({ state: "failed" });
      expect(laya.state.message).toContain("python3.12-venv");
      expect(laya.state.message).toContain("install uv");
      expect(fs.existsSync(path.join(home, "laya", ".venv"))).toBe(false);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("says how Laya takes over, and doesn't claim a download when Laya is already installed", () => {
    expect(layaTakeover()).toBe("takes over each question once it agrees with your LLM on 90% of 30 answers");
    expect(layaAllowed(true, true)).toBe("✓ Laya is installed and on. It takes over each question once it agrees with your LLM on 90% of 30 answers (Settings → Decision model shows how far it is).");
    expect(layaAllowed(true, false)).toMatch(/^✓ Laya is installed and starts with neatroots\. It takes over each question/);
    for (const live of [true, false]) expect(layaAllowed(true, live)).not.toMatch(/download/i);
    expect(layaAllowed(false, true)).toBe("✓ Laya is downloading in the background; Settings → Decision model shows progress.");
    expect(layaAllowed(false, false)).toBe(layaNextSteps("yes"));
  });

  it("laya allow says Laya is installed when it is, and records the yes", async () => {
    const home = tmpHome();
    try {
      // Laya as the installer leaves it, and a port nothing answers on (never the real 4100).
      fs.mkdirSync(path.join(home, "laya", ".venv", "bin"), { recursive: true });
      fs.writeFileSync(path.join(home, "laya", ".venv", "bin", "laya-serve"), "");
      fs.writeFileSync(path.join(home, "laya", "installed-version"), "test");
      const cfg = defaultConfig();
      cfg.port = await freePort();
      cfg.classifier.laya.port = await freePort();
      cfg.classifier.laya.consent = "no";
      fs.writeFileSync(path.join(home, "config.yaml"), YAML.stringify(cfg));
      const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "laya", "allow"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, NEATROOTS_HOME: home },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("✓ Laya is installed and starts with neatroots.");
      expect(r.stdout).not.toMatch(/download/i);
      expect(YAML.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf8")).classifier.laya.consent).toBe("yes");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("records Skip from the app in this neatroots' own settings", async () => {
    const port = await freePort();
    t = await makeRoots({
      serve: true,
      noEngine: true,
      config: (c) => {
        c.classifier.laya.enabled = true;
        c.classifier.laya.port = port;
      },
    });
    const before = await (await fetch(`${t.url}/api/status`)).json();
    expect(before.classifier.laya.consent).toBeNull();
    const r = await fetch(`${t.url}/api/classifier/laya`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "skip" }) });
    expect(r.status).toBe(200);
    const status = await poll(async () => {
      const s = await (await fetch(`${t!.url}/api/status`)).json();
      return /chose not to download/.test(s.classifier.laya.message ?? "") ? s : undefined;
    });
    expect(status.classifier.laya).toMatchObject({ state: "not_installed", consent: "no" });
    const saved = YAML.parse(fs.readFileSync(path.join(t.roots.home, "config.yaml"), "utf8"));
    expect(saved.classifier.laya.consent).toBe("no");
  });
});
