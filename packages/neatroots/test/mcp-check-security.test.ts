import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Check } from "../src/checks/types.js";
import { makeRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const rule = (id: string, action: "flag" | "halt") => ({ id, kind: "rule", action, rule: { type: "count", at_least: 1 } }) as Check;

it("MCP proposals cannot create halt rules or edit a user's halt rule", async () => {
  const t = await makeRoots({ noEngine: true });
  cleanup.push(t.close);
  expect(() => t.roots.checks.proposeMcp(rule("new-halt", "halt"), null)).toThrow(/halt rules must be created or enabled by you/);
  expect(t.roots.checks.pendingMcpCheck("new-halt")).toBeUndefined();
  const saved = t.roots.checks.save(rule("user-halt", "halt"), "user");
  const bytes = fs.readFileSync(saved.path!);
  for (const action of ["flag", "halt"] as const) {
    expect(() => t.roots.checks.proposeMcp(rule("user-halt", action), null)).toThrow(/halt/);
  }
  expect(fs.readFileSync(saved.path!)).toEqual(bytes);
  expect(t.roots.checks.pendingMcpCheck("user-halt")).toBeUndefined();
});

it("a persisted halt proposal cannot acquire approval or write a check file", async () => {
  const t = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(t.close);
  const flag = rule("persisted-halt", "flag");
  const pending = t.roots.checks.proposeMcp(flag, null);
  const row = t.roots.store.getMcpCheckProposal(flag.id)!;
  // Simulate a pending body written by the pre-main version of the registry.
  const body = row.body.replace("action: flag", "action: halt");
  expect(body).not.toBe(row.body);
  t.roots.store.upsertMcpCheckProposal(row.id, body, row.target_dir, row.revision, row.active_fingerprint);
  t.roots.checks.reload();
  expect(t.roots.checks.pendingMcpCheck(flag.id)?.check).toMatchObject({ action: "halt" });
  expect(() => t.roots.checks.approvePendingMcp(flag.id, pending.revision)).toThrow(/halt rules must be created or enabled by you/);
  const refused = await fetch(`${t.url}/api/checks/${flag.id}/approve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: pending.revision }),
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/halt rules must be created or enabled by you/) });
  expect(fs.existsSync(path.join(t.roots.home, "checks", `${flag.id}.yaml`))).toBe(false);
  expect(t.roots.store.getMeta(`mcp_origin:${flag.id}`)).toBeUndefined();
  expect(t.roots.checks.isApprovedMcp(flag.id)).toBe(false);
  expect(t.roots.checks.pendingMcpCheck(flag.id)?.revision).toBe(pending.revision);
});
