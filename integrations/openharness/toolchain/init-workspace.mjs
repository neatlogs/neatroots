import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
export const version = "1.1.28";
export const registration = "export { NeatlogsOpencodePlugin as default } from '../../.harness/neatroots-sdk/node_modules/neatlogs/dist/opencode-plugin.mjs';\n";
const here = path.dirname(fileURLToPath(import.meta.url));
export async function initialize(workspace = process.env.HARNESS_WORKSPACE || process.cwd()) {
  workspace = fs.realpathSync(workspace);
  const managed = path.join(workspace, ".harness", "neatroots-sdk");
  const plugin = path.join(workspace, ".opencode", "plugin", "neatlogs.ts");
  const marker = path.join(workspace, ".harness", "neatroots-instrumentation-v1.json");
  for (const rel of [".harness", ".harness/neatroots-sdk", ".harness/neatroots-sdk/node_modules", ".opencode", ".opencode/plugin"]) {
    const dest = path.join(workspace, rel);
    if (fs.lstatSync(dest, { throwIfNoEntry: false }) && (!fs.lstatSync(dest).isDirectory() || fs.lstatSync(dest).isSymbolicLink())) throw new Error("Managed instrumentation directory conflicts with an existing file or link; inspect it before retrying");
  }
  for (const dest of [plugin, marker]) if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Instrumentation file is a link; inspect it before retrying");
  if (fs.existsSync(plugin) && fs.readFileSync(plugin, "utf8") !== registration) throw new Error("Existing .opencode/plugin/neatlogs.ts differs; preserve or relocate it explicitly before retrying");
  for (const name of ["package.json", "package-lock.json"]) {
    const dest = path.join(managed, name);
    if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("SDK package file is a link; inspect it before retrying");
    const expected = fs.readFileSync(path.join(here, "sdk", name));
    if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(expected)) throw new Error("Managed SDK package files differ; inspect them before retrying");
  }
  const receipt = JSON.stringify({ version: 1, sdk: "neatlogs", sdkVersion: version }) + "\n";
  if (fs.existsSync(marker)) {
    if (fs.readFileSync(marker, "utf8") !== receipt) throw new Error("Success marker differs; inspect it before retrying");
    fs.unlinkSync(marker); // A failed repair must not leave a stale success marker.
  }
  const verify = async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(managed, "node_modules/neatlogs/package.json"), "utf8"));
    if (pkg.version !== version) throw new Error("SDK version does not match the pin");
    const url = pathToFileURL(path.join(managed, "node_modules/neatlogs/dist/opencode-plugin.mjs"));
    // A repaired file must not reuse the pre-install module from this process.
    url.searchParams.set("verification", randomUUID());
    const mod = await import(url.href);
    if (typeof mod.NeatlogsOpencodePlugin !== "function") throw new Error("Pinned SDK has no OpenCode plugin export");
  };
  let ready = false;
  try { await verify(); ready = true; } catch { /* install or repair private dependencies */ }
  if (!ready) {
    fs.mkdirSync(managed, { recursive: true });
    for (const name of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(here, "sdk", name), path.join(managed, name));
    const installed = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: managed, stdio: "ignore", timeout: 120_000 });
    if (installed.status !== 0) throw new Error("Pinned SDK installation failed; check npm access/cache and retry workspace initialization");
    await verify();
  }
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  if (!fs.existsSync(plugin)) fs.writeFileSync(plugin, registration, { flag: "wx" });
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, receipt);
  console.log("ok pinned Neatlogs OpenCode instrumentation verified; no trace has been sent by setup");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initialize().catch(e => { console.error(e.message); process.exitCode = 1; });
}
