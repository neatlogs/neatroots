import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkFiles } from "../src/checks/offline.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-missing-checks-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
const folder = path.join(home, "custom checks");
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, "rule.yaml"), "id: missing-dir-proof\nkind: rule\nrule: {type: match, field: name, pattern: forbidden}\n");
const trace = path.join(home, "trace.json");
fs.writeFileSync(trace, JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: {}, spans: [{
  traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", name: "forbidden",
  startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000010000000", attributes: [], status: { code: 1 },
}] }] }] }));
const missing = path.join(home, "misspelled checks");
function cli(dirs: string[], json: boolean) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "check", trace, "--checks", ...dirs, ...(json ? ["--json"] : [])], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, NEATROOTS_HOME: home }, encoding: "utf8",
  });
}
describe("explicit offline checks directories", () => {
  it("rejects an explicitly requested directory that is missing", () => {
    expect(() => checkFiles([trace], { dirs: [missing] })).toThrow(/checks directory does not exist/);
  });
  it("rejects a missing directory even alongside a valid directory", () => {
    for (const dirs of [[folder, missing], [missing, folder]]) expect(() => checkFiles([trace], { dirs })).toThrow(/checks directory does not exist/);
  });
  it("returns input error 2 in CLI text and JSON modes rather than a clean verdict", () => {
    for (const json of [false, true]) {
      const result = cli([folder, missing], json);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(missing);
      expect(result.stderr).toContain("checks directory does not exist");
      expect(result.stdout).toBe("");
    }
  });
  it("loads an existing directory containing spaces", () => {
    expect(checkFiles([trace], { dirs: [folder] }).runs[0].findings.map((f) => f.check_id)).toContain("missing-dir-proof");
  });
  it("rejects a file passed as a checks directory", () => {
    expect(() => checkFiles([trace], { dirs: [trace] })).toThrow(`checks path is not a directory: ${trace}`);
  });
  it("keeps an absent optional user checks directory and explicit empty directory valid", () => {
    const empty = path.join(home, "empty");
    fs.mkdirSync(empty);
    expect(checkFiles([trace]).runs).toHaveLength(1);
    expect(checkFiles([trace], { dirs: [empty] }).runs).toHaveLength(1);
  });
});
