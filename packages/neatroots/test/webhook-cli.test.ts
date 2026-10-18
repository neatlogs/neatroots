import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
function cli(home: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, NEATROOTS_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = ""; child.stdout.on("data", (x) => stdout += x); child.stderr.on("data", (x) => stderr += x);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
it("CLI adds/lists/tests only the explicit local destination, without printing secrets", async () => {
  const bodies: string[] = [];
  const server = http.createServer(async (req, res) => { let s = ""; for await (const part of req) s += part; bodies.push(s); res.end("ok"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-webhook-cli-")); homes.push(home);
  fs.writeFileSync(path.join(home, "config.yaml"), "port: 1\n");
  const url = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port + "/SECRET_PATH?q=SECRET_QUERY";
  try {
    for (const args of [["webhook", "add", url], ["webhook", "list"], ["webhook", "test", url, "--format", "discord"]]) {
      const result = await cli(home, args); expect(result.code).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/SECRET_PATH|SECRET_QUERY/);
    }
    expect(bodies).toHaveLength(1); expect(JSON.parse(bodies[0]).allowed_mentions).toEqual({ parse: [] });
    const bad = await cli(home, ["webhook", "add", "file:///SECRET_PATH"]);
    expect(bad.code).toBe(1); expect(bad.stdout + bad.stderr).not.toContain("SECRET_PATH");
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
}, 15000);


it("CLI preserves invalid destinations on unrelated saves and refuses add without erasing them", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-webhook-cli-")); homes.push(home);
  const file = path.join(home, "config.yaml");
  for (const raw of ["PRIVATE_SCALAR", { url: "PRIVATE_OBJECT" }, [{ url: "http://127.0.0.1:1/PRIVATE_PATH", events: ["finding"] }, "PRIVATE_BAD"]]) {
    fs.writeFileSync(file, YAML.stringify({ port: 1, webhooks: raw }));
    const saved = await cli(home, ["steering", "stop", "--port", "1"]);
    expect(saved.code).toBe(0);
    expect(YAML.parse(fs.readFileSync(file, "utf8")).webhooks).toEqual(raw);
    const before = fs.readFileSync(file, "utf8");
    const added = await cli(home, ["webhook", "add", "http://127.0.0.1:1/new"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain("repair webhooks in config.yaml");
    expect(added.stdout + added.stderr + saved.stdout + saved.stderr).not.toContain("PRIVATE_");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }
}, 15000);
