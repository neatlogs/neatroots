import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registration, version } from "./init-workspace.mjs";
try {
  const w = fs.realpathSync(process.argv[2]);
  for (const name of [".harness", ".harness/neatroots-sdk", ".harness/neatroots-sdk/node_modules", ".opencode", ".opencode/plugin"]) {
    const s = fs.lstatSync(path.join(w, name));
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("not a managed directory");
  }
  const plugin = path.join(w, ".opencode/plugin/neatlogs.ts");
  if (fs.lstatSync(plugin).isSymbolicLink() || fs.readFileSync(plugin, "utf8") !== registration) throw new Error("registration mismatch");
  const marker = JSON.parse(fs.readFileSync(path.join(w, ".harness/neatroots-instrumentation-v1.json")));
  const pkg = JSON.parse(fs.readFileSync(path.join(w, ".harness/neatroots-sdk/node_modules/neatlogs/package.json")));
  if (marker.version !== 1 || marker.sdk !== "neatlogs" || marker.sdkVersion !== version || pkg.version !== version) throw new Error("version mismatch");
  const mod = await import(pathToFileURL(path.join(w, ".harness/neatroots-sdk/node_modules/neatlogs/dist/opencode-plugin.mjs")));
  if (typeof mod.NeatlogsOpencodePlugin !== "function") throw new Error("missing export");
} catch {
  console.error("miss workspace instrumentation: verify registration, pinned SDK and success marker; retry initialization");
  process.exitCode = 1;
}
