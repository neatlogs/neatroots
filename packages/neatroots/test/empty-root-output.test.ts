import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFiles } from "../src/checks/offline.js";
import { parseChecks } from "../src/checks/registry.js";
import { evaluateRule } from "../src/checks/rules.js";
import type { RuleCheck } from "../src/checks/types.js";
import { buildEvidence, finalOutput, loadTrace } from "../src/engine/trace.js";
import { batch, hex, llmSpan, makeRoots, mockLlm, s, span, tmpHome, toolSpan, trackedStore, closeTrackedStores, until } from "./helpers.js";

const answer = "Your refund of $40 has been issued.";
const emptyRoots = ["", '""', " \t\n ", '" \t "', "null", "{}", "[]"];
const checks = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const rule = (id: string) => checks.find((c) => c.id === id)!;
const homes: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  closeTrackedStores();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function fixture(rootOutput: string, reply = answer) {
  const traceId = hex(16);
  const root = hex(8);
  return batch([
    toolSpan(traceId, root, "issue_refund", "{}", undefined, "HTTP 503 upstream timeout"),
    llmSpan(traceId, root, { user: "Refund my order", out: reply }),
    span({ traceId, spanId: root, name: "refund", kind: "workflow", attrs: [s("neatlogs.workflow.output", rootOutput)] }),
  ]);
}
function stored(rootOutput: string, reply = answer) {
  const home = tmpHome();
  homes.push(home);
  const store = trackedStore(path.join(home, "data"));
  const data = fixture(rootOutput, reply);
  store.ingest([data]);
  return { store, data, snap: loadTrace(store, data.spans[0].traceId) };
}

describe("empty root final output", () => {
  it.each(emptyRoots)("uses the last answer for root %j in rules and question evidence", (rootOutput) => {
    const { snap, store, data } = stored(rootOutput);
    expect(finalOutput(snap)).toBe(answer);
    expect(evaluateRule(rule("empty-final-answer"), snap, true)).toBeNull();
    expect(evaluateRule(rule("unrecovered-tool-failure"), snap, true)?.firing).toBe(true);
    expect(buildEvidence(snap, { final_output: true, goal: false, fields: [] }).text).toContain(`Final answer: ${answer}`);
    // Reading the answer must not rewrite the original OTLP input.
    expect(store.getOtlpSpan(snap.traceId, data.spans[2].spanId)?.span).toEqual(data.spans[2]);
  });

  it.each(['{"answer":42}', '[1,2]', "All done", "  All done  ", "false", "0", '{ "nested": {} }'])("preserves nonempty root %j exactly", (rootOutput) => {
    const { snap } = stored(rootOutput);
    const expected = rootOutput === '{ "nested": {} }' ? '{"nested":{}}' : rootOutput;
    expect(finalOutput(snap)).toBe(expected);
  });
  it.each(["", " \t ", "null"])("does not revive an earlier answer when the final LLM reply is %j", (reply) => {
    const { store, data } = stored("{}", reply);
    const earlier = llmSpan(data.spans[0].traceId, data.spans[2].spanId, { user: "earlier", out: "Earlier answer" });
    // Explicit times place this reply before the actual final LLM span.
    earlier.startTimeUnixNano = "1000000";
    earlier.endTimeUnixNano = "2000000";
    store.ingest([batch([earlier])]);
    const snap = loadTrace(store, data.spans[0].traceId);
    expect(finalOutput(snap)).toBeUndefined();
    expect(evaluateRule(rule("empty-final-answer"), snap, true)?.firing).toBe(true);
    expect(evaluateRule(rule("unrecovered-tool-failure"), snap, true)).toBeNull();
    expect(buildEvidence(snap, { final_output: true }).text).not.toContain("Final answer:");
  });

  it("preserves the existing quoted-empty LLM reply representation", () => {
    const { snap } = stored("{}", '""');
    expect(finalOutput(snap)).toBe('""');
    expect(evaluateRule(rule("empty-final-answer"), snap, true)?.firing).toBe(true);
    expect(evaluateRule(rule("unrecovered-tool-failure"), snap, true)).toBeNull();
  });
  it.each(emptyRoots)("checks offline files with root %j", (rootOutput) => {
    const home = tmpHome();
    homes.push(home);
    const data = fixture(rootOutput);
    const file = path.join(home, "trace.json");
    fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: data.resource, scopeSpans: [{ scope: data.scope, spans: data.spans }] }] }));
    const result = checkFiles([file], { only: ["empty-final-answer", "unrecovered-tool-failure"] });
    expect(result.errors).toEqual([]);
    expect(result.runs[0].findings.map((f) => f.check_id)).toEqual(["unrecovered-tool-failure"]);
  });

  it("uses the fallback in the live engine and its final_output evidence", async () => {
    const llm = await mockLlm({ plan: [{ id: "contradicts-tool-output" }] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => { await tb.close(); await llm.close(); });
    const data = fixture("{}");
    const traceId = data.spans[0].traceId;
    tb.roots.ingest([data]);
    await until(() => tb.roots.store.getSummary(traceId), 15000);
    await tb.roots.engine!.waitIdle(traceId, 15000);
    const ids = tb.roots.store.findingsForTrace(traceId).map((f) => f.check_id);
    expect(ids).toContain("unrecovered-tool-failure");
    expect(ids).not.toContain("empty-final-answer");
    expect(llm.requests.some((r) => JSON.stringify(r.messages).includes(`Final answer: ${answer}`))).toBe(true);
  });
});
