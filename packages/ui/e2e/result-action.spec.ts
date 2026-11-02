import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { api, open, watchErrors } from "./util";

test("shows a recorded temporal contract without implying dependency", async ({ page }) => {
  const checkId = `recorded-contract-${randomBytes(4).toString("hex")}`;
  await api("/api/checks", { method: "POST", body: JSON.stringify({ id: checkId, title: "Recorded result/action contract matched", description: "Recorded order only; this does not prove dependency.", kind: "rule", rule: {
    type: "result_action", result: { tool: "permission" }, path: ["allowed"], equals: false,
    forbids: { tool: "write" }, within_ms: 5000, scope: "same_parent", clock: "same",
  } }) });
  try {
    const traceId = randomBytes(16).toString("hex");
    const parent = randomBytes(8).toString("hex");
    const base = BigInt(Date.now()) * 1_000_000n;
    const tool = (name: string, start: bigint, output: unknown) => ({ traceId, spanId: randomBytes(8).toString("hex"), parentSpanId: parent,
      name, startTimeUnixNano: String(base + start), endTimeUnixNano: String(base + start + 1_000_000n), status: { code: 1 },
      attributes: [{ key: "neatlogs.span.kind", value: { stringValue: "tool" } }, { key: "neatlogs.tool.name", value: { stringValue: name } },
        { key: "neatlogs.tool.output", value: { stringValue: JSON.stringify(output) } }],
    });
    await api("/v1/traces", { method: "POST", body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: {}, spans: [
      tool("permission", 1_000_000n, { allowed: false, private_note: "do not include in evidence" }), tool("write", 3_000_000n, { ok: true }),
      { traceId, spanId: parent, name: "recorded contract", startTimeUnixNano: String(base), endTimeUnixNano: String(base + 5_000_000n), status: { code: 1 }, attributes: [
        { key: "neatlogs.span.kind", value: { stringValue: "workflow" } }, { key: "neatlogs.workflow.output", value: { stringValue: "done" } },
      ] },
    ] }] }] }) });
    const errors = watchErrors(page);
    await open(page, `runs/${traceId}`);
    const problems = page.getByTestId("problems");
    const row = problems.getByRole("button", { name: /Recorded result\/action contract matched/ }).first();
    await expect(row).toBeVisible();
    if (await row.getAttribute("aria-expanded") !== "true") await row.click();
    await expect(problems.getByText("result_tool", { exact: true })).toBeVisible();
    await expect(problems.getByText("action_tool", { exact: true })).toBeVisible();
    await expect(problems).not.toContainText("do not include in evidence");
    expect(errors).toEqual([]);
  } finally {
    await api(`/api/checks/${checkId}`, { method: "DELETE" });
    await expect.poll(async () => (await api<{ checks: { id: string }[] }>("/api/checks")).checks.some((c) => c.id === checkId)).toBe(false);
  }
});
