import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { await t?.close(); });
const run = promisify(execFile);

async function cli(args: string[], cwd = path.resolve(import.meta.dirname, "..")) {
  try {
    const result = await run(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve(import.meta.dirname, "../src/cli.ts"),
      "audit", ...args, "--port", String(t!.roots.config.port)], {
      cwd, env: { ...process.env, NEATROOTS_HOME: t!.roots.home },
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

it("CLI exports and verifies seq/head and exits nonzero for a mismatched external head", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const traceId = hex(16); t.roots.ingest([batch([span({ traceId, name: "cli", kind: "workflow" })])]);
  const exported = await cli(["export", traceId]);
  expect(exported.code, exported.stderr).toBe(0);
  expect(exported.stdout).toContain("original archive:"); expect(exported.stdout).toContain("seq 1");
  const head = /head ([a-f0-9]{64})/.exec(exported.stdout)![1];
  const verified = await cli(["verify", "--expect-head", head]);
  expect(verified.code, verified.stderr).toBe(0); expect(verified.stdout).toContain(`head ${head}`);
  const failed = await cli(["verify", "--expect-head", "0".repeat(64)]);
  expect(failed.code).toBe(1); expect(failed.stdout).toContain("expected head does not match");
  expect(failed.stdout).toContain(`head ${head}`);
  const preview = await cli(["export", traceId, "--redacted", "--preview"]);
  expect(preview.code, preview.stderr).toBe(0);
  const output = path.join(t.roots.home, "share");
  expect(fs.existsSync(output)).toBe(false);
  const shared = await cli(["export", traceId, "--redacted", "--yes", "--output", output]);
  expect(shared.code, shared.stderr).toBe(0); expect(shared.stdout).toContain("redacted share copy:");
}, 20_000);

it("resolves explicit paths from the CLI cwd, retaining the server-owned default", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const caller = path.join(t.roots.home, "caller"); fs.mkdirSync(caller);
  expect(caller).not.toBe(process.cwd()); // The real HTTP server runs in this test process's cwd.
  const traceId = hex(16); t.roots.ingest([batch([span({ traceId, name: "cwd", kind: "workflow" })])]);
  const name = `caller-archive-${hex(4)}`;
  const output = `caller-share-${hex(4)}`;
  const exported = await cli(["export", traceId, "--directory", `./${name}`], caller);
  expect(exported.code, exported.stderr).toBe(0);
  expect(fs.existsSync(path.join(caller, name, "manifest.jsonl"))).toBe(true);
  expect(fs.existsSync(path.join(process.cwd(), name))).toBe(false);
  const head = /head ([a-f0-9]{64})/.exec(exported.stdout)![1];
  const verified = await cli(["verify", "--directory", `./${name}`, "--expect-head", head], caller);
  expect(verified.code, verified.stderr).toBe(0);
  const preview = await cli(["export", traceId, "--directory", `./${name}`, "--redacted", "--preview"], caller);
  expect(preview.code, preview.stderr).toBe(0);
  const shared = await cli(["export", traceId, "--directory", `./${name}`, "--redacted", "--yes", "--output", `./${output}`], caller);
  expect(shared.code, shared.stderr).toBe(0);
  expect(fs.existsSync(path.join(caller, output, "manifest.jsonl"))).toBe(true);
  expect(fs.existsSync(path.join(process.cwd(), output))).toBe(false);
  const defaultExport = await cli(["export", traceId], caller);
  expect(defaultExport.code, defaultExport.stderr).toBe(0);
  expect(fs.existsSync(path.join(t.roots.home, "audit", "manifest.jsonl"))).toBe(true);
  expect(fs.existsSync(path.join(caller, "audit"))).toBe(false);
}, 20_000);

it("CLI audit status prints counts and no private run payload", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  t.roots.config.audit.enabled = true;
  const traceId = hex(16);
  t.roots.ingest([batch([span({ traceId, name: "PRIVATE-PAYLOAD-DO-NOT-PRINT", kind: "workflow" })])]);
  const result = await cli(["status"]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ covered_runs: 1, held_runs: 1, archive_entries: 0 });
  expect(result.stdout).not.toContain("PRIVATE-PAYLOAD-DO-NOT-PRINT");
});
