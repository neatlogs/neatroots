import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "toolchain/init-workspace.sh");
function fixture(t, mode = "success") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openharness-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin"), workspace = path.join(dir, "workspace");
  fs.mkdirSync(bin); fs.mkdirSync(workspace);
  const stub = "#!" + process.execPath + "\n" + [
    'const fs=require("node:fs"),p=require("node:path");',
    'fs.appendFileSync(process.env.CALLS,"install\\n");',
    mode === "fail" ? 'process.exit(1);' : '',
    'fs.mkdirSync("node_modules/neatlogs/dist",{recursive:true});',
    'fs.writeFileSync("node_modules/neatlogs/package.json",JSON.stringify({version:"1.1.28",type:"module"}));',
    'fs.writeFileSync("node_modules/neatlogs/dist/opencode-plugin.mjs",' + JSON.stringify(mode === "bad-export" ? "export const wrong=1;" : "export const NeatlogsOpencodePlugin=()=>{};") + ');',
  ].join("\n");
  fs.writeFileSync(path.join(bin, "npm"), stub, { mode: 0o755 });
  const calls = path.join(dir, "calls");
  const run = () => spawnSync("/bin/sh", [script], { cwd: workspace, encoding: "utf8",
    env: { ...process.env, PATH: bin + ":" + path.dirname(process.execPath) + ":/usr/bin:/bin", HARNESS_WORKSPACE: workspace, CALLS: calls } });
  return { dir, bin, workspace, calls, run, marker: path.join(workspace, ".harness/neatroots-instrumentation-v1.json") };
}
test("failed install is not success and leaves existing NOTES/config untouched", t => {
  const f = fixture(t, "fail"); fs.writeFileSync(path.join(f.workspace, "NOTES.md"), "user notes");
  fs.writeFileSync(path.join(f.workspace, "package.json"), '{"user":true}');
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(path.join(f.workspace, ".harness-initialized")), false);
  assert.equal(fs.readFileSync(path.join(f.workspace, "NOTES.md"), "utf8"), "user notes");
  assert.equal(fs.readFileSync(path.join(f.workspace, "package.json"), "utf8"), '{"user":true}');
});
test("success is verified, repeat is idempotent, and NOTES is not a success marker", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.workspace, "NOTES.md"), "existing");
  assert.equal(f.run().status, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.marker)).sdkVersion, "1.1.28");
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(f.calls, "utf8"), "install\n");
  assert.equal(fs.readFileSync(path.join(f.workspace, "NOTES.md"), "utf8"), "existing");
});
test("missing plugin export fails and remains retryable", t => {
  const f = fixture(t, "bad-export");
  assert.notEqual(f.run().status, 0); assert.equal(fs.existsSync(f.marker), false);
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.readFileSync(f.calls, "utf8"), "install\ninstall\n");
});

test("same-version wrong export is repaired and verified in one initialization", t => {
  const f = fixture(t);
  const sdk = path.join(f.workspace, ".harness/neatroots-sdk/node_modules/neatlogs");
  fs.mkdirSync(path.join(sdk, "dist"), { recursive: true });
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ version: "1.1.28", type: "module" }));
  fs.writeFileSync(path.join(sdk, "dist/opencode-plugin.mjs"), "export const wrong = 1;");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.calls, "utf8"), "install\n");
  assert.equal(JSON.parse(fs.readFileSync(f.marker)).sdkVersion, "1.1.28");
  const checker = path.join(root, "toolchain/check-workspace.mjs");
  assert.equal(spawnSync(process.execPath, [checker, f.workspace]).status, 0);
});
test("conflicting user plugin is preserved and no install occurs", t => {
  const f = fixture(t); const plugin = path.join(f.workspace, ".opencode/plugin/neatlogs.ts");
  fs.mkdirSync(path.dirname(plugin), { recursive: true }); fs.writeFileSync(plugin, "user plugin");
  assert.notEqual(f.run().status, 0); assert.equal(fs.readFileSync(plugin, "utf8"), "user plugin");
  assert.equal(fs.existsSync(f.calls), false); assert.equal(fs.existsSync(f.marker), false);
});
test("a linked managed directory is never followed", t => {
  const f = fixture(t); const outside = path.join(f.dir, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.workspace, ".harness"));
  assert.notEqual(f.run().status, 0); assert.deepEqual(fs.readdirSync(outside), []);
});
test("missing npm fails without a success marker", t => {
  const f = fixture(t); fs.rmSync(path.join(f.bin, "npm"));
  fs.symlinkSync(process.execPath, path.join(f.bin, "node"));
  const result = spawnSync("/bin/sh", [script], { cwd: f.workspace, env: { PATH: f.bin, HARNESS_WORKSPACE: f.workspace } });
  assert.notEqual(result.status, 0); assert.equal(fs.existsSync(f.marker), false);
});
test("workspace check rejects missing/replaced registration and wrong installed version", t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const checker = path.join(root, "toolchain/check-workspace.mjs");
  const check = () => spawnSync(process.execPath, [checker, f.workspace], { encoding: "utf8" }).status;
  assert.equal(check(), 0);
  const plugin = path.join(f.workspace, ".opencode/plugin/neatlogs.ts"), body = fs.readFileSync(plugin);
  fs.unlinkSync(plugin); assert.notEqual(check(), 0);
  fs.writeFileSync(plugin, "user replacement"); assert.notEqual(check(), 0);
  fs.writeFileSync(plugin, body);
  fs.writeFileSync(path.join(f.workspace, ".harness/neatroots-sdk/node_modules/neatlogs/package.json"), '{"version":"0.0.0","type":"module"}');
  assert.notEqual(check(), 0);
});
test("external node_modules is rejected without touching its contents", t => {
  const f = fixture(t), outside = path.join(f.dir, "external");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "user data");
  fs.mkdirSync(path.join(f.workspace, ".harness/neatroots-sdk"), { recursive: true });
  fs.symlinkSync(outside, path.join(f.workspace, ".harness/neatroots-sdk/node_modules"));
  assert.notEqual(f.run().status, 0); assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "user data");
  assert.equal(fs.existsSync(f.calls), false);
});
