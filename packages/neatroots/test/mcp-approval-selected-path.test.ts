import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CheckRegistry } from "../src/checks/registry.js";
import type { Check } from "../src/checks/types.js";
import { makeRoots } from "./helpers.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });

it("a late same-definition sibling never receives the reviewed destination's grant", async () => {
  const t = await makeRoots({ noEngine: true }); cleanup.push(t.close);
  const check = { id: "late-sibling", kind: "rule", action: "flag", rule: { type: "count", at_least: 2 } } as Check;
  const proposal = t.roots.checks.proposeMcp(check, null);
  const destination = proposal.target_path, sibling = path.join(path.dirname(destination), "zz-sibling.yaml");
  const write = fs.writeFileSync; let appeared = 0;
  const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
    const result = write(file, data, options as never);
    if (String(file) === destination) { write(sibling, fs.readFileSync(destination)); appeared++; }
    return result;
  }) as typeof fs.writeFileSync);
  try { expect(() => t.roots.checks.approvePendingMcp(check.id, proposal.revision)).toThrow(/another file shadows the proposed destination/); }
  finally { spy.mockRestore(); }
  expect(appeared).toBe(1);
  expect(fs.readFileSync(sibling)).toEqual(fs.readFileSync(destination));
  expect(t.roots.store.getMeta(`approved_mcp:${check.id}`)).toBeUndefined();
  expect(t.roots.store.getMcpCheckProposal(check.id)?.revision).toBe(proposal.revision);
  const reopened = new CheckRegistry(t.roots.store, path.dirname(destination), () => []);
  expect(reopened.get(check.id)).toMatchObject({ source: "mcp", path: sibling });
  expect(reopened.rules().some((c) => c.check.id === check.id)).toBe(false);
});