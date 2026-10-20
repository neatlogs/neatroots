import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CheckRegistry, parseChecks } from "../src/checks/registry.js";
import { Store } from "../src/store/db.js";
import { makeRoots } from "./helpers.js";

let dir: string;
let store: Store;
let checks: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-remove-"));
  checks = path.join(dir, "project-checks");
  fs.mkdirSync(checks);
  store = new Store(path.join(dir, "data"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const registry = () => new CheckRegistry(store, path.join(dir, "user-checks"), () => [checks]);
const write = (name: string, text: string) => fs.writeFileSync(path.join(checks, name), text);
const read = (name: string) => fs.readFileSync(path.join(checks, name), "utf8");

// A check that no longer validates (flag_at_level is outside its two levels) stays in the file
// until someone fixes it; deleting a neighbour must not delete it too. The neighbours are written
// the way people write them (compact flow maps, a long line), not the way the stringifier would.
const header = "# Team checks for the refund agent\n\n";
const lookups = "- id: too-many-lookups\n  kind: rule\n  rule: {type: count, span: {type: tool, name: lookup_order}, at_least: 5} # five is plenty\n";
const rest = `# WIP: fix the scale before turning this on
- id: refund-tone
  kind: score
  ask: How rude was the reply?
  levels: [calm, rude]
  flag_at_level: 7
- id: no-refund-loop
  kind: rule
  rule: {type: repeat, span: {type: tool, name: issue_refund}, same: [tool, input], at_least: 2}
  guidance: You have issued the same refund {count} times already; check the order status before you try it again.
`;
const team = header + lookups + rest;

it("deleting a check cuts out only its own text, keeping the rest of the file byte for byte", () => {
  write("refunds.yaml", team);
  const r = registry();
  expect(r.errors.map((e) => e.id)).toEqual(["refund-tone"]);
  expect(r.remove("too-many-lookups")).toBe(true);
  const text = read("refunds.yaml");
  expect(text).toBe(header + rest);
  const left = parseChecks(text);
  expect(left.checks.map((c) => c.id)).toEqual(["no-refund-loop"]);
  expect(left.errors.map((e) => e.id)).toEqual(["refund-tone"]);
  expect(r.get("too-many-lookups")).toBeUndefined();
  expect(r.get("no-refund-loop")?.source).toBe("project");
});

it("keeps a file whose last valid check is deleted while an invalid one is still in it", () => {
  write("refunds.yaml", team);
  const r = registry();
  r.remove("too-many-lookups");
  r.remove("no-refund-loop");
  expect(fs.existsSync(path.join(checks, "refunds.yaml"))).toBe(true);
  const left = parseChecks(read("refunds.yaml"));
  expect(left.checks).toEqual([]);
  expect(left.errors.map((e) => e.id)).toEqual(["refund-tone"]);
});

it("removes a file once its only check is deleted", () => {
  write("solo.yaml", "id: solo\nkind: rule\nrule: { type: count, span: { type: tool }, at_least: 3 }\n");
  write("list.yaml", "- id: listed\n  kind: rule\n  rule: { type: count, span: { type: tool }, at_least: 3 }\n");
  const r = registry();
  expect(r.remove("solo")).toBe(true);
  expect(r.remove("listed")).toBe(true);
  expect(fs.existsSync(path.join(checks, "solo.yaml"))).toBe(false);
  expect(fs.existsSync(path.join(checks, "list.yaml"))).toBe(false);
});

it("edits only the document holding the check and leaves the other documents as written", () => {
  const broken = "---\n# alias typo, reported as an error\nid: broken\nkind: rule\nrule: *missing\n";
  const single = "---\nid: single\nkind: rule\nrule: {type: count, span: {type: tool}, at_least: 4}\n";
  write(
    "mixed.yaml",
    `checks:\n  - id: first # keep me\n    kind: rule\n    rule: {type: count, span: {type: llm}, at_least: 9}\n  - id: second\n    kind: rule\n    rule: {type: count, span: {type: tool}, at_least: 2}\n${broken}${single}`,
  );
  const r = registry();
  r.remove("second");
  const first = "checks:\n  - id: first # keep me\n    kind: rule\n    rule: {type: count, span: {type: llm}, at_least: 9}\n";
  expect(read("mixed.yaml")).toBe(first + broken + single);
  r.remove("single");
  expect(read("mixed.yaml")).toBe(first + broken);
  expect(parseChecks(read("mixed.yaml")).checks.map((c) => c.id)).toEqual(["first"]);
});

it("takes a check out of a flow list with its comma and leaves the others as written", () => {
  const a = "{id: a, kind: rule, rule: {type: count, span: {type: tool}, at_least: 1}}";
  const b = "{id: b, kind: rule, rule: {type: count, span: {type: llm}, at_least: 2}}";
  const c = "{id: c, kind: rule, rule: {type: count, span: {type: tool}, at_least: 3}}";
  write("flow.yaml", `[ ${a}, ${b},\n  ${c} ]\n`);
  const r = registry();
  r.remove("b");
  expect(read("flow.yaml")).toBe(`[ ${a}, ${c} ]\n`);
  r.remove("c");
  expect(read("flow.yaml")).toBe(`[ ${a} ]\n`);
  expect(r.get("a")).toBeDefined();
});

// rule: &shared … rule: *shared
const anchored = `- id: owner
  kind: rule
  rule: &shared {type: count, span: {type: tool}, at_least: 3}
- id: borrower
  kind: rule
  rule: *shared
`;

it("refuses to delete a check whose YAML anchor another check uses, and changes nothing", () => {
  write("anchors.yaml", anchored);
  const r = registry();
  expect(r.get("borrower")).toBeDefined();
  expect(() => r.remove("owner")).toThrow(/&shared.*borrower|borrower.*&shared/);
  expect(read("anchors.yaml")).toBe(anchored);
  expect(r.get("owner")).toBeDefined();
  expect(r.get("borrower")).toBeDefined();
});

it("deletes the check that uses an anchor and keeps the one that defines it", () => {
  write("anchors.yaml", anchored);
  const r = registry();
  expect(r.remove("borrower")).toBe(true);
  expect(read("anchors.yaml")).toBe("- id: owner\n  kind: rule\n  rule: &shared {type: count, span: {type: tool}, at_least: 3}\n");
  expect(r.get("owner")).toBeDefined();
});

it("leaves a file alone when the check was already edited out of it by hand", () => {
  write("solo.yaml", "id: solo\nkind: rule\nrule: { type: count, span: { type: tool }, at_least: 3 }\n");
  const r = registry();
  write("solo.yaml", "# moved to another file\n");
  expect(r.remove("solo")).toBe(true);
  expect(read("solo.yaml")).toBe("# moved to another file\n");
});

it("DELETE /api/checks/:id keeps the other checks in a project file", async () => {
  write("refunds.yaml", team);
  const t = await makeRoots({ serve: true, noEngine: true, config: (c) => (c.checkDirs = [checks]) });
  try {
    const res = await fetch(`${t.url}/api/checks/too-many-lookups`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(read("refunds.yaml")).toBe(header + rest);
    expect(t.roots.checks.get("no-refund-loop")).toBeDefined();
  } finally {
    await t.close();
  }
});

it("DELETE /api/checks/:id explains why a check whose anchor is in use can't be deleted", async () => {
  write("anchors.yaml", anchored);
  const t = await makeRoots({ serve: true, noEngine: true, config: (c) => (c.checkDirs = [checks]) });
  try {
    const res = await fetch(`${t.url}/api/checks/owner`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/&shared/);
    expect(read("anchors.yaml")).toBe(anchored);
    expect(t.roots.checks.get("borrower")).toBeDefined();
  } finally {
    await t.close();
  }
});

it("removes every copy of the id in the file, so an earlier duplicate doesn't come back", () => {
  write("dupes.yaml", "- id: dup\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 1}\n- id: other\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 2}\n- id: dup\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 3}\n");
  const r = registry();
  r.remove("dup");
  expect(r.get("dup")).toBeUndefined();
  expect(read("dupes.yaml")).toBe("- id: other\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 2}\n");
});

const rule = (id: string, n: number, indent = "  ") => `${indent}- id: ${id}\n${indent}  kind: rule\n${indent}  rule: {type: count, span: {type: tool}, at_least: ${n}}\n`;

it("deletes a file whose only check sat in a checks: list, instead of leaving checks: with no value", () => {
  write("wrapped.yaml", `# team checks\nchecks:\n${rule("b", 2)}`);
  const r = registry();
  expect(r.remove("b")).toBe(true);
  expect(fs.existsSync(path.join(checks, "wrapped.yaml"))).toBe(false);
  expect(r.errors).toEqual([]);
});

it("keeps a valid checks: [] when the file has more than the list, and the last check in it goes", () => {
  write("wrapped.yaml", `version: 2\nchecks:\n${rule("a", 1)}${rule("b", 2)}`);
  const r = registry();
  r.remove("a");
  expect(read("wrapped.yaml")).toBe(`version: 2\nchecks:\n${rule("b", 2)}`);
  r.remove("b");
  expect(read("wrapped.yaml")).toBe("version: 2\nchecks: []\n");
  const left = parseChecks(read("wrapped.yaml"));
  expect(left).toEqual({ checks: [], errors: [] });
  expect(r.errors).toEqual([]);
});

it("takes a comment on the check's own - line with it, so the next check still loads", () => {
  const a = rule("a", 1, "");
  write("commented.yaml", `- # the b check\n  id: b\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 2}\n${a}`);
  const r = registry();
  expect(r.remove("b")).toBe(true);
  expect(read("commented.yaml")).toBe(a);
  expect(r.get("a")).toBeDefined();
  expect(r.errors).toEqual([]);
});

it("takes comment lines between the dash and the check's first key with it", () => {
  const a = rule("a", 1, "");
  write("commented.yaml", `-\n  # the b check\n\n  # still b\n  id: b\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 2}\n${a}`);
  const r = registry();
  expect(r.remove("b")).toBe(true);
  expect(read("commented.yaml")).toBe(a);
  expect(r.errors).toEqual([]);
});

it("writes checks: [] on the key's line, after an anchor or tag and before a comment, however the list was indented", () => {
  const r0 = (id: string) => `- id: ${id}\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 1}\n`;
  write("indentless.yaml", `owner: team\nchecks:\n${r0("a")}`);
  write("commented-key.yaml", `owner: team\nchecks: &list # the team's list\n${rule("b", 2)}`);
  write("tagged.yaml", `owner: team\nchecks: !!seq\n${rule("c", 3)}`);
  const r = registry();
  r.remove("a");
  r.remove("b");
  r.remove("c");
  expect(read("indentless.yaml")).toBe("owner: team\nchecks: []\n");
  expect(read("commented-key.yaml")).toBe("owner: team\nchecks: &list [] # the team's list\n");
  expect(read("tagged.yaml")).toBe("owner: team\nchecks: !!seq []\n");
  expect(r.errors).toEqual([]);
});

it("leaves the line endings of a CRLF file as they were", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  write("crlf.yaml", crlf(`# team\nchecks:\n- # the a check\n  id: a\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 1}\n${rule("b", 2, "")}`));
  write("crlf-last.yaml", crlf(`version: 2\nchecks:\n${rule("c", 3)}`));
  const r = registry();
  r.remove("a");
  r.remove("c");
  expect(read("crlf.yaml")).toBe(crlf(`# team\nchecks:\n${rule("b", 2, "")}`));
  expect(read("crlf-last.yaml")).toBe("version: 2\r\nchecks: []\r\n");
  expect(r.errors).toEqual([]);
});

it("refuses a delete that would change what the rest of the file loads, and leaves the file as it is", async () => {
  // An anchor on the dash line isn't part of the entry's cut: cutting the check would leave a
  // bare "- &spare" (a null entry) in front of the next check.
  const text = `- &spare\n  id: b\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 2}\n${rule("a", 1, "")}`;
  write("odd.yaml", text);
  const r = registry();
  expect(() => r.remove("b")).toThrow(/without changing other checks/);
  expect(read("odd.yaml")).toBe(text);
  expect(r.get("b")).toBeDefined();
  expect(r.get("a")).toBeDefined();
  const t = await makeRoots({ serve: true, noEngine: true, config: (c) => (c.checkDirs = [checks]) });
  try {
    const res = await fetch(`${t.url}/api/checks/b`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(read("odd.yaml")).toBe(text);
  } finally {
    await t.close();
  }
});

it("deletes duplicate neighbours from a flow list, where their commas overlap", () => {
  const b = "{id: b, kind: rule, rule: {type: count, span: {type: tool}, at_least: 1}}";
  const x1 = "{id: x, kind: rule, rule: {type: count, span: {type: llm}, at_least: 2}}";
  const x2 = "{id: x, kind: rule, rule: {type: count, span: {type: tool}, at_least: 3}}";
  write("flow-dupes.yaml", `[ ${b}, ${x1}, ${x2} ]\n`);
  const r = registry();
  expect(r.remove("x")).toBe(true);
  expect(read("flow-dupes.yaml")).toBe(`[ ${b} ]\n`);
  expect(r.get("x")).toBeUndefined();
  expect(r.get("b")).toBeDefined();
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("DELETE /api/checks/:id answers a file it can't write with a 500, not a 409", async () => {
  write("refunds.yaml", team);
  fs.chmodSync(path.join(checks, "refunds.yaml"), 0o444);
  const t = await makeRoots({ serve: true, noEngine: true, config: (c) => (c.checkDirs = [checks]) });
  try {
    const res = await fetch(`${t.url}/api/checks/too-many-lookups`, { method: "DELETE" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("internal error");
    expect(read("refunds.yaml")).toBe(team);
  } finally {
    fs.chmodSync(path.join(checks, "refunds.yaml"), 0o644);
    await t.close();
  }
});

it("keeps a comment on the entry before a deleted last flow entry", () => {
  const a = "{id: a, kind: rule, rule: {type: count, span: {type: tool}, at_least: 1}}";
  const x = "{id: x, kind: rule, rule: {type: count, span: {type: llm}, at_least: 2}}";
  write("flow-comment.yaml", `[${a}, # note, about a\n ${x}]\n`);
  const r = registry();
  expect(r.remove("x")).toBe(true);
  expect(read("flow-comment.yaml")).toBe(`[${a} # note, about a\n ]\n`);
  expect(r.get("a")).toBeDefined();
  expect(r.errors).toEqual([]);
});
