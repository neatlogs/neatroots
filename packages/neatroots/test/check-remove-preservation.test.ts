import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CheckRegistry, parseChecks } from "../src/checks/registry.js";
import { Store } from "../src/store/db.js";
import { makeRoots } from "./helpers.js";

let dir: string, file: string, store: Store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-remove-preservation-"));
  fs.mkdirSync(path.join(dir, "checks"));
  file = path.join(dir, "checks", "team.yaml");
  store = new Store(path.join(dir, "data"));
});
afterEach(() => { vi.restoreAllMocks(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const registry = () => new CheckRegistry(store, path.join(dir, "checks"), () => []);
const block = (id: string) => `- id: ${id}\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 1}\n`;
const map = (id: string) => block(id).slice(2).replaceAll("\n  ", "\n");
const flow = (id: string) => `{id: ${id}, kind: rule, rule: {type: count, span: {type: tool}, at_least: 1}}`;
const write = (text: string) => fs.writeFileSync(file, text);
const read = () => fs.readFileSync(file, "utf8");

for (const eol of ["\n", "\r\n"]) {
  it(`keeps wrapper metadata and comments with a valid empty block sequence (${JSON.stringify(eol)})`, () => {
    const before = ("# heading\nowner: team\nchecks: # list\n" + block("a").split("\n").filter(Boolean).map(l => "  " + l).join("\n") + "\n# trailing\n").replaceAll("\n", eol);
    write(before); const r = registry(); r.remove("a");
    expect(read()).toBe(("# heading\nowner: team\nchecks: [] # list\n# trailing\n").replaceAll("\n", eol));
    expect(parseChecks(read())).toEqual({ checks: [], errors: [] });
  });
  it(`removes commented and multiline dash markers without changing the next check (${JSON.stringify(eol)})`, () => {
    const before = ("# heading\n- # selected\n  # marker continuation\n  " + map("a").trimEnd().replaceAll("\n", "\n  ") + "\n# keep b\n" + block("b")).replaceAll("\n", eol);
    write(before); const r = registry(); expect(r.get("a")).toBeDefined(); r.remove("a");
    expect(read()).toBe(("# heading\n# keep b\n" + block("b")).replaceAll("\n", eol));
    expect(r.get("b")).toBeDefined(); expect(r.errors).toEqual([]);
  });
}

it("handles a sole wrapper without leaving checks:null", () => {
  write("checks:\n" + block("a").split("\n").filter(Boolean).map(l => "  " + l).join("\n") + "\n");
  registry().remove("a");
  expect(fs.existsSync(file) ? parseChecks(read()) : { checks: [], errors: [] }).toEqual({ checks: [], errors: [] });
});

for (const ids of [["a", "a", "b"], ["b", "a", "a"], ["b", "a", "a", "c"], ["a", "a"], ["a", "b", "a"]]) {
  it(`removes flow duplicates safely: ${ids.join(",")}`, () => {
    write(`[ ${ids.map(flow).join(", ")} ]\n`); const r = registry(); r.remove("a");
    const left = fs.existsSync(file) ? parseChecks(read()) : { checks: [], errors: [] };
    expect(left.errors).toEqual([]); expect(left.checks.map(c => c.id)).toEqual(ids.filter(id => id !== "a"));
    if (fs.existsSync(file)) {
      for (const id of ids.filter(id => id !== "a")) expect(read()).toContain(flow(id));
      expect(read()).not.toMatch(/,\s*,|\[\s*,|,\s*\]/);
    }
  });
}

it("preserves comments between flow entries while removing only selected entries and commas", () => {
  write(`[ ${flow("a")}, # keep this comment\n  ${flow("b")}, ${flow("a")} ] # ending\n`);
  const r = registry(); r.remove("a");
  expect(read()).toContain("# keep this comment\n"); expect(read()).toContain("# ending\n");
  expect(read()).toContain(flow("b")); expect(parseChecks(read()).checks.map(c => c.id)).toEqual(["b"]);
});

it.each(["block", "map"])("keeps comments-only remnants after deleting a sole %s check", shape => {
  const body = shape === "block" ? block("a") : map("a");
  write("# heading\n" + body + "# trailing\n"); registry().remove("a");
  expect(read()).toBe("# heading\n# trailing\n");
});

it("preserves document markers and leading/trailing comments outside the owned map", () => {
  write("---\n# heading\n" + map("a") + "# trailing\n...\n---\n" + map("b"));
  const r = registry(); r.remove("a");
  expect(read()).toBe("---\n# heading\n# trailing\n...\n---\n" + map("b"));
  expect(r.get("b")).toBeDefined(); expect(r.errors).toEqual([]);
});

it("preserves invalid drafts and malformed later documents despite shifted error positions", () => {
  const rest = "# draft\n- id: draft\n  kind: score\n  ask: Is this rude?\n  levels: [low, high]\n  flag_at_level: 7\n---\n[broken\n";
  write(block("a") + rest); const r = registry(); expect(r.errors).toHaveLength(2); r.remove("a");
  expect(read()).toBe(rest); expect(r.errors).toHaveLength(2);
});

it("refuses a changed post-cut survivor independently of the anchor guard without any mutation", () => {
  const before = block("a") + block("b"); write(before); const r = registry();
  const rows = store.db.prepare("SELECT * FROM checks ORDER BY id").all();
  const parse = YAML.parseAllDocuments;
  vi.spyOn(YAML, "parseAllDocuments").mockImplementation((text, options) =>
    parse(text === before ? text : text.replace("id: b", "id: changed"), options));
  expect(() => r.remove("a")).toThrow(/preserv|chang|integrity/i);
  expect(read()).toBe(before); expect(store.db.prepare("SELECT * FROM checks ORDER BY id").all()).toEqual(rows);
  expect(r.get("a")).toBeDefined(); expect(r.get("b")).toBeDefined();
});

it("returns HTTP409 for post-cut integrity failure with file, database and registry unchanged", async () => {
  const before = block("a") + block("b"); write(before);
  const t = await makeRoots({ noEngine: true, serve: true, config: c => { c.checkDirs = [path.dirname(file)]; } });
  try {
    const rows = t.roots.store.db.prepare("SELECT * FROM checks ORDER BY id").all();
    const parse = YAML.parseAllDocuments;
    vi.spyOn(YAML, "parseAllDocuments").mockImplementation((text, options) =>
      parse(text === before ? text : text.replace("id: b", "id: changed"), options));
    const response = await fetch(`${t.url}/api/checks/a`, { method: "DELETE" });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: expect.stringMatching(/preserv|chang|integrity/i) });
    expect(read()).toBe(before); expect(t.roots.store.db.prepare("SELECT * FROM checks ORDER BY id").all()).toEqual(rows);
    expect(t.roots.checks.get("a")).toBeDefined(); expect(t.roots.checks.get("b")).toBeDefined();
  } finally { vi.restoreAllMocks(); await t.close(); }
});

it("removes duplicate flow entries with an existing trailing comma", () => {
  write(`[ ${flow("b")}, ${flow("a")}, ${flow("a")}, ]\n`); const r = registry(); r.remove("a");
  expect(parseChecks(read()).errors).toEqual([]);
  expect(parseChecks(read()).checks.map(c => c.id)).toEqual(["b"]);
  expect(read()).not.toMatch(/,\s*,|,\s*\]/);
});

it("keeps an inline list marker comment when an indentless wrapper becomes empty", () => {
  write("checks: # keep this\n" + block("a") + "# bottom\n"); registry().remove("a");
  expect(read()).toBe("checks: [] # keep this\n# bottom\n");
});

it("removes an owned document anchor while preserving outside comments", () => {
  write("# heading\n&owned\n" + map("a") + "# trailing\n"); registry().remove("a");
  expect(read()).toBe("# heading\n\n# trailing\n");
});

for (const properties of ["&list", "!!seq", "&list !!seq", "!!seq &list"]) {
  it(`preserves empty wrapper value properties: ${properties}`, () => {
    const before = `owner: team\nchecks: ${properties} # list comment\n` + block("a").split("\n").filter(Boolean).map(l => "  " + l).join("\n") + "\n# trailing\n";
    write(before); const r = registry(); expect(r.get("a")).toBeDefined(); r.remove("a");
    expect(read()).toBe(`owner: team\nchecks: ${properties} [] # list comment\n# trailing\n`);
    expect(parseChecks(read())).toEqual({ checks: [], errors: [] });
  });
}

it("preserves wrapper properties and comments split across lines", () => {
  write("checks: # header\n  &list !!seq # properties\n" + block("a").split("\n").filter(Boolean).map(l => "  " + l).join("\n") + "\n# trailing\n");
  const r = registry(); expect(r.get("a")).toBeDefined(); r.remove("a");
  expect(read()).toBe("checks: # header\n  &list !!seq [] # properties\n# trailing\n");
  expect(parseChecks(read())).toEqual({ checks: [], errors: [] });
});
