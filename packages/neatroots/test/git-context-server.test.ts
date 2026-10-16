import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { registerGitContextCommand } from "../src/cli/git-context.js";
import { makeRoots, batch, span, hex } from "./helpers.js";

it("stores git context through the real HTTP API and reads it back from SQLite", async () => {
  const roots = await makeRoots({ serve: true, noEngine: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-git-api-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const realFetch = globalThis.fetch;
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    fs.writeFileSync(path.join(repo, "file"), "first");
    git("add", ".");
    git("commit", "-qm", "first");
    const traceId = hex(16);
    roots.roots.ingest([batch([span({ traceId, name: "git context", kind: "workflow" })])]);
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(url));
      return realFetch(new URL(route.pathname, roots.url), init);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const steeringEvent = vi.fn();
    roots.roots.steering.subscribe(steeringEvent);
    const program = new Command();
    registerGitContextCommand(program);
    await program.parseAsync(["node", "test", "annotate-git", traceId, "--repo", repo]);
    const notes = roots.roots.store.annotationsForTrace(traceId);
    expect(roots.roots.store.notesForTrace(traceId)).toEqual([]);
    expect(roots.roots.steering.claim(traceId)).toBeUndefined();
    expect(steeringEvent).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain(git("rev-parse", "HEAD"));
    expect(notes[0].text).toContain("not run provenance");
    expect(notes[0].text).not.toContain(repo);
    expect(git("status", "--porcelain")).toBe("");
    await expect(program.parseAsync(["node", "test", "annotate-git", "missing", "--repo", repo])).rejects.toThrow("run not found");
    expect(roots.roots.store.annotationsForTrace("missing")).toEqual([]);
    const deleted = hex(16);
    roots.roots.ingest([batch([span({ traceId: deleted, name: "delete race", kind: "workflow" })])]);
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(url));
      const response = await realFetch(new URL(route.pathname, roots.url), init);
      if (route.pathname === `/api/runs/${deleted}`) roots.roots.store.deleteRun(deleted);
      return response;
    });
    await expect(program.parseAsync(["node", "test", "annotate-git", deleted, "--repo", repo])).rejects.toThrow("run not found");
    expect(roots.roots.store.annotationsForTrace(deleted)).toEqual([]);

  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await roots.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
