import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { copyOfflineApprovalState } from "../src/checks/offline-approval-state.js";
import { Store } from "../src/store/db.js";
const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "offline-state-")); dirs.push(home);
  const temp = new Store(path.join(home, "temp")); stores.push(temp);
  return { home, temp, data: path.join(home, "data"), source: path.join(home, "data", "neatroots.db") };
}
function logical(db: Database.Database) {
  return { schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY type,name").all(), meta: db.prepare("SELECT * FROM meta ORDER BY key").all(), checks: db.prepare("SELECT * FROM checks ORDER BY id").all() };
}
it("fresh CI home needs no home directory or database", () => {
  const t = fixture(), absent = path.join(t.home, "absent"); copyOfflineApprovalState(absent, t.temp); expect(fs.existsSync(absent)).toBe(false);
});
it.each(["corrupt", "schema", "orphan-wal", "orphan-legacy-shm", "unreadable"])("fails closed for %s state reported by filesystem or SQLite", (mode) => {
  const t = fixture(); fs.mkdirSync(t.data);
  if (mode === "schema") { const db = new Database(t.source); db.exec("CREATE TABLE unrelated(x)"); db.close(); }
  else if (mode === "orphan-wal") fs.writeFileSync(`${t.source}-wal`, "orphan");
  else if (mode === "orphan-legacy-shm") fs.writeFileSync(path.join(t.data, "bolts.db-shm"), "orphan");
  else fs.writeFileSync(t.source, "not sqlite");
  if (mode === "unreadable") { const stat = fs.statSync; vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, opts?: unknown) => { if (String(p) === t.source) throw Object.assign(new Error("denied"), { code: "EACCES" }); return stat(p, opts as never); }) as typeof fs.statSync); }
  expect(() => copyOfflineApprovalState(t.home, t.temp)).toThrow(/cannot read offline approval state/);
});
it("reads uncheckpointed WAL origin/grants and latest revocation without logical writes", () => {
  const t = fixture(), live = new Store(t.data); stores.push(live); live.db.pragma("wal_autocheckpoint = 0");
  live.setMeta("mcp_origin:wal", "origin-in-wal"); live.setMeta("approved_mcp:wal", "grant-in-wal");
  expect(fs.statSync(`${t.source}-wal`).size).toBeGreaterThan(32);
  const before = logical(live.db); copyOfflineApprovalState(t.home, t.temp);
  expect(t.temp.getMeta("mcp_origin:wal")).toBe("origin-in-wal"); expect(t.temp.getMeta("approved_mcp:wal")).toBe("grant-in-wal"); expect(logical(live.db)).toEqual(before);
  live.db.prepare("DELETE FROM meta WHERE key='approved_mcp:wal'").run();
  const other = new Store(path.join(t.home, "other")); stores.push(other);
  const revoked = logical(live.db); copyOfflineApprovalState(t.home, other);
  expect(other.getMeta("approved_mcp:wal")).toBeUndefined(); expect(logical(live.db)).toEqual(revoked);
});
it("accepts a normal WAL reset with stale salt frames after the latest commit", () => {
  const t = fixture(), live = new Store(t.data); stores.push(live); live.db.pragma("wal_autocheckpoint = 0");
  for (let i = 0; i < 30; i++) live.setMeta(`history-${i}`, "x".repeat(4000));
  const oldSize = fs.statSync(`${t.source}-wal`).size;
  live.db.pragma("wal_checkpoint(RESTART)"); live.setMeta("mcp_origin:reset", "new-cycle");
  const wal = fs.readFileSync(`${t.source}-wal`), frame = 24 + wal.readUInt32BE(8);
  expect(wal.length).toBe(oldSize);
  expect(Array.from({ length: Math.floor((wal.length - 32) / frame) }, (_, i) => 32 + i * frame).some((offset) => !wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24)))).toBe(true);
  const before = logical(live.db); copyOfflineApprovalState(t.home, t.temp);
  expect(t.temp.getMeta("mcp_origin:reset")).toBe("new-cycle"); expect(logical(live.db)).toEqual(before);
});
it("native reader can coordinate missing SHM and retains legacy database compatibility", () => {
  const t = fixture(), producer = new Store(path.join(t.home, "producer")); stores.push(producer); producer.setMeta("mcp_origin:legacy", "wal-only-origin");
  fs.mkdirSync(t.data); const legacy = path.join(t.data, "bolts.db");
  fs.copyFileSync(producer.file, legacy); fs.copyFileSync(`${producer.file}-wal`, `${legacy}-wal`);
  expect(fs.existsSync(`${legacy}-shm`)).toBe(false); copyOfflineApprovalState(t.home, t.temp);
  expect(t.temp.getMeta("mcp_origin:legacy")).toBe("wal-only-origin");
  const verify = new Database(legacy, { readonly: true, fileMustExist: true });
  try { expect(verify.prepare("SELECT value FROM meta WHERE key='mcp_origin:legacy'").get()).toEqual({ value: "wal-only-origin" }); } finally { verify.close(); }
});
it("origin and legacy rows share one read snapshot across a concurrent WAL commit", () => {
  const t = fixture(), live = new Store(t.data); stores.push(live);
  live.setMeta("mcp_origin:consistent", "before"); live.upsertCheckRow({ id: "consistent", kind: "rule", source: "mcp", path: "/existing.yaml", body: "before" });
  const prepare = Database.prototype.prepare; let changed = false;
  const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function(this: Database.Database, sql: string) {
    if (!changed && sql.startsWith("SELECT id, kind, source, path")) { changed = true; live.db.exec("BEGIN; UPDATE meta SET value='after' WHERE key='mcp_origin:consistent'; UPDATE checks SET source='user',enabled=0 WHERE id='consistent'; COMMIT;"); }
    return prepare.call(this, sql);
  } as typeof Database.prototype.prepare);
  try { copyOfflineApprovalState(t.home, t.temp); } finally { spy.mockRestore(); }
  expect(changed).toBe(true); expect(t.temp.getMeta("mcp_origin:consistent")).toBe("before");
  expect(t.temp.db.prepare("SELECT source,enabled FROM checks WHERE id='consistent'").get()).toEqual({ source: "mcp", enabled: 1 });
  expect(live.getMeta("mcp_origin:consistent")).toBe("after");
});
it("a healthy database above 256 MiB reads only approval metadata without full-file buffering", () => {
  const t = fixture(); fs.mkdirSync(t.data); const db = new Database(t.source);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE checks(id TEXT, kind TEXT, source TEXT, path TEXT, body TEXT, enabled INTEGER); CREATE TABLE payload(body BLOB); INSERT INTO payload VALUES(zeroblob(269484032)); INSERT INTO meta VALUES('mcp_origin:large', 'retained');"); db.close();
  const before = fs.statSync(t.source); expect(before.size).toBeGreaterThan(256 * 1024 * 1024);
  const read = fs.readFileSync; const whole = vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, opts?: unknown) => { if (String(p) === t.source) throw new Error("whole source read forbidden"); return read(p, opts as never); }) as typeof fs.readFileSync);
  copyOfflineApprovalState(t.home, t.temp); whole.mockRestore(); expect(t.temp.getMeta("mcp_origin:large")).toBe("retained");
  expect(fs.statSync(t.source).size).toBe(before.size); expect(fs.statSync(t.source).mtimeMs).toBe(before.mtimeMs);
  const verify = new Database(t.source, { readonly: true, fileMustExist: true });
  try { expect(verify.prepare("SELECT length(body) AS n FROM payload").get()).toEqual({ n: 269484032 }); } finally { verify.close(); }
}, 30_000);