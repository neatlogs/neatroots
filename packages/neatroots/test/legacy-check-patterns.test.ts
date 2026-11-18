import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, toolSpan, until, type TestRoots } from "./helpers.js";

// 0.2.8 accepted match patterns that nest repeats. A check saved like that must keep working after
// the upgrade (a halt rule silently stopping would be worse than the slow pattern it guards against).

let tb: TestRoots | undefined;
afterEach(async () => {
  await tb?.close();
  tb = undefined;
});

describe("a check saved by 0.2.8 with a nested-repeat pattern", () => {
  it("still loads and still halts the agent", async () => {
    tb = await makeRoots();
    const dir = path.join(tb.roots.home, "checks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "halt-dangerous-delete.yaml"),
      `id: halt-dangerous-delete
kind: rule
action: halt
title: Deletes a whole tree
rule:
  type: match
  span: { type: tool }
  field: input
  pattern: 'rm\\s+-rf\\s+(/[\\w.-]+)+'
guidance: Stop. Never delete a whole tree.
`,
    );
    tb.roots.checks.reload();
    expect(tb.roots.checks.errors).toEqual([]);
    expect(tb.roots.checks.get("halt-dangerous-delete")?.source).toBe("user");

    tb.roots.steering.setMode("test-agent", "advisory");
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "clean up the build" })])]);
    tb.roots.ingest([batch([toolSpan(t, root, "shell", '{"cmd":"rm -rf /var/app/build"}', "ok")])]);
    await until(() => tb!.roots.store.notesForTrace(t).find((n) => n.kind === "halt"));
    expect(tb.roots.steering.claim(t, null)?.kind).toBe("halt");
  });

  it("saving a halt rule while steering is off for its project says it won't stop the agent", async () => {
    tb = await makeRoots({ serve: true, noEngine: true });
    const save = async () =>
      (await (
        await fetch(`${tb!.url}/api/checks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ check: { id: "stop-refunds", kind: "rule", action: "halt", applies_to: { project: "billing" }, rule: { type: "count", span: { tool: "issue_refund" }, at_least: 1 } } }),
        })
      ).json()) as { warnings: string[] };
    expect((await save()).warnings.join(" ")).toMatch(/won't stop the agent until steering is on/);
    tb.roots.steering.setMode("billing", "advisory");
    expect((await save()).warnings).toEqual([]);
  });
});
