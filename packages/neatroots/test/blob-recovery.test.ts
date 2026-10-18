import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { defaultConfig } from "../src/config.js";
import { sha256 } from "../src/util/ids.js";
import { batch, closeTrackedStores, hex, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
const home = () => { const dir = tmpHome(); homes.push(dir); return dir; };
const fileOf = (dir: string, sha: string) => path.join(dir, "blobs", sha.slice(0, 2), sha.slice(2));
const payload = "kept " + "\u00e9".repeat(40_000);
function send(st: ReturnType<typeof trackedStore>, traceId = hex(16), text = payload) {
  const b = batch([span({ traceId, name: "payload", kind: "tool", attrs: [s("payload", text)] })]);
  st.ingest([b]);
  return b;
}
function leftover(dir: string, sha = "f".repeat(64), suffix = "") {
  const file = fileOf(dir, sha) + suffix;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "interrupted");
  return file;
}
afterEach(() => {
  vi.restoreAllMocks(); closeTrackedStores();
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("secondary connections preserve leftovers; only explicit owner startup reclaims them", () => {
  const root = home(); const dir = path.join(root, "data");
  const st = trackedStore(dir); send(st);
  const orphan = leftover(dir); const temp = leftover(dir, "e".repeat(64), ".123." + "a".repeat(32) + ".tmp");
  const secondary = trackedStore(dir);
  expect(fs.existsSync(orphan)).toBe(true); expect(fs.existsSync(temp)).toBe(true);
  expect(secondary.recoverBlobs()).toBe(2);
  expect(fs.existsSync(orphan)).toBe(false); expect(fs.existsSync(temp)).toBe(false);
  const final = leftover(dir);
  const cfg = defaultConfig(); cfg.classifier.laya.enabled = false;
  const roots = new Roots({ home: root, config: cfg, noEngine: true, recoverBlobs: true });
  try { expect(fs.existsSync(final)).toBe(false); } finally { roots.close(); }
});

it("retains every committed reference including shared and pinned payloads", () => {
  const dir = path.join(home(), "data"); const st = trackedStore(dir);
  const a = send(st); const b = send(st); st.setPinned(a.spans[0].traceId, true);
  const orphan = leftover(dir);
  expect(st.recoverBlobs()).toBe(1); expect(fs.existsSync(orphan)).toBe(false);
  for (const expected of [a, b]) expect(st.batchesForTraces([expected.spans[0].traceId])[0].spans[0].attributes).toEqual(expected.spans[0].attributes);
});

it.each(["not-json", "{}", '[123]', '["not-a-hash"]'])("aborts before removal on malformed references: %s", (invalid) => {
  const dir = path.join(home(), "data"); const st = trackedStore(dir); send(st);
  st.db.prepare("UPDATE spans SET blobs = ?").run(invalid);
  const orphan = leftover(dir);
  expect(() => st.recoverBlobs()).toThrow(); expect(fs.existsSync(orphan)).toBe(true);
});

it("preserves unknown entries and never follows symlinks", () => {
  const root = home(); const dir = path.join(root, "data"); const st = trackedStore(dir);
  const outside = path.join(root, "outside"); fs.mkdirSync(outside);
  const outsideFile = path.join(outside, "a".repeat(62)); fs.writeFileSync(outsideFile, "external");
  fs.symlinkSync(outside, path.join(dir, "blobs", "aa"), "dir");
  fs.mkdirSync(path.join(dir, "blobs", "bb"));
  fs.symlinkSync(outsideFile, path.join(dir, "blobs", "bb", "b".repeat(62)));
  const unknown = leftover(dir, "c".repeat(64), ".notes");
  const unknownTemp = leftover(dir, "d".repeat(64), ".123.tmp");
  expect(st.recoverBlobs()).toBe(0);
  expect(fs.readFileSync(outsideFile, "utf8")).toBe("external");
  expect(fs.existsSync(unknown)).toBe(true); expect(fs.existsSync(unknownTemp)).toBe(true);
  expect(fs.lstatSync(path.join(dir, "blobs", "bb", "b".repeat(62))).isSymbolicLink()).toBe(true);
});

it("reports cleanup errors and leaves the failed payload for a later attempt", () => {
  const dir = path.join(home(), "data"); const st = trackedStore(dir); const orphan = leftover(dir);
  const error = Object.assign(new Error("cannot unlink"), { code: "EACCES" });
  vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw error; });
  expect(() => st.recoverBlobs()).toThrow(error); expect(fs.existsSync(orphan)).toBe(true);
  vi.restoreAllMocks(); expect(st.recoverBlobs()).toBe(1);
});

it("closes the owner database and aborts startup if recovery fails", () => {
  const root = home(); const st = trackedStore(path.join(root, "data")); send(st);
  st.db.prepare("UPDATE spans SET blobs = 'invalid'").run();
  expect(() => new Roots({ home: root, config: defaultConfig(), noEngine: true, recoverBlobs: true })).toThrow();
  // No writer transaction is leaked by the failed owner initialization.
  expect(st.db.prepare("UPDATE spans SET blobs = NULL").run().changes).toBe(1);
});

function child(script: string) {
  const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module"]);
  proc.stdin.end(script);
  let stderr = ""; proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    proc.once("exit", (code) => resolve({ code, stderr }));
    proc.once("error", (error) => resolve({ code: -1, stderr: error.message }));
  });
  return { proc, exited };
}
async function waitFile(file: string) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`child did not create ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("excludes a second ingest between the reference snapshot and unlink, then preserves its retry", async () => {
  const root = home(); const dir = path.join(root, "data"); const st = trackedStore(dir);
  const b = batch([span({ traceId: hex(16), name: "arriving", kind: "tool", attrs: [s("payload", payload)] })]);
  const module = new URL("../src/store/db.ts", import.meta.url).href;
  const ready = path.join(root, "ready"); const go = path.join(root, "go"); const result = path.join(root, "result"); const retry = path.join(root, "retry");
  const orphan = leftover(dir);
  const runner = child(`import fs from 'node:fs'; import { Store } from ${JSON.stringify(module)};
    const st = new Store(${JSON.stringify(dir)}); st.db.pragma('busy_timeout = 0');
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); let attempted = false;
    const tick = setInterval(() => {
      if (!attempted && fs.existsSync(${JSON.stringify(go)})) {
        attempted = true; let status = 'committed';
        try { st.ingest([${JSON.stringify(b)}]); } catch (e) { status = e.code; }
        fs.writeFileSync(${JSON.stringify(result)}, status);
      }
      if (fs.existsSync(${JSON.stringify(retry)})) { clearInterval(tick); st.ingest([${JSON.stringify(b)}]); st.close(); }
    }, 5);`);
  try {
    await waitFile(ready);
    const reclaim = st.blobs.reclaimExcept.bind(st.blobs);
    vi.spyOn(st.blobs, "reclaimExcept").mockImplementationOnce((used) => {
      // The SELECT has returned; force the other process to attempt a real ingest right now.
      fs.writeFileSync(go, "go"); const deadline = Date.now() + 5_000;
      while (!fs.existsSync(result) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      expect(fs.readFileSync(result, "utf8")).toBe("SQLITE_BUSY");
      expect(fs.existsSync(fileOf(dir, sha256(payload)))).toBe(false);
      return reclaim(used);
    });
    expect(st.recoverBlobs()).toBe(1); expect(fs.existsSync(orphan)).toBe(false);
    fs.writeFileSync(retry, "retry");
    const done = await runner.exited; expect(done).toEqual({ code: 0, stderr: "" });
    expect(st.batchesForTraces([b.spans[0].traceId])[0].spans[0].attributes).toEqual(b.spans[0].attributes);
  } finally { if (runner.proc.exitCode === null) { runner.proc.kill(); await runner.exited; } }
}, 20_000);

it("opens secondary stores alongside repeated acknowledged ingests without removing payloads", async () => {
  const root = home(); const dir = path.join(root, "data"); const st = trackedStore(dir); const orphan = leftover(dir);
  const module = new URL("../src/store/db.ts", import.meta.url).href;
  const runner = child(`import { Store } from ${JSON.stringify(module)};
    for(let i=0;i<12;i++){ const st=new Store(${JSON.stringify(dir)}); st.close(); await new Promise(r=>setTimeout(r,5)); }`);
  const expected = [];
  try {
    for (let i = 0; i < 20; i++) { expected.push(send(st, hex(16), `${i}:` + payload)); await new Promise((resolve) => setTimeout(resolve, 5)); }
    expect(await runner.exited).toEqual({ code: 0, stderr: "" });
    expect(fs.existsSync(orphan)).toBe(true);
    for (const b of expected) expect(st.batchesForTraces([b.spans[0].traceId])[0].spans[0].attributes).toEqual(b.spans[0].attributes);
  } finally { if (runner.proc.exitCode === null) { runner.proc.kill(); await runner.exited; } }
}, 20_000);
