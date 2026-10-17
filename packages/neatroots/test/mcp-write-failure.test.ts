import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CheckRegistry } from "../src/checks/registry.js";
import type { Check } from "../src/checks/types.js";
import { Store } from "../src/store/db.js";

for (const origin of ["human", "project", "approved", "pending"] as const) {
  for (const operation of ["approval", "human"] as const) {
    for (const partial of [false, true, "unreadable", "exists"] as const) {
      it(`${operation} failed write preserves ${origin} provenance when ${String(partial)}, across reopen`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-write-"));
        const checks = path.join(dir, "checks");
        let store = new Store(path.join(dir, "data"));
        try {
          const projectDirs = origin === "project" ? [path.join(dir, "project")] : [];
          let registry = new CheckRegistry(store, checks, () => projectDirs);
          const check = { id: "write-check", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
          if (origin === "human" || origin === "project") registry.save(check, origin === "project" ? { dir: projectDirs[0] } : "user");
          else {
            const p = registry.proposeMcp(check, null);
            registry.approvePendingMcp(check.id, p.revision);
            if (origin === "pending") {
              store.db.prepare("DELETE FROM meta WHERE key = ?").run(`approved_mcp:${check.id}`);
              registry.reload();
            }
          }
          const beforeOrigin = store.getMeta(`mcp_origin:${check.id}`);
          const beforeGrant = store.getMeta(`approved_mcp:${check.id}`);
          const next = { ...check, title: "changed" };
          const proposal = operation === "approval" ? registry.proposeMcp(next, null) : undefined;
          const original = fs.writeFileSync;
          let unreadable: { mockRestore(): void } | undefined;
          const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
            if (partial) original(file, `id: ${check.id}\nkind: rule\nrule: { type: count, at_least: 3 }\n`, options);
            if (partial === "unreadable") unreadable = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); });
            throw Object.assign(new Error("failed write"), { code: partial === "exists" ? "EEXIST" : "ENOSPC" });
          });
          try {
            expect(() => operation === "approval" ? registry.approvePendingMcp(check.id, proposal!.revision) : registry.save(next, "user")).toThrow("failed write");
          } finally { spy.mockRestore(); unreadable?.mockRestore(); }
          store.close();
          store = new Store(path.join(dir, "data"));
          registry = new CheckRegistry(store, checks, () => projectDirs);
          if (!partial) {
            expect(store.getMeta(`mcp_origin:${check.id}`)).toBe(beforeOrigin);
            expect(store.getMeta(`approved_mcp:${check.id}`)).toBe(beforeGrant);
            expect(registry.get(check.id)?.source).toBe(origin === "human" ? "user" : origin === "project" ? "project" : "mcp");
          }
          expect(registry.pendingMcpCheck(check.id)?.revision).toBe(proposal?.revision);
          if (operation === "approval") expect(store.getMeta(`approved_mcp:${check.id}`)).toBe(beforeGrant);
          const enabled = registry.enabled().some((c) => c.check.id === check.id);
          expect(enabled).toBe(partial ? operation === "human" && (origin === "human" || origin === "project") : origin !== "pending");
          if (operation === "human") {
            registry.save(next, "user");
            registry.reload();
            expect(store.getMeta(`mcp_origin:${check.id}`)).toBeUndefined();
            expect(store.getMeta(`approved_mcp:${check.id}`)).toBeUndefined();
            expect(registry.enabled().some((c) => c.check.id === check.id)).toBe(true);
          }
        } finally { vi.restoreAllMocks(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
      });
    }
  }
}

it.each([false, true])("exclusive-create race preserves the other writer and prior metadata (%s)", (prior) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-exists-"));
  const checks = path.join(dir, "checks");
  let store = new Store(path.join(dir, "data"));
  try {
    const projectDirs: string[] = [];
    let registry = new CheckRegistry(store, checks, () => projectDirs);
    const check = { id: "race-check", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
    const previousOrigin = prior ? JSON.stringify(["old", path.join(dir, "old.yaml")]) : undefined;
    if (previousOrigin) {
      store.setMeta(`mcp_origin:${check.id}`, previousOrigin);
      store.setMeta(`approved_mcp:${check.id}`, "old-grant");
    }
    const proposal = registry.proposeMcp(check, null);
    const original = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, _data, _options) => {
      original(file, `id: ${check.id}\nkind: rule\nrule: { type: count, at_least: 2 }\n`);
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });
    try { expect(() => registry.approvePendingMcp(check.id, proposal.revision)).toThrow("destination was created"); }
    finally { spy.mockRestore(); }
    store.close(); store = new Store(path.join(dir, "data"));
    registry = new CheckRegistry(store, checks, () => projectDirs);
    expect(fs.readFileSync(path.join(checks, `${check.id}.yaml`), "utf8")).toBe(`id: ${check.id}\nkind: rule\nrule: { type: count, at_least: 2 }\n`);
    expect(registry.pendingMcpCheck(check.id)?.revision).toBe(proposal.revision);
    expect(registry.get(check.id)?.source).toBe("user");
    expect(registry.enabled().some((c) => c.check.id === check.id)).toBe(true);
    expect(store.getMeta(`mcp_origin:${check.id}`)).toBe(previousOrigin);
    expect(store.getMeta(`approved_mcp:${check.id}`)).toBe(prior ? "old-grant" : undefined);
  } finally { vi.restoreAllMocks(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
it("a failed exclusive creation that leaves no file restores absent origin after reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-missing-"));
  const checks = path.join(dir, "checks");
  let store = new Store(path.join(dir, "data"));
  try {
    let registry = new CheckRegistry(store, checks, () => []);
    const check = { id: "missing-check", kind: "rule", rule: { type: "count", at_least: 1 } } as Check;
    const proposal = registry.proposeMcp(check, null);
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); });
    try { expect(() => registry.approvePendingMcp(check.id, proposal.revision)).toThrow("no space"); }
    finally { spy.mockRestore(); }
    store.close(); store = new Store(path.join(dir, "data"));
    registry = new CheckRegistry(store, checks, () => []);
    expect(fs.existsSync(path.join(checks, `${check.id}.yaml`))).toBe(false);
    expect(store.getMeta(`mcp_origin:${check.id}`)).toBeUndefined();
    expect(registry.get(check.id)).toBeUndefined();
    expect(registry.pendingMcpCheck(check.id)?.revision).toBe(proposal.revision);
  } finally { vi.restoreAllMocks(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
