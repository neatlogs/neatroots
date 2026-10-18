import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { batch, hex, makeRoots, mockLlm, s, span, until } from "./helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(noEngine = false) {
  const llm = await mockLlm(); cleanup.push(llm.close);
  const t = await makeRoots({ llmUrl: llm.url, noEngine });
  cleanup.push(t.close);
  t.roots.config.ambient = { enabled: true, outputs: { log: { enabled: true } } };
  t.roots.ambient.configure(t.roots.config.ambient);
  const output = vi.spyOn(t.roots.ambient, "setState"); // Real service and receipt owner; local output only.
  const id = hex(16);
  const root = span({ traceId: id, name: "completed", kind: "workflow", attrs: [
    s("neatlogs.workflow.input", "Complete the task"), s("neatlogs.workflow.output", "Done"),
  ] });
  return { t, id, root, input: batch([root]), output };
}

it("waits for the real end pass, polls settled receipts, and preserves identical redelivery", async () => {
  const { t, id, input, output } = await setup();
  const event = vi.fn(); const off = t.roots.bus.on("trace", event); cleanup.push(off);
  t.roots.ingest([input]);
  expect(t.roots.checkCompletion.state(id)).toBe("pending");
  expect(t.roots.ambient.status().state).not.toBe("success");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(t.roots.checkCompletion.hasEnded(id)).toBe(false);
  expect(t.roots.ambient.status().state).not.toBe("success");
  await until(() => t.roots.checkCompletion.state(id) === "settled");
  await until(() => t.roots.ambient.status().state === "success");
  expect(event).toHaveBeenCalledTimes(1);
  expect(output.mock.calls.some(([signal]) => signal.state === "success")).toBe(true);
  t.roots.ingest([input]);
  expect(t.roots.checkCompletion.state(id)).toBe("settled");
  expect(t.roots.ambient.status().state).toBe("success");
});

it("keeps failed evaluation incomplete even with stale pending work and recovers by explicit recheck", async () => {
  const { t, id, input } = await setup();
  const failure = vi.spyOn(t.roots.engine! as unknown as { summarize(): Promise<void> }, "summarize")
    .mockRejectedValue(new Error("local end-pass evaluation failure"));
  t.roots.ingest([input]);
  await until(() => t.roots.checkCompletion.state(id) === "failed" && !t.roots.engine!.pending(id));
  expect(t.roots.checkCompletion.state(id)).toBe("failed");
  const pending = vi.spyOn(t.roots.engine!, "pending").mockReturnValue(2);
  await until(() => t.roots.ambient.status().state === "incomplete");
  pending.mockRestore(); failure.mockRestore();
  await t.roots.engine!.recheck(id);
  await until(() => t.roots.checkCompletion.state(id) === "settled");
  await until(() => t.roots.ambient.status().state === "success");
});

it("invalidates changed ended evidence until a fresh recheck settles", async () => {
  const { t, id, root, input } = await setup();
  t.roots.ingest([input]);
  await until(() => t.roots.ambient.status().state === "success");
  t.roots.ingest([batch([{ ...root, attributes: [...root.attributes, s("new.evidence", "changed")] }])]);
  expect(t.roots.checkCompletion.requiresRecheck(id)).toBe(true);
  expect(t.roots.ambient.status().state).toBe("incomplete");
  await t.roots.engine!.recheck(id);
  await until(() => t.roots.ambient.status().state === "success");
});

it("refuses restart unfinished receipts, no engine, invalid registry and missing runs", async () => {
  const { t, id, input } = await setup();
  t.roots.ingest([input]);
  await until(() => t.roots.ambient.status().state === "success");
  t.roots.engine!.progress.checking(id);
  await t.roots.close();
  const reopened = new Roots({ home: t.roots.home, config: t.roots.config });
  cleanup.push(() => reopened.close());
  expect(reopened.checkCompletion.state(id)).toBe("pending");
  expect(reopened.ambient.status().state).not.toBe("success");
  await reopened.close();
  expect(reopened.ambient.status().state).toBe("inactive");
  const readOnly = new Roots({ home: t.roots.home, config: t.roots.config, noEngine: true });
  cleanup.push(() => readOnly.close());
  expect(readOnly.ambient.status().state).toBe("incomplete");
});

it("keeps invalid registry incomplete and preserves running/error/finding precedence", async () => {
  const { t, id, input } = await setup();
  t.roots.ingest([input]);
  await until(() => t.roots.ambient.status().state === "success");
  t.roots.checks.errors.push({ path: "local-test", message: "invalid local registry" });
  await until(() => t.roots.ambient.status().state === "incomplete");
  t.roots.checks.errors.length = 0;
  t.roots.store.insertFinding({ trace_id: id, check_id: "test", check_kind: "rule", title: "needs attention",
    probability: 1, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  await until(() => t.roots.ambient.status().state === "attention");
  t.roots.store.db.prepare("UPDATE runs SET status='error' WHERE trace_id=?").run(id);
  await until(() => t.roots.ambient.status().state === "error");
  const running = span({ traceId: hex(16), parent: hex(8), name: "running", kind: "tool" });
  t.roots.ingest([batch([running])]);
  expect(t.roots.ambient.status().state).toBe("live");
  t.roots.store.deleteRun(running.traceId);
  t.roots.store.deleteRun(id);
  await until(() => t.roots.ambient.status().state === "idle");
});
