import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CheckRegistry } from "../src/checks/registry.js";
import type { Check } from "../src/checks/types.js";
import { Store } from "../src/store/db.js";
import { batch, hex, makeRoots, markerSpan, span, toolSpan } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

it("an interrupted file save retains MCP provenance and stays inactive after reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-crash-"));
  const dataDir = path.join(dir, "data");
  const checksDir = path.join(dir, "checks");
  let store = new Store(dataDir);
  try {
    let registry = new CheckRegistry(store, checksDir, () => []);
    const check = { id: "interrupted-mcp", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
    const proposal = registry.proposeMcp(check, null);
    const upsert = store.upsertCheckRow.bind(store);
    const fail = vi.spyOn(store, "upsertCheckRow").mockImplementation((row) => {
      if (row.id === check.id) throw new Error("database write failed");
      return upsert(row);
    });
    expect(() => registry.approvePendingMcp(check.id, proposal.revision)).toThrow("database write failed");
    expect(fs.existsSync(path.join(checksDir, `${check.id}.yaml`))).toBe(true);
    fail.mockRestore();
    store.close();
    store = new Store(dataDir);
    registry = new CheckRegistry(store, checksDir, () => []);
    expect(registry.get(check.id)?.source).toBe("mcp");
    expect(registry.isApprovedMcp(check.id)).toBe(false);
    expect(registry.enabled().some((c) => c.check.id === check.id)).toBe(false);
    expect(registry.pendingMcpCheck(check.id)?.revision).toBe(proposal.revision);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("a valid partial file from an interrupted write cannot reload as human-authored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-partial-"));
  const dataDir = path.join(dir, "data");
  const checksDir = path.join(dir, "checks");
  let store = new Store(dataDir);
  try {
    let registry = new CheckRegistry(store, checksDir, () => []);
    const check = { id: "partial-mcp", kind: "rule", action: "flag", guidance: "extra guidance", rule: { type: "count", at_least: 1 } } as Check;
    const proposal = registry.proposeMcp(check, null);
    const original = fs.writeFileSync;
    const fail = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      const prefix = String(data).split("\naction:")[0] + "\n";
      expect(prefix.length).toBeLessThan(String(data).length);
      original(file, prefix, options);
      throw new Error("interrupted write");
    });
    expect(() => registry.approvePendingMcp(check.id, proposal.revision)).toThrow("interrupted write");
    fail.mockRestore();
    store.close();
    store = new Store(dataDir);
    registry = new CheckRegistry(store, checksDir, () => []);
    expect(registry.get(check.id)?.source).toBe("mcp");
    expect(registry.isApprovedMcp(check.id)).toBe(false);
    expect(registry.enabled().some((c) => c.check.id === check.id)).toBe(false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const connect = async (url: string) => {
  const client = new Client({ name: "approval-regression", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return client;
};
const resultJson = (result: { content: { text?: string }[] }) => JSON.parse(result.content[0].text ?? "null");
const ruleYaml = (id: string, action: "flag" | "halt", atLeast: number) =>
  `id: ${id}\nkind: rule\naction: ${action}\nrule: { type: count, span: { type: tool, name: lookup_order }, at_least: ${atLeast} }\n`;

it.each([
  ["another check", ruleYaml("another-check", "flag", 7)],
  ["invalid work in progress", "id: broken\nkind: [\n"],
])("does not overwrite a destination created after a proposal (%s)", async (_description, content) => {
  const t = await makeRoots({ noEngine: true });
  cleanup.push(t.close);
  const check = { id: "destination-race", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
  const proposal = t.roots.checks.proposeMcp(check, null);
  const dir = path.join(t.roots.home, "checks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${check.id}.yaml`);
  fs.writeFileSync(file, content);

  expect(() => t.roots.checks.approvePendingMcp(check.id, proposal.revision)).toThrow(/approval target changed/);
  expect(fs.readFileSync(file, "utf8")).toBe(content);
  expect(t.roots.checks.get(check.id)).toBeUndefined();
  expect(t.roots.checks.pendingMcpCheck(check.id)?.revision).toBe(proposal.revision);
});

it("preserves unrelated YAML entries at an existing proposal destination", async () => {
  const t = await makeRoots({ noEngine: true });
  cleanup.push(t.close);
  const check = { id: "shared-destination", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
  const dir = path.join(t.roots.home, "checks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${check.id}.yaml`);
  const original = ruleYaml("unrelated-entry", "flag", 9);
  fs.writeFileSync(file, original);
  const proposal = t.roots.checks.proposeMcp(check, null);

  expect(() => t.roots.checks.approvePendingMcp(check.id, proposal.revision)).toThrow(/approval target conflict/);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(t.roots.checks.get(check.id)).toBeUndefined();
  expect(t.roots.checks.pendingMcpCheck(check.id)?.revision).toBe(proposal.revision);
});

it("approval and rejection require the exact proposal revision that was reviewed", async () => {
  const t = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(t.close);
  const first = t.roots.checks.proposeMcp({ id: "revision-check", kind: "rule", action: "flag", rule: { type: "count", at_least: 3 } } as Check, null);
  const second = t.roots.checks.proposeMcp({ ...first.check, rule: { type: "count", at_least: 5 } } as Check, null);
  expect(second.revision).not.toBe(first.revision);
  const act = (action: string, revision?: string) => fetch(`${t.url}/api/checks/revision-check/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision }),
  });
  expect((await act("approve")).status).toBe(400);
  expect((await act("approve", first.revision)).status).toBe(409);
  expect((await act("reject", first.revision)).status).toBe(409);
  expect(t.roots.checks.get(first.check.id)).toBeUndefined();
  expect(t.roots.checks.pendingMcpCheck(first.check.id)?.revision).toBe(second.revision);
  expect((await act("approve", second.revision)).status).toBe(200);
  expect(t.roots.checks.isApprovedMcp(first.check.id)).toBe(true);
  expect(t.roots.checks.get(first.check.id)?.check).toMatchObject({ rule: { at_least: 5 } });
});

it("rolls back the approval grant if completing the proposal fails", async () => {
  const t = await makeRoots({ noEngine: true });
  cleanup.push(t.close);
  const check = { id: "atomic-approval", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
  const proposal = t.roots.checks.proposeMcp(check, null);
  const fault = vi.spyOn(t.roots.store, "deleteMcpCheckProposal").mockImplementation(() => { throw new Error("completion failed"); });
  expect(() => t.roots.checks.approvePendingMcp(check.id, proposal.revision)).toThrow("completion failed");
  fault.mockRestore();
  expect(t.roots.checks.isApprovedMcp(check.id)).toBe(false);
  expect(t.roots.checks.enabled().some((c) => c.check.id === check.id)).toBe(false);
  expect(t.roots.checks.pendingMcpCheck(check.id)?.revision).toBe(proposal.revision);
});

it("does not overwrite an active definition edited after the agent submitted its proposal", async () => {
  const t = await makeRoots({ noEngine: true });
  cleanup.push(t.close);
  const active = t.roots.checks.save({ id: "concurrent-check", kind: "rule", action: "flag", rule: { type: "count", at_least: 3 } } as Check, "user");
  const proposal = t.roots.checks.proposeMcp({ ...active.check, rule: { type: "count", at_least: 5 } } as Check, null);
  fs.writeFileSync(active.path!, ruleYaml("concurrent-check", "flag", 7));
  expect(() => t.roots.checks.approvePendingMcp(active.check.id, proposal.revision)).toThrow("active check changed");
  expect(fs.readFileSync(active.path!, "utf8")).toContain("at_least: 7");
  expect(t.roots.checks.pendingMcpCheck(active.check.id)?.revision).toBe(proposal.revision);
});

it("refuses a shadowed destination without changing either project file", async () => {
  const t = await makeRoots({ noEngine: true });
  cleanup.push(t.close);
  const early = path.join(t.roots.home, "early-checks");
  const late = path.join(t.roots.home, "late-checks");
  fs.mkdirSync(early);
  fs.mkdirSync(late);
  t.roots.config.checkDirs.push(early, late);
  const first = ruleYaml("shadowed-check", "flag", 3);
  const second = ruleYaml("shadowed-check", "flag", 7);
  fs.writeFileSync(path.join(early, "shadowed-check.yaml"), first);
  fs.writeFileSync(path.join(late, "shadowed-check.yaml"), second);
  t.roots.checks.reload();
  const current = t.roots.checks.get("shadowed-check")!;
  expect(current.path).toBe(path.join(late, "shadowed-check.yaml"));
  expect(() => t.roots.checks.proposeMcp({ ...current.check, rule: { type: "count", at_least: 5 } } as Check, early)).toThrow("active check directory");
  expect(fs.readFileSync(path.join(early, "shadowed-check.yaml"), "utf8")).toBe(first);
  expect(fs.readFileSync(path.join(late, "shadowed-check.yaml"), "utf8")).toBe(second);
  expect(t.roots.checks.isApprovedMcp(current.check.id)).toBe(false);
});

it("neither legacy MCP rows nor changed approved definitions inherit approval", async () => {
  const t = await makeRoots({ noEngine: true });
  cleanup.push(t.close);
  const check = { id: "legacy-mcp", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
  t.roots.checks.save(check, "db", "mcp");
  expect(t.roots.checks.enabled().some((c) => c.check.id === check.id)).toBe(false);
  const proposal = t.roots.checks.proposeMcp(check, null);
  const approved = t.roots.checks.approvePendingMcp(check.id, proposal.revision)!;
  expect(t.roots.checks.isApprovedMcp(check.id)).toBe(true);
  fs.writeFileSync(approved.path!, ruleYaml(check.id, "halt", 2));
  t.roots.checks.reload();
  expect(t.roots.checks.isApprovedMcp(check.id)).toBe(false);
  expect(t.roots.checks.enabled().some((c) => c.check.id === check.id)).toBe(false);
});

it("MCP edits stay pending without changing the active check before approval", async () => {
  const t = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(t.close);
  const dir = path.join(t.roots.home, "checks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "protected.yaml");
  const original = `${ruleYaml("protected", "flag", 3)}---\n${ruleYaml("unrelated-entry", "flag", 11)}`;
  fs.writeFileSync(file, original);
  t.roots.checks.reload();

  const client = await connect(t.url);
  try {
    const draft = resultJson(await client.callTool({ name: "create_check", arguments: { check: ruleYaml("draft-only", "flag", 2), save: false } }));
    expect(draft).toMatchObject({ saved: false, id: "draft-only" });
    expect(Object.keys(draft).sort()).toEqual(["id", "saved", "warnings", "yaml"]);
    expect(t.roots.checks.pendingMcp()).toHaveLength(0);

    const proposal = resultJson(await client.callTool({ name: "create_check", arguments: { check: ruleYaml("protected", "flag", 1) } }));
    expect(proposal).toMatchObject({ saved: true, pending_approval: true, approved: false, active_version_unchanged: true, path: null });
    expect(t.roots.checks.get("protected")?.check).toMatchObject({ action: "flag", rule: { at_least: 3 } });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(t.roots.checks.pendingMcpCheck("protected")?.check).toMatchObject({ action: "flag", rule: { at_least: 1 } });

    const listed = await (await fetch(`${t.url}/api/checks`)).json() as { checks: { id: string; source: string; check: Check }[]; pending_mcp_checks: { id: string; has_active_version: boolean }[] };
    expect(listed.checks.find((c) => c.id === "protected")).toMatchObject({ source: "user", check: { action: "flag", rule: { at_least: 3 } } });
    expect(listed.pending_mcp_checks).toContainEqual(expect.objectContaining({ id: "protected", has_active_version: true }));

    t.roots.checks.reload();
    expect(t.roots.checks.pendingMcpCheck("protected")?.check).toMatchObject({ action: "flag", rule: { at_least: 1 } });
    expect(t.roots.checks.get("protected")?.check).toMatchObject({ action: "flag", rule: { at_least: 3 } });

    const approved = await fetch(`${t.url}/api/checks/protected/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: t.roots.checks.pendingMcpCheck("protected")!.revision }) });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, id: "protected", path: file, source: "mcp" });
    const updated = fs.readFileSync(file, "utf8");
    expect(updated).toContain("action: flag");
    expect(updated).toContain("id: unrelated-entry");
    expect(updated).toContain("at_least: 11");
    expect(t.roots.checks.get("protected")?.check).toMatchObject({ action: "flag", rule: { at_least: 1 } });
    expect(t.roots.checks.get("protected")?.source).toBe("mcp");
    t.roots.checks.reload();
    expect(t.roots.checks.get("protected")?.source).toBe("mcp");
    expect(t.roots.checks.pendingMcp()).toHaveLength(0);
  } finally {
    await client.close();
  }
});

it("new MCP checks stay inactive and approval provenance survives a database reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-persist-"));
  const dataDir = path.join(dir, "data");
  const checksDir = path.join(dir, "checks");
  let store = new Store(dataDir);
  try {
    let registry = new CheckRegistry(store, checksDir, () => []);
    const proposed = { id: "new-mcp-rule", kind: "rule", action: "flag", rule: { type: "count", span: { type: "tool", name: "lookup_order" }, at_least: 1 } } as Check;
    registry.proposeMcp(proposed, null);
    expect(registry.get(proposed.id)).toBeUndefined();
    store.close();

    store = new Store(dataDir);
    registry = new CheckRegistry(store, checksDir, () => []);
    expect(registry.pendingMcpCheck(proposed.id)?.check).toMatchObject({ action: "flag" });
    const approved = registry.approvePendingMcp(proposed.id, registry.pendingMcpCheck(proposed.id)!.revision);
    expect(approved).toMatchObject({ source: "mcp", check: { id: proposed.id, action: "flag" } });
    store.close();

    store = new Store(dataDir);
    registry = new CheckRegistry(store, checksDir, () => []);
    expect(registry.get(proposed.id)).toMatchObject({ source: "mcp", check: { action: "flag" } });
    expect(registry.pendingMcpCheck(proposed.id)).toBeUndefined();
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("rejecting an MCP edit discards only the proposal", async () => {
  const t = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(t.close);
  const dir = path.join(t.roots.home, "checks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "keep.yaml");
  const original = ruleYaml("keep", "flag", 3);
  fs.writeFileSync(file, original);
  t.roots.checks.reload();
  const client = await connect(t.url);
  try {
    await client.callTool({ name: "create_check", arguments: { check: ruleYaml("keep", "flag", 1) } });
    const rejected = await fetch(`${t.url}/api/checks/keep/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: t.roots.checks.pendingMcpCheck("keep")!.revision }) });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ ok: true, id: "keep" });
    expect(t.roots.checks.pendingMcpCheck("keep")).toBeUndefined();
    expect(t.roots.checks.get("keep")?.check).toMatchObject({ action: "flag", rule: { at_least: 3 } });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  } finally {
    await client.close();
  }
});

it("only an approved MCP flag rule can raise a finding", async () => {
  const t = await makeRoots({ noEngine: false });
  cleanup.push(t.close);
  const id = "approved-mcp-flag";
  const flagRule = { id, kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
  t.roots.checks.proposeMcp(flagRule, null);

  const runOneSpan = async (traceId: string) => {
    const root = span({ traceId, name: "agent", kind: "workflow" });
    root.endTimeUnixNano = "0";
    t.roots.ingest([batch([root])]);
    expect(await t.roots.engine!.waitIdle(traceId, 1000)).toBe(true);
  };
  const pendingTrace = hex(16);
  await runOneSpan(pendingTrace);
  expect(t.roots.store.listFindings({ traceId: pendingTrace }).some((f) => f.check_id === id)).toBe(false);
  expect(t.roots.store.notesForTrace(pendingTrace).some((n) => n.kind === "halt")).toBe(false);

  expect(t.roots.checks.approvePendingMcp(id, t.roots.checks.pendingMcpCheck(id)!.revision)?.source).toBe("mcp");
  const approvedTrace = hex(16);
  await runOneSpan(approvedTrace);
  expect(t.roots.store.listFindings({ traceId: approvedTrace }).some((f) => f.check_id === id)).toBe(true);
  expect(t.roots.store.notesForTrace(approvedTrace).some((n) => n.kind === "halt")).toBe(false);
});

it("preview_check by id previews the pending version", async () => {
  const t = await makeRoots({ serve: true, noEngine: false });
  cleanup.push(t.close);
  const dir = path.join(t.roots.home, "checks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "preview-version.yaml"), ruleYaml("preview-version", "flag", 3));
  t.roots.checks.reload();

  const traceId = hex(16);
  const root = span({ traceId, name: "agent", kind: "workflow" });
  const tool = toolSpan(traceId, root.spanId, "lookup_order", "{}", "{}");
  t.roots.ingest([batch([root, tool, markerSpan(traceId, root.spanId)])]);
  const client = await connect(t.url);
  try {
    await client.callTool({ name: "create_check", arguments: { check: ruleYaml("preview-version", "flag", 1) } });
    const preview = resultJson(await client.callTool({ name: "preview_check", arguments: { id: "preview-version" } }));
    expect(preview).toMatchObject({ id: "preview-version", checked: 1, hits: 1 });
  } finally {
    await client.close();
  }
});

it.each(["user", "project"])("persists the effective %s target discovered after a stale registry load", (source) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-effective-target-"));
  const userDir = path.join(dir, "checks");
  const projectDir = path.join(dir, "project");
  const destinationDir = source === "project" ? projectDir : userDir;
  let store = new Store(path.join(dir, "data"));
  try {
    let registry = new CheckRegistry(store, userDir, () => [projectDir]);
    const check = { id: "late-target", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
    expect(registry.get(check.id)).toBeUndefined();
    fs.mkdirSync(destinationDir, { recursive: true });
    const file = path.join(destinationDir, "shared.yaml");
    const original = ruleYaml(check.id, "flag", 3) + "---\n" + ruleYaml("untouched-target-entry", "flag", 9);
    fs.writeFileSync(file, original);
    const proposal = registry.proposeMcp(check, null);
    expect(proposal.target_dir).toBe(destinationDir);
    expect(proposal.has_active_version).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    store.close(); store = new Store(path.join(dir, "data"));
    registry = new CheckRegistry(store, userDir, () => [projectDir]);
    expect(registry.pendingMcpCheck(check.id)).toMatchObject({ target_dir: destinationDir, revision: proposal.revision });
    const approved = registry.approvePendingMcp(check.id, proposal.revision);
    expect(approved?.path).toBe(file);
    expect(registry.get("untouched-target-entry")?.check).toMatchObject({ rule: { at_least: 9 } });
    expect(registry.get(check.id)?.check).toMatchObject({ rule: { at_least: 1 } });
    if (source === "project") expect(fs.existsSync(path.join(userDir, `${check.id}.yaml`))).toBe(false);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it.each(["user", "project"])("MCP and Checks API show the refreshed %s proposal target", async (source) => {
  const t = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(t.close);
  const userDir = path.join(t.roots.home, "checks");
  const projectDir = path.join(t.roots.home, "project-checks");
  t.roots.config.checkDirs.push(projectDir);
  t.roots.checks.reload();
  const client = await connect(t.url);
  try {
    const target = source === "project" ? projectDir : userDir;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "late-api.yaml"), ruleYaml("late-api", "flag", 3));
    expect(t.roots.checks.get("late-api")).toBeUndefined();
    const result = resultJson(await client.callTool({ name: "create_check", arguments: { check: ruleYaml("late-api", "flag", 1) } }));
    expect(result).toMatchObject({ target_dir: target, active_version_unchanged: true, pending_approval: true });
    const listed = await (await fetch(`${t.url}/api/checks`)).json() as { pending_mcp_checks: { id: string; target_dir: string }[] };
    expect(listed.pending_mcp_checks.find((p) => p.id === "late-api")?.target_dir).toBe(target);
  } finally { await client.close(); }
});
