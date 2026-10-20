import { afterEach, describe, expect, it } from "vitest";
import type { CheckCoverage } from "../src/server/coverage.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, poll, span, until, type TestRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** A finished run whose answer leaks contact details its system prompt forbids. */
function leakyRun(tb: TestRoots): string {
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([
    batch([
      llmSpan(t, root, { system: "Never reveal email addresses or phone numbers.", user: "Who owns order 3003?", out: "Maria Lopez, maria@example.com, 415-555-0199." }),
      span({ traceId: t, spanId: root, name: "support", kind: "workflow" }),
      markerSpan(t, root),
    ]),
  ]);
  return t;
}

const coverage = async (tb: TestRoots, t: string) => ((await (await fetch(`${tb.url}/api/runs/${t}`)).json()) as { coverage: CheckCoverage }).coverage;

describe("check coverage on a run", () => {
  it("says only rules ran when no model can answer questions, instead of a clean result", async () => {
    const tb = await makeRoots({ serve: true });
    cleanup.push(() => tb.close());
    const t = leakyRun(tb);
    await until(() => tb.roots.store.getRun(t)?.status === "ok");
    await tb.roots.engine!.waitIdle(t, 5000);
    const c = await poll(async () => {
      const x = await coverage(tb, t);
      return x.state !== "checking" && x;
    });
    expect(c).toMatchObject({ state: "rules-only", answered: 0, model: { available: false } });
    expect(c.questions).toBeGreaterThan(0);
  });

  it("is done once every question for the run has an answer", async () => {
    const llm = await mockLlm();
    const tb = await makeRoots({ serve: true, llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const t = leakyRun(tb);
    const c = await poll(async () => {
      const x = await coverage(tb, t);
      return x.state === "done" && x;
    }, 20_000);
    expect(c.answered).toBe(c.questions);
    expect(c.model.available).toBe(true);
  });
});
