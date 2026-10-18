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
