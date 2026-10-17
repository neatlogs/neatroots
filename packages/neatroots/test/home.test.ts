import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rootsHome } from "../src/config.js";

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows; each test gets its own.
let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NEATROOTS_HOME: process.env.NEATROOTS_HOME };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-home-"));
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  delete process.env.NEATROOTS_HOME;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});
const dir = (...p: string[]) => fs.mkdirSync(path.join(home, ...p), { recursive: true });

describe("the home folder", () => {
  it("is ~/.neatroots on a new machine", () => {
    expect(rootsHome()).toBe(path.join(home, ".neatroots"));
  });

  it("stays where an install from before the rename kept its runs, even after the installer made ~/.neatroots", () => {
    dir(".neatroots", "app");
    dir(".neatroots", "node");
    dir(".bolts", "data");
    expect(rootsHome()).toBe(path.join(home, ".bolts"));
    dir(".neatbolt", "data");
    expect(rootsHome()).toBe(path.join(home, ".neatbolt"));
  });

  it("is ~/.neatroots once it holds settings or runs", () => {
    dir(".bolts", "data");
    dir(".neatroots", "data");
    expect(rootsHome()).toBe(path.join(home, ".neatroots"));
  });

  it("follows NEATROOTS_HOME", () => {
    process.env.NEATROOTS_HOME = path.join(home, "elsewhere");
    expect(rootsHome()).toBe(path.join(home, "elsewhere"));
  });
});
