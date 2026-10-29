import { afterEach, describe, expect, it } from "vitest";
import { checkFromInput } from "../src/server/api.js";
import { batch, hex, makeRoots, mockLlm, s, span } from "./helpers.js";

// #650: a root hand-back must select rules using the current stored workflow.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe("workflow-scoped steering after remote-parent root hand-back", () => {
  for (const scenario of ["caller-first", "callee-first", "same-workflow", "one-batch"] as const) {
    it(`uses the current root workflow: ${scenario}`, async () => {
      const llm = await mockLlm();
      const tb = await makeRoots({ llmUrl: llm.url });
      cleanup.push(async () => { await tb.close(); await llm.close(); });
      tb.roots.steering.setMode("shared-project", "advisory");
      const parsed = checkFromInput(`
id: caller-boom-scoped
kind: rule
title: The caller hit a problem
applies_to: { workflow: caller }
action: halt
rule:
  type: match
  field: input
  pattern: BOOM
  span: { type: workflow }
`);
      expect(parsed.error).toBeUndefined();
      if (!parsed.check) throw new Error("rule did not parse");
      tb.roots.checks.save(parsed.check, "user");
      tb.roots.checks.save({ ...parsed.check, id: "callee-boom-scoped", applies_to: { workflow: "callee" } }, "user");
      const traceId = hex(16), callerId = hex(8);
      const caller = { ...span({ traceId, spanId: callerId, name: "caller-agent", kind: "workflow", attrs: [s("neatlogs.workflow.input", "BOOM happened")] }), endTimeUnixNano: "0" };
      const callee = span({ traceId, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 });
      const resource = (spans: typeof callee[], workflow: string) => {
        const b = batch(spans, "shared-project");
        b.resource.attributes.find(a => a.key === "neatlogs.workflow_name")!.value = { stringValue: workflow };
        return b;
      };
      const callerBatch = resource([caller], "caller");
      const calleeBatch = resource([callee], scenario === "same-workflow" ? "caller" : "callee");
      if (scenario === "caller-first") {
        tb.roots.ingest([callerBatch]);
        tb.roots.ingest([calleeBatch]);
      } else if (scenario === "one-batch") {
        tb.roots.ingest([calleeBatch, callerBatch]);
      } else {
        tb.roots.ingest([calleeBatch]);
        // Same 600ms grace used by the existing engine hand-back steering test.
        await new Promise(r => setTimeout(r, 600));
        await tb.roots.engine!.waitIdle(traceId, 5000);
        tb.roots.ingest([callerBatch]);
      }
      await tb.roots.engine!.waitIdle(traceId, 5000);
      const row = tb.roots.store.getRun(traceId)!;
      expect(row).toMatchObject({ project: "shared-project", workflow: "caller", root_span_id: callerId, status: "running" });
      const finding = tb.roots.store.findingsForTrace(traceId).find(f => f.check_id === parsed.check!.id);
      const wrongScope = tb.roots.store.findingsForTrace(traceId).find(f => f.check_id === "callee-boom-scoped");
      const note = tb.roots.steering.claim(traceId);
      expect(wrongScope).toBeUndefined();
      expect(finding?.status).toBe("raised");
      expect(note?.kind).toBe("halt");
    });
  }
});
