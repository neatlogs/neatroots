#!/usr/bin/env node
// Builds the prebuilt download: release/neatroots.tar.gz and release/neatroots.tar.gz.sha256.
//
//   pnpm install --frozen-lockfile && pnpm build && node scripts/package.mjs
//
// One bundle serves macOS and Linux on arm64 and x64: the code is JavaScript, and better-sqlite3
// ships Node-API binaries for each platform, which work on any Node 22+. install.sh supplies Node
// when the machine has none. Unpacked to ~/.neatroots/app:
//
//   neatroots/dist/cli.js (+ dist/ui, library, proto, node_modules)
//   steer/python/neatroots-steer   steer/ts   examples/   skills/   docs/   install.sh   .neatroots-bundle

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "release");
const stage = path.join(outDir, "stage");
const log = (m) => console.log(`[package] ${m}`);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", cwd: root, ...opts });
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

for (const f of ["packages/neatroots/dist/cli.js", "packages/neatroots/dist/ui/index.html", "packages/steer-ts/dist/index.js"]) {
  if (!fs.existsSync(path.join(root, f))) throw new Error(`${f} is missing; run pnpm build first`);
}
const version = JSON.parse(fs.readFileSync(path.join(root, "packages/neatroots/package.json"), "utf8")).version;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// ------------------------------------------------------------ the app
log(`deploying @neatlogs/neatroots ${version} with production dependencies`);
run("pnpm", ["--filter", "@neatlogs/neatroots", "deploy", "--prod", "--legacy", path.join(stage, "neatroots")]);

const sqlite = fs.realpathSync(path.join(stage, "neatroots/node_modules/better-sqlite3"));
// A local build (build/Release) would win over the prebuilt binaries and only fits this machine;
// the SQLite sources are only for compiling.
for (const f of ["build", "deps", "src", "binding.gyp"]) fs.rmSync(path.join(sqlite, f), { recursive: true, force: true });
for (const f of fs.readdirSync(path.join(sqlite, "prebuilds"))) {
  if (f.startsWith("win32-")) fs.rmSync(path.join(sqlite, "prebuilds", f));
}
const platforms = fs.readdirSync(path.join(sqlite, "prebuilds")).map((f) => f.replace(/\.node$/, ""));
for (const want of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
  if (!platforms.includes(want)) throw new Error(`better-sqlite3 has no prebuilt binary for ${want}`);
}
log(`better-sqlite3 binaries: ${platforms.join(", ")}`);

// ------------------------------------------------------------ steering hooks, docs, installer
const copy = (from, to, filter) => fs.cpSync(path.join(root, from), path.join(stage, to), { recursive: true, filter });
const skipCaches = (src) => !/(__pycache__|\.pytest_cache|\.venv|node_modules|\.DS_Store)/.test(src);
for (const f of ["dist", "package.json", "README.md", "LICENSE"]) copy(`packages/steer-ts/${f}`, `steer/ts/${f}`);
for (const f of ["src", "pyproject.toml", "README.md", "LICENSE"]) copy(`python/neatroots-steer/${f}`, `steer/python/neatroots-steer/${f}`, skipCaches);
// Every doc (they link to each other) and the images they show.
for (const f of fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md"))) copy(`docs/${f}`, `docs/${f}`);
copy("docs/images", "docs/images");
copy("skills", "skills", skipCaches);
// The examples as committed (no node_modules or venvs), with the hook paths pointed at steer/.
for (const f of execFileSync("git", ["ls-files", "examples"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)) {
  const to = path.join(stage, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const text = fs.readFileSync(path.join(root, f), "utf8");
  if (text.includes("../../python/neatroots-steer")) fs.writeFileSync(to, text.replaceAll("../../python/neatroots-steer", "../../steer/python/neatroots-steer"));
  else fs.copyFileSync(path.join(root, f), to);
}
copy("install.sh", "install.sh");
copy("LICENSE", "LICENSE");
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* not a checkout */
}
fs.writeFileSync(path.join(stage, ".neatroots-bundle"), `${JSON.stringify({ version, commit, built: new Date().toISOString() }, null, 2)}\n`);

// ------------------------------------------------------------ links in the shipped docs resolve
{
  const broken = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name))) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : []));
  for (const file of [...walk(path.join(stage, "docs")), ...walk(path.join(stage, "examples"))]) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) broken.push(`${path.relative(stage, file)} → ${m[1]}`);
    }
  }
  if (broken.length) throw new Error(`the bundle's docs link to files it doesn't ship:\n  ${broken.join("\n  ")}`);
  log("every relative link in the shipped docs and examples resolves");
}

// ------------------------------------------------------------ smoke test, with this machine's Node
const out = execFileSync(process.execPath, [path.join(stage, "neatroots/dist/cli.js"), "--version"], { encoding: "utf8" }).trim();
execFileSync(process.execPath, ["-e", "const D=require(process.argv[1]);const d=new D(':memory:');d.exec('create virtual table t using fts5(x)');d.close()", sqlite]);
log(`smoke test: neatroots ${out}; SQLite with FTS5 opens on ${process.platform}-${process.arch}, Node ${process.versions.node}`);

// ------------------------------------------------------------ archive
const tarball = path.join(outDir, "neatroots.tar.gz");
run("tar", ["-czf", tarball, "-C", stage, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
fs.writeFileSync(`${tarball}.sha256`, `${sha256(tarball)}  ${path.basename(tarball)}\n`);
log(`${path.relative(root, tarball)} (${(fs.statSync(tarball).size / 1e6).toFixed(1)} MB)`);
