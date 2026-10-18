import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CheckRegistry, parseChecks } from "../src/checks/registry.js";
import { checkFromInput } from "../src/server/api-checks.js";
import { Store } from "../src/store/db.js";

const bad = "id: broken\nkind: rule\nrule: *missing\n";
const good = "id: valid\nkind: rule\nrule: {type: match, field: name, pattern: '^bad$'}\n";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })));

it("returns an error for an unresolved alias", () => {
  const result = parseChecks(bad);
  expect(result.checks).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].message).toMatch(/Unresolved alias/);
});

it("keeps valid documents after a conversion error", () => {
  const result = parseChecks(`${bad}---\n${good}`);
  expect(result.checks.map(c => c.id)).toEqual(["valid"]);
  expect(result.errors).toHaveLength(1);
});

it("still resolves valid aliases", () => {
  const result = parseChecks("checks:\n- id: first\n  kind: rule\n  rule: &rule {type: match, field: name, pattern: '^bad$'}\n- id: second\n  kind: rule\n  rule: *rule\n");
  expect(result.errors).toEqual([]);
  expect(result.checks.map(c => c.id)).toEqual(["first", "second"]);
});

it("returns a validation error through the API input helper", () => {
  expect(checkFromInput(bad).error).toMatch(/Unresolved alias/);
  expect(checkFromInput({ yaml: bad }).error).toMatch(/Unresolved alias/);
  expect(checkFromInput(good).check?.id).toBe("valid");
});

it("loads other files and the library when a user check has a broken alias", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-alias-"));
  dirs.push(dir);
  const checks = path.join(dir, "checks");
  fs.mkdirSync(checks);
  fs.writeFileSync(path.join(checks, "bad.yaml"), bad);
  fs.writeFileSync(path.join(checks, "good.yaml"), good);
  const store = new Store(dir);
  try {
    const registry = new CheckRegistry(store, checks, () => []);
    expect(registry.get("valid")).toBeDefined();
    expect(registry.get("repeated-tool-call")).toBeDefined();
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0].path).toBe(path.join(checks, "bad.yaml"));
  } finally {
    store.close();
  }
});

it("smoke: 60 unresolved aliases and 60 valid controls", () => {
  let errors = 0, controls = 0;
  for (let i = 0; i < 60; i++) {
    const invalid = parseChecks(bad.replace("missing", `missing${i}`));
    expect(invalid.checks).toEqual([]);
    expect(invalid.errors).toHaveLength(1);
    errors++;
    const valid = parseChecks(good.replace("valid", `valid${i}`));
    expect(valid.errors).toEqual([]);
    expect(valid.checks).toHaveLength(1);
    controls++;
  }
  expect({ errors, controls }).toEqual({ errors: 60, controls: 60 });
});
