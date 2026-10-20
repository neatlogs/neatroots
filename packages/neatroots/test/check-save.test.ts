import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CheckRegistry } from "../src/checks/registry.js";
import type { Check } from "../src/checks/types.js";
import { Store } from "../src/store/db.js";
import { makeRoots } from "./helpers.js";

let dir: string;
let store: Store;
let user: string;
let project: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-save-"));
  user = path.join(dir, "user-checks");
  project = path.join(dir, "project-checks");
  fs.mkdirSync(user);
  fs.mkdirSync(project);
  store = new Store(path.join(dir, "data"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const registry = () => new CheckRegistry(store, user, () => [project]);
const read = (p: string) => fs.readFileSync(p, "utf8");

const bigRun = (atLeast: number) =>
  ({ id: "big-run", kind: "rule", rule: { type: "count", span: { type: "tool", name: "lookup_order" }, at_least: atLeast } }) as Check;
const atLeast = (r: CheckRegistry) => (r.get("big-run")?.check as { rule: { at_least: number } }).rule.at_least;

// A check that no longer validates (flag_at_level is outside its two levels) stays in the file
// until someone fixes it; editing a neighbour must not drop it.
const team = `# Team checks for the refund agent

- id: big-run
  kind: rule
  rule: { type: count, span: { type: tool, name: lookup_order }, at_least: 5 }
# WIP: fix the scale before turning this on
- id: refund-tone
  kind: score
  ask: How rude was the reply?
  levels: [calm, rude]
  flag_at_level: 7
---
id: no-refund-loop
kind: rule
rule: { type: repeat, span: { type: tool, name: issue_refund }, same: [tool, input], at_least: 2 }
`;

it("editing a project check from the Checks page or MCP (no dir) updates it in its project file", () => {
  const file = path.join(project, "refunds.yaml");
  fs.writeFileSync(file, team);
  const r = registry();
  expect(atLeast(r)).toBe(5);

  const saved = r.save(bigRun(50), "user");

  expect(saved.path).toBe(file);
  expect(saved.source).toBe("project");
  expect(atLeast(r)).toBe(50);
  expect(fs.readdirSync(user)).toEqual([]);
  expect(read(file)).toBe(
    team.replace(
      "  rule: { type: count, span: { type: tool, name: lookup_order }, at_least: 5 }\n",
      "  rule:\n    type: count\n    span:\n      type: tool\n      name: lookup_order\n    at_least: 50\n",
    ),
  );
  expect(registry().get("big-run")?.path).toBe(file);
});

it("a check written inline keeps its style and its neighbours keep theirs", () => {
  const file = path.join(project, "checks.yaml");
  const text = `checks:
  - { id: big-run, kind: rule, rule: { type: count, span: { type: tool, name: lookup_order }, at_least: 5 } }   # raise later
  - id: no-refund-loop   # keep
    kind: rule
    rule: { type: repeat, span: { type: tool, name: issue_refund }, same: [tool, input], at_least: 2 }
`;
  fs.writeFileSync(file, text);
  const r = registry();

  r.save(bigRun(50), "user");

  expect(atLeast(r)).toBe(50);
  expect(read(file)).toBe(text.replace("at_least: 5 }", "at_least: 50 }"));
});

it("a file with Windows line endings keeps them", () => {
  const file = path.join(project, "refunds.yaml");
  fs.writeFileSync(file, team.replace(/\n/g, "\r\n"));
  const r = registry();

  r.save(bigRun(50), "user");

  expect(atLeast(r)).toBe(50);
  expect(read(file).replace(/\r\n/g, "")).not.toContain("\n");
});

it("editing a user check that shares a file with others updates that file", () => {
  // team.yaml sorts after big-run.yaml, so a separate big-run.yaml would be overridden on load.
  const file = path.join(user, "team.yaml");
  fs.writeFileSync(file, team);
  const r = registry();

  const saved = r.save(bigRun(50), "user", "mcp");

  expect(saved.path).toBe(file);
  expect(atLeast(r)).toBe(50);
  expect(fs.readdirSync(user)).toEqual(["team.yaml"]);
  expect(r.get("no-refund-loop")?.path).toBe(file);
});

it("saving with the check's own project dir edits its file there too", () => {
  const file = path.join(project, "refunds.yaml");
  fs.writeFileSync(file, team);
  const r = registry();

  r.save(bigRun(50), { dir: project });

  expect(atLeast(r)).toBe(50);
  expect(fs.readdirSync(project)).toEqual(["refunds.yaml"]);
});

it("new checks and checks moved to another directory still get their own file", () => {
  fs.writeFileSync(path.join(user, "team.yaml"), team);
  const r = registry();

  r.save({ ...bigRun(9), id: "fresh-check" } as Check, "user");
  expect(r.get("fresh-check")?.path).toBe(path.join(user, "fresh-check.yaml"));

  r.save(bigRun(50), { dir: project });
  expect(r.get("big-run")?.path).toBe(path.join(project, "big-run.yaml"));
  expect(atLeast(r)).toBe(50);
  expect(read(path.join(user, "team.yaml"))).toBe(team);
});

it("overriding a library check writes a user file and leaves the library alone", () => {
  const r = registry();
  const lib = r.all().find((c) => c.source === "library" && c.check.kind === "rule")!;
  const before = read(lib.path!);

  const saved = r.save({ ...lib.check, title: "My version" } as Check, "user");

  expect(saved.path).toBe(path.join(user, `${lib.check.id}.yaml`));
  expect(saved.source).toBe("user");
  expect(read(lib.path!)).toBe(before);
});

it("POST /api/checks (the Checks page editor) updates a project check in its file", async () => {
  const file = path.join(project, "refunds.yaml");
  fs.writeFileSync(file, team);
  const t = await makeRoots({ serve: true, noEngine: true, config: (c) => (c.checkDirs = [project]) });
  try {
    const yaml = "id: big-run\nkind: rule\nrule: { type: count, span: { type: tool, name: lookup_order }, at_least: 50 }\n";
    const res = await fetch(`${t.url}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe(file);
    expect(atLeast(t.roots.checks)).toBe(50);
    expect(read(file)).toContain("at_least: 50");
  } finally {
    await t.close();
  }
});
