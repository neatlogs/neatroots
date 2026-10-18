import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, closeTrackedStores, hex, tmpHome, toolSpan, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const library = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks;
const softFailure = library.find((c) => c.id === "soft-tool-failure") as RuleCheck;

/** An MCP tools/call result: the tool's own output is a string inside content[].text. */
const mcp = (text: string, isError = false) => JSON.stringify({ content: [{ type: "text", text }], isError });

function fires(rule: RuleCheck, output: string): boolean {
  const h = tmpHome();
  homes.push(h);
  const st = trackedStore(path.join(h, "data"));
  const t = hex(16);
  st.ingest([batch([toolSpan(t, hex(8), "get_weather", '{"city":"Lagos"}', output)])]);
  return evaluateRule(rule, loadTrace(st, t), false)?.firing === true;
}

describe("match rules read the text items of an MCP result", () => {
  it("fires soft-tool-failure on a failure wrapped in an MCP result, as it does unwrapped", () => {
    const fails = [
      '{"error":"city not found","code":"NOT_FOUND"}',
      '{"status":404,"message":"no such city"}',
      '{"errors":["invalid api key"]}',
      "Error: city not found",
    ];
    for (const out of fails) {
      expect(fires(softFailure, out), out).toBe(true);
      expect(fires(softFailure, mcp(out)), `mcp ${out}`).toBe(true);
    }
  });

  it("stays quiet on normal output wrapped in an MCP result", () => {
    const clean = ['{"temp_c":31,"sky":"sunny"}', '{"error":null}', '{"errors":[]}', '{"status":200}', "no errors found", "Error handling guide for developers"];
    for (const out of clean) expect(fires(softFailure, mcp(out)), `mcp ${out}`).toBe(false);
  });

  it("stays quiet on structured output whose fields only mention errors", () => {
    const clean = [
      '{"results":[{"title":"Error: Cannot find module - how to fix","url":"https://example.com/a"}]}',
      '{"docs":"Example response: {\\"status\\": 404}","section":"errors"}',
      '{"path":"config.yaml","body":"retries: 3\\nerror: log\\n"}',
      '{"lines":["INFO start","error: disk almost full (warning only)"]}',
      '{"content":"Error: not a list of items, so not an MCP result"}',
    ];
    for (const out of clean) expect(fires(softFailure, out), out).toBe(false);
  });

  it("reads MCP text items within the same character budget as the field", () => {
    const filler = Array.from({ length: 3000 }, () => ({ type: "text", text: "x".repeat(100) }));
    // 3000 x 100 chars of text items use up the 200,000 budget before the error item is reached.
    const late = JSON.stringify({ content: [...filler, { type: "text", text: '{"error":"city not found"}' }] });
    expect(fires(softFailure, late)).toBe(false);
    const early = JSON.stringify({ content: [{ type: "text", text: '{"error":"city not found"}' }, ...filler] });
    expect(fires(softFailure, early)).toBe(true);
  });
});
