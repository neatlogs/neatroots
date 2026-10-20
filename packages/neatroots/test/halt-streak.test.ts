import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, closeTrackedStores, hex, llmSpan, makeRoots, mockLlm, tmpHome, toolSpan, trackedStore, until, type TestRoots } from "./helpers.js";

// A user's halt rule whose streak ends before the agent's next LLM call (#84).

const USER_RULES = `
- id: stop-on-errors
  kind: rule
  title: Two tool calls failed in a row
  action: halt
  rule: { type: errors, span: { type: [tool, mcp_tool] }, consecutive: 2 }
  guidance: Stop. Two tool calls failed.
- id: stop-repeat
  kind: rule
  title: Same tool called 3 times with the same input
  action: halt
  rule: { type: repeat, span: { type: [tool, mcp_tool] }, same: [tool, input], at_least: 3 }
  guidance: Stop repeating {tool}.
`;
const rules = parseChecks(USER_RULES).checks as RuleCheck[];
const rule = (id: string) => rules.find((c) => c.id === id)!;

const homes: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function store(): Store {
  const h = tmpHome();
  homes.push(h);
  return trackedStore(path.join(h, "data"));
}

async function setup(withUserRules = true) {
  const llm = await mockLlm({});
  const tb = await makeRoots({ llmUrl: llm.url });
  cleanup.push(async () => {
    await tb.close();
    await llm.close();
  });
  if (withUserRules) for (const c of rules) tb.roots.checks.save(c, "user");
  // Halts reach the agent only while steering is on for the project (off sends nothing).
  tb.roots.steering.setMode("test-agent", "advisory");
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a billing agent.", user: "Charge order 4512" })])]);
  return { tb, t, root };
}

const notes = (tb: TestRoots, t: string, kind: string) => tb.roots.store.notesForTrace(t).filter((n) => n.kind === kind);

describe("streak rules", () => {
  it("fire when the streak is completed by spans that just arrived, even if a later one ended it", () => {
    const st = store();
    const t = hex(16);
    const root = hex(8);
    st.ingest([
      batch([
        toolSpan(t, root, "charge_card", "{}", undefined, "500"),
        toolSpan(t, root, "charge_card", "{}", undefined, "500"),
        toolSpan(t, root, "send_email", "{}", "sent"),
      ]),
    ]);
    const snap = loadTrace(st, t);
    const fresh = new Set(snap.spans.map((s) => s.id));
    // Without knowing which spans are new, only the newest span decides (unchanged).
    expect(evaluateRule(rule("stop-on-errors"), snap, false)?.firing).toBe(false);
    const hit = evaluateRule(rule("stop-on-errors"), snap, false, fresh)!;
    expect(hit.firing).toBe(true);
    expect(hit.params.count).toBe("2");
  });

  it("do not fire again for a streak that ended in an earlier batch", () => {
    const st = store();
    const t = hex(16);
    const root = hex(8);
    st.ingest([batch([toolSpan(t, root, "search", '{"q":"a"}', "[]"), toolSpan(t, root, "search", '{"q":"a"}', "[]"), toolSpan(t, root, "search", '{"q":"a"}', "[]")])]);
    st.ingest([batch([toolSpan(t, root, "lookup", "{}", "ok")])]);
    const snap = loadTrace(st, t);
    const newest = snap.spans.filter((s) => s.toolName === "lookup").map((s) => s.id);
    expect(evaluateRule(rule("stop-repeat"), snap, false, new Set(newest))?.firing).toBe(false);
  });
});

describe("user halt rules", () => {
  it("keep the halt when a later span ends the streak before the agent claims it", async () => {
    const { tb, t, root } = await setup();
    tb.roots.ingest([batch([toolSpan(t, root, "charge_card", "{}", undefined, "500")])]);
    tb.roots.ingest([batch([toolSpan(t, root, "charge_card", "{}", undefined, "500")])]);
    await until(() => notes(tb, t, "halt").find((n) => n.status === "pending"));
    // A parallel call from the same turn succeeds: the finding resolves, the halt stays.
    tb.roots.ingest([batch([toolSpan(t, root, "send_email", "{}", "sent")])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(tb.roots.store.findingsForTrace(t).find((f) => f.check_id === "stop-on-errors")?.status).toBe("resolved");
    expect(tb.roots.steering.claim(t, null)?.kind).toBe("halt");
  });

  it("halt when the failing calls and a later span arrive in one batch", async () => {
    const { tb, t, root } = await setup();
    tb.roots.ingest([
      batch([
        toolSpan(t, root, "charge_card", "{}", undefined, "500"),
        toolSpan(t, root, "charge_card", "{}", undefined, "500"),
        toolSpan(t, root, "send_email", "{}", "sent"),
      ]),
    ]);
    await until(() => notes(tb, t, "halt").length > 0);
    expect(tb.roots.steering.claim(t, null)?.kind).toBe("halt");
  });

  it("halt when a repeat and a different call arrive in one batch", async () => {
    const { tb, t, root } = await setup();
    const del = () => toolSpan(t, root, "delete_records", '{"table":"orders"}', "ok");
    tb.roots.ingest([batch([del(), del(), del(), toolSpan(t, root, "list_tables", "{}", "[]")])]);
    await until(() => notes(tb, t, "halt").length > 0);
    expect(tb.roots.steering.claim(t, null)?.text).toContain("delete_records");
  });

  it("are still withdrawn when the user dismisses the finding", async () => {
    const { tb, t, root } = await setup();
    tb.roots.ingest([batch([toolSpan(t, root, "charge_card", "{}", undefined, "500"), toolSpan(t, root, "charge_card", "{}", undefined, "500")])]);
    const halt = await until(() => notes(tb, t, "halt").find((n) => n.status === "pending"));
    tb.roots.steering.withdraw(halt.finding_id!);
    expect(tb.roots.steering.claim(t, null)).toBeUndefined();
  });
});

describe("advisory notes", () => {
  it("are still withdrawn when the agent moves on", async () => {
    const { tb, t, root } = await setup(false);
    tb.roots.steering.setMode("test-agent", "advisory");
    const fail = () => toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404");
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([fail()])]);
    // The loop group raises one note for the three identical failures.
    await until(() => tb.roots.store.notesForTrace(t, "pending").some((n) => n.kind !== "halt"));
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4513"}', "found")])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(tb.roots.store.notesForTrace(t, "pending")).toEqual([]);
  });
});
