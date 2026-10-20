import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { Roots } from "../src/core.js";
import { batch, freePort, hex, llmSpan, markerSpan, mockLlm, span, tmpHome, toolSpan, until } from "./helpers.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe("a restart with check work queued", () => {
  it("finishes the run's checks, without asking what was already answered", async () => {
    const llm = await mockLlm({ delayMs: 300 });
    const home = tmpHome();
    cleanup.push(() => llm.close(), () => fs.rmSync(home, { recursive: true, force: true }));
    const cfg = defaultConfig();
    cfg.port = await freePort();
    cfg.llm = { ...cfg.llm, baseUrl: llm.url, model: "mock-model", enabled: true };
    cfg.classifier.backend = "llm";
    cfg.classifier.baseUrl = "http://127.0.0.1:9";
    cfg.classifier.laya.enabled = false;

    let roots = new Roots({ home, config: cfg });
    const t = hex(16);
    const root = hex(8);
    roots.ingest([
      batch([
        llmSpan(t, root, { system: "You are a refund agent.", user: "Refund order 4512", toolCalls: [{ name: "lookup_order", args: '{"order_id":"4512"}' }], tools: ["lookup_order"] }),
        toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404: not found"),
        llmSpan(t, root, { user: "continue", out: "Refunded order 4512." }),
        span({ traceId: t, spanId: root, name: "refund", kind: "workflow" }),
        markerSpan(t, root),
      ]),
    ]);
    // Stop the process part way: some answers stored, more still queued.
    await until(() => roots.store.decisionsForTrace(t).length >= 1 && roots.engine!.pending(t) > 0, 15_000);
    expect(roots.engine!.progress.state(t)).toBe("checking");
    const before = roots.store.decisionsForTrace(t).map((d) => `${d.check_id}:${d.span_id ?? "run"}`);
    roots.close();

    roots = new Roots({ home, config: cfg });
    cleanup.push(() => roots.close());
    const r = roots;
    await until(() => r.engine!.progress.state(t) === undefined && r.engine!.pending(t) === 0 && r.store.getSummary(t), 30_000);
    const after = r.store.decisionsForTrace(t).map((d) => `${d.check_id}:${d.span_id ?? "run"}`);
    expect(after.length).toBeGreaterThan(before.length);
    for (const k of before) expect(after.filter((x) => x === k)).toHaveLength(1);
  }, 60_000);
});
