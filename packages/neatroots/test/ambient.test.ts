import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmbientService } from "../src/ambient/service.js";
import { logOutput } from "../src/ambient/log.js";
import type { AmbientChecks } from "../src/ambient/types.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanups.splice(0)) await fn(); });
const on = { enabled: true, outputs: { log: { enabled: true } } };
async function setup() {
  const tb = await makeRoots({ noEngine: true });
  cleanups.push(tb.close);
  const write = vi.fn();
  let checks: AmbientChecks = "unknown";
  const service = new AmbientService(tb.roots.store, tb.roots.bus, { setState: write }, () => checks);
  cleanups.unshift(() => service.close());
  return { tb, service, write, setChecks: (value: AmbientChecks) => { checks = value; } };
}
function run(tb: TestRoots, project = "project", live = false, status = 1) {
  const tid = hex(16);
  const sp = span({ traceId: tid, name: "private prompt must never be logged", kind: "workflow", status });
  if (live) sp.endTimeUnixNano = "0";
  tb.roots.ingest([batch([sp], project)]);
  return tid;
}
function finding(tb: TestRoots, id: string, check = "tool-cycle", status: "raised" | "failed" = "raised") {
  const f = tb.roots.store.insertFinding({ trace_id: id, check_id: check, check_kind: "rule", title: "private finding", probability: null,
    status, evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  tb.roots.bus.emit("finding", f);
  return f;
}

describe("ambient outputs", () => {
  it("keeps malformed hand-written config off unless each switch is literally true", async () => {
    const { tb } = await setup();
    const previous = process.env.NEATROOTS_HOME;
    process.env.NEATROOTS_HOME = tb.roots.home;
    try {
      fs.writeFileSync(path.join(tb.roots.home, "config.yaml"), 'ambient:\n  enabled: "true"\n  outputs:\n    log:\n      enabled: "false"\n');
      expect(loadConfig().ambient).toEqual(defaultConfig().ambient);
    } finally { process.env.NEATROOTS_HOME = previous; }
  });

  it("requires both explicit opt-ins and removes its subscriber and timer on disable", async () => {
    const { tb, service, write } = await setup();
    vi.useFakeTimers();
    const initial = vi.getTimerCount();
    service.configure(defaultConfig().ambient);
    service.configure({ ...on, enabled: false });
    service.configure({ enabled: true, outputs: { log: { enabled: false } } });
    run(tb, "off", true);
    expect(write).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({ state: "inactive", subscribed: false });
    service.configure(on);
    expect(service.status()).toMatchObject({ state: "live", subscribed: true });
    expect(vi.getTimerCount()).toBe(initial + 1);
    service.configure({ ...on, enabled: false });
    expect(vi.getTimerCount()).toBe(initial);
    expect(service.status()).toMatchObject({ state: "inactive", trace_id: null, subscribed: false });
    write.mockClear();
    run(tb, "after-disable", true);
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it("never treats root end, missing receipt or a failed check as green or a failed run", async () => {
    const { tb, service, setChecks } = await setup();
    vi.useFakeTimers();
    service.configure(on);
    setChecks("checking");
    const id = run(tb);
    expect(service.status().state).toBe("checking");
    setChecks("unknown"); vi.advanceTimersByTime(250);
    expect(service.status().state).toBe("incomplete");
    setChecks("settled"); vi.advanceTimersByTime(250);
    expect(service.status().state).toBe("success");
    const f = finding(tb, id, "a-question", "failed");
    expect(service.status().state).toBe("incomplete");
    tb.roots.store.updateFinding(f.id, { status: "resolved" }); vi.advanceTimersByTime(250);
    expect(service.status().state).toBe("success");
    finding(tb, id);
    expect(service.status().state).toBe("loop"); // late finding replaces green immediately
  });

  it("selects concurrent projects deterministically and distinguishes errors and interruptions", async () => {
    const { tb, service } = await setup();
    service.configure(on);
    const a = run(tb, "a", true), b = run(tb, "b", true);
    tb.roots.store.db.prepare("UPDATE runs SET received_ms = 100 WHERE trace_id IN (?,?)").run(a, b);
    const selected = [a, b].sort()[0];
    tb.roots.bus.emit("settings", {});
    expect(service.status()).toMatchObject({ trace_id: selected, state: "live", active_runs: 2 });
    tb.roots.bus.emit("activity", { trace_id: selected === a ? b : a, kind: "checking", message: "private" });
    expect(service.status().trace_id).toBe(selected);
    finding(tb, a);
    expect(service.status()).toMatchObject({ trace_id: a, project: "a", state: "loop", active_runs: 2 });
    tb.roots.store.db.prepare("UPDATE runs SET status = 'interrupted', interrupted = 1 WHERE trace_id = ?").run(b);
    tb.roots.bus.emit("settings", {});
    expect(service.status().state).toBe("loop");
    tb.roots.store.db.prepare("UPDATE runs SET status = 'error' WHERE trace_id = ?").run(b);
    tb.roots.bus.emit("settings", {});
    expect(service.status()).toMatchObject({ trace_id: a, state: "loop" }); // current work wins over b's completed error
    tb.roots.store.updateFinding(tb.roots.store.findingsForTrace(a)[0].id, { status: "resolved" });
    tb.roots.store.db.prepare("UPDATE runs SET status = 'ok', received_ms = 90 WHERE trace_id = ?").run(a);
    tb.roots.store.db.prepare("UPDATE runs SET status = 'interrupted' WHERE trace_id = ?").run(b);
    tb.roots.bus.emit("settings", {});
    expect(service.status().state).toBe("interrupted");
  });

  it("replaces an old error with a new live and clean run, never redisplaying historical failure", async () => {
    const { tb, service, setChecks } = await setup();
    vi.useFakeTimers(); service.configure(on);
    const old = run(tb, "old-project", false, 2);
    tb.roots.store.db.prepare("UPDATE runs SET received_ms = 1 WHERE trace_id = ?").run(old);
    expect(service.status().state).toBe("error");
    const fresh = run(tb, "current-project", true);
    expect(service.status()).toMatchObject({ trace_id: fresh, project: "current-project", state: "live", active_runs: 1 });
    setChecks("settled");
    tb.roots.store.db.prepare("UPDATE runs SET status = 'ok', root_ended = 1 WHERE trace_id = ?").run(fresh);
    vi.advanceTimersByTime(250);
    expect(service.status()).toMatchObject({ trace_id: fresh, state: "success", active_runs: 0 });
    vi.advanceTimersByTime(10_000);
    expect(service.status()).toMatchObject({ trace_id: null, state: "idle" });
    finding(tb, old); // A late event in an old run must not steal the current outcome.
    expect(service.status()).toMatchObject({ trace_id: null, state: "idle" });
  });

  it("clears a settled result after its display window and isolates a failing output", async () => {
    const { tb, service, setChecks, write } = await setup();
    vi.useFakeTimers(); service.configure(on); setChecks("settled"); run(tb);
    expect(service.status().state).toBe("success");
    vi.advanceTimersByTime(10_000);
    expect(service.status().state).toBe("idle");
    write.mockImplementation(() => { throw new Error("private failure"); });
    expect(() => run(tb, "live", true)).not.toThrow();
    expect(service.status().output_error).toBe(true);
    service.close();
    expect(service.status()).toMatchObject({ state: "inactive", output_error: false });
  });

  it("releases transition metadata when runs are deleted or become doctor runs", async () => {
    const { tb, service } = await setup();
    vi.useFakeTimers(); service.configure(on);
    const removed = run(tb, "deleted", true);
    const doctor = run(tb, "doctor", true);
    // Inspect retained lifecycle state: a rendered idle signal alone cannot detect this leak.
    const retained = service as unknown as { observed: Set<string>; transitions: Map<string, unknown> };
    expect(retained.transitions.size).toBe(2);
    tb.roots.store.deleteRun(removed);
    tb.roots.store.db.prepare("UPDATE runs SET doctor = 1 WHERE trace_id = ?").run(doctor);
    vi.advanceTimersByTime(250);
    expect(retained.observed.size).toBe(0);
    expect(retained.transitions.size).toBe(0);
    expect(service.status()).toMatchObject({ state: "idle", active_runs: 0 });
  });

  it("logs only fixed state and count, not any trace or project payload", () => {
    const write = vi.fn();
    logOutput(write).setState({ state: "loop", active_runs: 2, trace_id: "secret-id", project: "private", workflow: "private" });
    expect(write).toHaveBeenCalledExactlyOnceWith('[ambient] {"state":"loop","active_runs":2}');
  });

  it("validates settings atomically, persists both opt-ins and exposes inactive status", async () => {
    const { tb } = await setup();
    const app = createApp(tb.roots);
    const post = (body: unknown) => app.request("/api/settings", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });
    expect((await post({ ambient_enabled: true, ambient_log_enabled: "yes" })).status).toBe(400);
    expect(tb.roots.config.ambient.enabled).toBe(false);
    expect((await post({ ambient_enabled: true, ambient_log_enabled: true })).status).toBe(200);
    expect(tb.roots.ambient.status().subscribed).toBe(true);
    const config = fs.readFileSync(path.join(tb.roots.home, "config.yaml"), "utf8");
    expect(config).toContain("ambient:");
    expect((await post({ ambient_enabled: false })).status).toBe(200);
    expect(tb.roots.ambient.status()).toMatchObject({ state: "inactive", log_enabled: true });
  });
});
