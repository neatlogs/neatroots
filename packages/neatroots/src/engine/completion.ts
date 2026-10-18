import crypto from "node:crypto";
import type { Store } from "../store/db.js";

/** Only an end pass and drain from the current generation can certify checks. */
export class CheckCompletion {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS check_completion (
      trace_id TEXT PRIMARY KEY, generation TEXT NOT NULL DEFAULT '',
      ended INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
      settled INTEGER NOT NULL DEFAULT 0, recheck_required INTEGER NOT NULL DEFAULT 0)`);
    const columns = store.db.prepare("PRAGMA table_info(check_completion)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "generation")) {
      store.db.exec("ALTER TABLE check_completion ADD COLUMN generation TEXT NOT NULL DEFAULT ''; UPDATE check_completion SET ended=0,settled=0");
    }
    if (!columns.some((c) => c.name === "recheck_required"))
      store.db.exec("ALTER TABLE check_completion ADD COLUMN recheck_required INTEGER NOT NULL DEFAULT 0");
    store.db.exec(`CREATE TRIGGER IF NOT EXISTS check_completion_delete_run AFTER DELETE ON runs BEGIN
      DELETE FROM check_completion WHERE trace_id=OLD.trace_id;
    END; DELETE FROM check_completion WHERE trace_id NOT IN (SELECT trace_id FROM runs);`);
    if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='check_progress'").get())
      store.db.exec("UPDATE check_completion SET ended=0,settled=0 WHERE trace_id IN (SELECT trace_id FROM check_progress)");
  }
  begin(id: string): string {
    const generation = crypto.randomUUID();
    if (this.store.db.open && this.store.getRun(id)) this.store.db.prepare(`INSERT INTO check_completion(trace_id,generation) VALUES (?,?)
      ON CONFLICT(trace_id) DO UPDATE SET generation=excluded.generation,ended=0,failed=0,settled=0,recheck_required=0`).run(id, generation);
    return generation;
  }
  isCurrent(id: string, generation: string): boolean {
    return this.store.db.open && !!this.store.db.prepare("SELECT 1 FROM check_completion WHERE trace_id=? AND generation=?").get(id, generation);
  }
  /** Changed evidence after the end pass began needs an explicit fresh evaluation. */
  requireRecheck(id: string): void {
    const generation = this.begin(id);
    this.set(id, generation, "recheck_required=1");
  }
  requiresRecheck(id: string): boolean {
    if (!this.store.db.open) return false;
    return !!(this.store.db.prepare("SELECT recheck_required FROM check_completion WHERE trace_id=?").get(id) as { recheck_required: number } | undefined)?.recheck_required;
  }
  hasEnded(id: string): boolean {
    if (!this.store.db.open) return false;
    return !!(this.store.db.prepare("SELECT ended FROM check_completion WHERE trace_id=?").get(id) as { ended: number } | undefined)?.ended;
  }
  private set(id: string, generation: string, fields: string): void {
    if (this.store.db.open) this.store.db.prepare(`UPDATE check_completion SET ${fields} WHERE trace_id=? AND generation=?`).run(id, generation);
  }
  started(id: string, generation: string): void { this.set(id, generation, "settled=0"); }
  failed(id: string, generation: string): void { this.set(id, generation, "failed=1,settled=0"); }
  ended(id: string, generation: string): void { this.set(id, generation, "ended=1"); }
  settle(id: string, generation: string): void {
    if (this.store.db.open) this.store.db.prepare("UPDATE check_completion SET settled=1 WHERE trace_id=? AND generation=? AND ended=1").run(id, generation);
  }
  state(id: string): "pending" | "failed" | "settled" {
    if (!this.store.db.open || !this.store.getRun(id)) return "pending";
    if (this.requiresRecheck(id)) return "pending";
    const row = this.store.db.prepare("SELECT * FROM check_completion WHERE trace_id=?").get(id) as { failed: number; settled: number } | undefined;
    return row?.failed ? "failed" : row?.settled ? "settled" : "pending";
  }
}
