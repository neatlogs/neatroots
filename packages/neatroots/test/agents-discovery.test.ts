import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Installed before chat.ts is imported: APP_BINS caches the home directory at import.
const host = vi.hoisted(() => ({
  home: process.platform === "win32" ? "C:\\fixture-home" : "/fixture-home",
  active: false,
  files: new Map<string, "executable" | "nonexecutable" | "directory">(),
  nvm: false,
  pathHit: "",
  lookup: vi.fn(),
}));
vi.mock("node:os", async (original) => {
  const real = await original<typeof import("node:os")>();
  const homedir = () => host.home;
  return { ...real, homedir, default: { ...real, homedir } };
});
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const key = (p: unknown) => path.normalize(String(p));
  const controlled = {
    existsSync: (...args: Parameters<typeof real.existsSync>) => host.active
      ? host.nvm && key(args[0]) === path.join(host.home, ".nvm", "versions", "node")
      : real.existsSync(...args),
    readdirSync: (...args: Parameters<typeof real.readdirSync>) => {
      if (!host.active) return real.readdirSync(...args);
      if (host.nvm && key(args[0]) === path.join(host.home, ".nvm", "versions", "node")) return ["v22.0.0", "v24.14.1"];
      throw new Error("unexpected directory read");
    },
    accessSync: (...args: Parameters<typeof real.accessSync>) => {
      if (!host.active) return real.accessSync(...args);
      const kind = host.files.get(key(args[0]));
      if (!kind || kind === "nonexecutable") throw new Error("not executable");
    },
    statSync: (...args: Parameters<typeof real.statSync>) => {
      if (!host.active) return real.statSync(...args);
      const kind = host.files.get(key(args[0]));
      if (!kind) throw new Error("missing");
      return { isFile: () => kind !== "directory" };
    },
  };
  return { ...real, ...controlled, default: { ...real, ...controlled } };
});
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawnSync: (...args: Parameters<typeof real.spawnSync>) => {
    if (!host.active) return real.spawnSync(...args);
    host.lookup(...args);
    return { status: host.pathHit ? 0 : 1, stdout: host.pathHit ? `${host.pathHit}\n` : "" };
  } };
});

import { agentBin } from "../src/agents/chat.js";

const system = ["/opt/homebrew/bin", "/usr/local/bin"];
const local = path.join(host.home, ".local", "bin", "codex");
const nvm = path.join(host.home, ".nvm", "versions", "node", "v24.14.1", "bin", "codex");
const app = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const userApp = path.join(host.home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
const onPath = path.join(host.home, "path", "codex");
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, NEATROOTS_CODEX_BIN: process.env.NEATROOTS_CODEX_BIN };
const put = (p: string, kind: "executable" | "nonexecutable" | "directory" = "executable") => host.files.set(path.normalize(p), kind);
beforeEach(() => {
  host.active = true;
  host.files.clear(); host.nvm = true; host.pathHit = ""; host.lookup.mockClear();
  process.env.HOME = host.home;
  if (process.platform === "win32") process.env.USERPROFILE = host.home;
  process.env.PATH = "controlled-only";
  delete process.env.NEATROOTS_CODEX_BIN;
});
afterEach(() => {
  host.active = false;
  host.files.clear(); host.lookup.mockClear();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("discovery on a controlled host (including Windows)", () => {
  it("isolates nvm and local fixtures despite installed Homebrew, system and app binaries", () => {
    for (const dir of system) put(path.join(dir, "codex"));
    put(app); put(userApp); put(nvm);
    // The host PATH result is controlled to miss; no real shell or host filesystem is consulted.
    expect(agentBin("codex", [])).toBe(nvm);
    put(local);
    expect(agentBin("codex", [])).toBe(local);
    expect(host.lookup).toHaveBeenCalledWith("sh", ["-c", "command -v codex"], { encoding: "utf8" });
  });

  it("finds system and user ChatGPT fixtures without a real installed application", () => {
    for (const dir of system) put(path.join(dir, "codex"));
    put(app); put(userApp);
    expect(agentBin("codex", [])).toBe(app);
    host.files.delete(path.normalize(app));
    expect(agentBin("codex", [])).toBe(userApp);
    host.files.delete(path.normalize(userApp));
    expect(agentBin("codex", [])).toBeNull();
  });

  it("preserves the full production precedence with every competing location installed", () => {
    const pinned = path.join(host.home, "pinned", "codex");
    const order = [onPath, local, path.join(host.home, ".claude", "local", "codex"),
      ...system.map(dir => path.join(dir, "codex")), path.join(host.home, ".bun", "bin", "codex"),
      path.join(host.home, ".volta", "bin", "codex"), path.join(host.home, ".npm-global", "bin", "codex"),
      nvm, path.join(host.home, ".nvm", "versions", "node", "v22.0.0", "bin", "codex"), app, userApp];
    for (const file of [pinned, ...order]) put(file);
    host.pathHit = onPath;
    process.env.NEATROOTS_CODEX_BIN = pinned;
    expect(agentBin("codex")).toBe(pinned);
    expect(host.lookup).not.toHaveBeenCalled();
    delete process.env.NEATROOTS_CODEX_BIN;
    for (const expected of order) {
      expect(agentBin("codex")).toBe(expected);
      host.files.delete(path.normalize(expected));
      if (expected === onPath) host.pathHit = "";
    }
    expect(agentBin("codex")).toBeNull();
  });

  it.each(["missing", "nonexecutable", "directory"] as const)("an invalid %s override stops all fallback", (kind) => {
    const pinned = path.join(host.home, "pinned", "codex");
    if (kind !== "missing") put(pinned, kind);
    put(onPath); put(local); host.pathHit = onPath;
    process.env.NEATROOTS_CODEX_BIN = pinned;
    expect(agentBin("codex")).toBeNull();
    expect(host.lookup).not.toHaveBeenCalled();
  });

  it("skips invalid PATH and fallback candidates, including nonexecutable apps", () => {
    host.pathHit = onPath; put(onPath, "nonexecutable"); put(local, "directory");
    put(app, "nonexecutable"); put(userApp);
    expect(agentBin("codex", [])).toBe(userApp);
    put(userApp, "directory"); host.nvm = false;
    expect(agentBin("codex", [])).toBeNull();
  });
});
