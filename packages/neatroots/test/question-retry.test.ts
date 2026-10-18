import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, span, toolSpan, until } from "./helpers.js";

// A question whose model call fails once (a timeout or a dropped connection) is asked again later,
// instead of being skipped for good.

const ASK = "Did the payment tool report that the charge did not go through?";
const check = (scope: "span" | "trace") =>
  parseChecks(`
- id: charge-failed
  kind: yes_no
  scope: ${scope}
  title: Charge did not go through
  ask: ${ASK}
  flag_at: 0.5
  evidence: { spans: { tool: charge_card } }
`).checks[0];

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** A mock LLM that says yes about the declined charge, and drops the first request about it (or every one). */
async function flakyLlm(opts: { always?: boolean } = {}) {
  const yes = await mockLlm({ yesWhen: ["charge did not go through"] });
  const no = await mockLlm({});
  const seen = { dropped: 0, asked: 0 };
  const proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString();
      const declined = body.includes("card declined") && body.includes("charge did not go through");
      if (declined) seen.asked++;
      if (declined && (opts.always || !seen.dropped)) {
        seen.dropped++;
        req.socket.destroy();
        return;
      }
      const target = new URL(declined ? yes.url : no.url);
      const r = await fetch(`${target.origin}${req.url ?? ""}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : body });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(await r.text());
    });
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}${new URL(no.url).pathname}`;
  cleanup.push(async () => {
    await yes.close();
    await no.close();
    await new Promise((r) => proxy.close(r));
  });
  return { url, seen };
}

describe("a question whose model call failed", () => {
  it.each(["span", "trace"] as const)("is asked again at run end (%s scope)", async (scope) => {
    const llm = await flakyLlm();
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check(scope), "user");
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a billing agent.", user: "Charge order 4513" })])]);
    await tb.roots.engine!.waitIdle(t, 10_000);
    tb.roots.ingest([batch([toolSpan(t, root, "charge_card", '{"order":"4513"}', '{"status":"card declined"}')])]);
    // The live check's call is dropped; the run then ends.
    await until(() => llm.seen.dropped === 1, 10_000);
    await tb.roots.engine!.waitIdle(t, 10_000);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "continue", out: "Order 4513 is charged." }), span({ traceId: t, spanId: root, name: "billing", kind: "workflow" }), markerSpan(t, root)])]);
    await until(() => tb.roots.store.getSummary(t), 20_000);
    await tb.roots.engine!.waitIdle(t, 10_000);
    expect(llm.seen.asked).toBeGreaterThanOrEqual(2);
    expect(tb.roots.store.findingsForTrace(t).some((f) => f.check_id === "charge-failed")).toBe(true);
  });

  it("is retried a bounded number of times when the model keeps failing (span scope)", async () => {
    const llm = await flakyLlm({ always: true });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check("span"), "user");
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a billing agent.", user: "Charge ten orders" })])]);
    await tb.roots.engine!.waitIdle(t, 10_000);
    for (let i = 0; i < 10; i++) {
      tb.roots.ingest([batch([toolSpan(t, root, "charge_card", `{"order":"${4500 + i}"}`, '{"status":"card declined"}')])]);
      await tb.roots.engine!.waitIdle(t, 10_000);
    }
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "billing", kind: "workflow" }), markerSpan(t, root)])]);
    await until(() => tb.roots.store.getSummary(t), 20_000);
    await tb.roots.engine!.waitIdle(t, 10_000);
    // With the LLM standing in, span questions are capped at 4 attempts per run (SLOW_SPAN_CHECKS_PER_RUN),
    // and run-end retries count against the same cap.
    expect(llm.seen.asked).toBeGreaterThan(0);
    expect(llm.seen.asked).toBeLessThanOrEqual(4);
  });

  it("is retried at most once at run end when the model keeps failing (trace scope)", async () => {
    const llm = await flakyLlm({ always: true });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check("trace"), "user");
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a billing agent.", user: "Charge order 4513" })])]);
    await tb.roots.engine!.waitIdle(t, 10_000);
    tb.roots.ingest([batch([toolSpan(t, root, "charge_card", '{"order":"4513"}', '{"status":"card declined"}')])]);
    await until(() => llm.seen.asked >= 1, 10_000);
    await tb.roots.engine!.waitIdle(t, 10_000);
    const live = llm.seen.asked;
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "billing", kind: "workflow" }), markerSpan(t, root)])]);
    await until(() => tb.roots.store.getSummary(t), 20_000);
    await tb.roots.engine!.waitIdle(t, 10_000);
    expect(llm.seen.asked).toBe(live + 1);
  });
});
