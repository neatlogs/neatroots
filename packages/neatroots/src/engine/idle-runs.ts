import { validRunIdleMinutes } from "../config.js";
import type { Roots } from "../core.js";
import { log } from "../util/log.js";

/** Bounds transitions separately from model work; receipts survive a restart. */
export class IdleRuns {
  private readonly active = new Set<string>();
  private readonly timer: NodeJS.Timeout;
  private readonly startup: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly roots: Roots) {
    const tick = () => { void this.sweep().catch(e => log.warn(`idle-run sweep failed: ${(e as Error).message}`)); };
    this.timer = setInterval(tick, 60_000); this.timer.unref();
    this.startup = setTimeout(tick, 1500); this.startup.unref();
  }
  async sweep(now = Date.now()): Promise<number> {
    const configured = this.roots.config.runIdleMinutes;
    const minutes = validRunIdleMinutes(configured) ? configured : 10;
    if (this.closed || minutes === 0) return 0;
    this.roots.store.liveness.seedLegacy(now);
    const expired = this.roots.store.liveness.expire(now, minutes);
    for (const traceId of expired) this.roots.bus.emit("trace", { traceId, spans: [], runCreated: false, rootEnded: false, completed: false });
    if (!this.roots.engine) return expired.length;
    const work = this.roots.store.liveness.pending(now, Math.max(0, 4 - this.active.size))
      .filter(id => !this.active.has(id) && !this.roots.engine!.pending(id));
    await Promise.all(work.map(async id => {
      this.active.add(id);
      try {
        await this.roots.engine!.endIdle(id);
        if (!this.closed) this.roots.store.liveness.settled(id);
      } finally { this.active.delete(id); }
    }));
    return expired.length;
  }
  close(): void { this.closed = true; clearInterval(this.timer); clearTimeout(this.startup); }
}
