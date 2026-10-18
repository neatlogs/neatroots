import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, span, tmpHome } from "./helpers.js";
const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const st of stores.splice(0)) st.close();
  for (const h of homes.splice(0))
    fs.rmSync(h, { recursive: true, force: true });
});
describe("match stateful flags", () => {
  for (const flags of ["g", "y", "gi", "iy"]) {
    it(`keeps every matching span with ${flags}`, () => {
      const home = tmpHome();
      homes.push(home);
      const st = new Store(path.join(home, "data"));
      stores.push(st);
      const trace = hex(16);
      const spans = Array.from({ length: 4 }, () =>
        span({ traceId: trace, name: "secret", kind: "tool" }),
      );
      st.ingest([batch(spans)]);
      const parsed = parseChecks(
        `id: stateful\nkind: rule\nrule: {type: match, field: name, pattern: secret, flags: ${flags}}\n`,
      );
      expect(parsed.errors).toEqual([]);
      const result = evaluateRule(
        parsed.checks[0] as RuleCheck,
        loadTrace(st, trace),
        true,
      );
      expect(result?.evidenceSpanIds).toEqual(spans.map((s) => s.spanId));
      expect(result?.params.count).toBe("4");
    });
  }
});

describe("match fields and controls", () => {
  for (const field of ["input", "output", "error", "name"] as const) {
    it(`matches ${field} independently with global and sticky flags`, () => {
      const home = tmpHome();
      homes.push(home);
      const st = new Store(path.join(home, "data"));
      stores.push(st);
      const trace = hex(16);
      const raw = Array.from({ length: 4 }, () =>
        span({ traceId: trace, name: "plain", kind: "tool" }),
      );
      st.ingest([batch(raw)]);
      const snap = loadTrace(st, trace);
      for (const flags of ["g", "y", "i", ""]) {
        const check = parseChecks(
          `id: fields\nkind: rule\nrule: {type: match, field: ${field}, pattern: secret, flags: '${flags}'}\n`,
        ).checks[0] as RuleCheck;
        const changed = {
          ...snap,
          spans: snap.spans.map((s, i) => ({
            ...s,
            [field]: i < 2 ? "secret" : "plain",
          })),
        };
        expect(evaluateRule(check, changed, true)?.evidenceSpanIds).toEqual(
          snap.spans.slice(0, 2).map((s) => s.id),
        );
        expect(
          evaluateRule(
            check,
            {
              ...snap,
              spans: snap.spans.map((s) => ({ ...s, [field]: "plain" })),
            },
            true,
          ),
        ).toBeNull();
      }
    });
  }
  it("global searches anywhere but sticky still matches only at the start", () => {
    const home = tmpHome();
    homes.push(home);
    const st = new Store(path.join(home, "data"));
    stores.push(st);
    const trace = hex(16);
    st.ingest([
      batch(
        Array.from({ length: 2 }, () =>
          span({ traceId: trace, name: "prefix secret", kind: "tool" }),
        ),
      ),
    ]);
    const snap = loadTrace(st, trace);
    const check = (flags: string) =>
      parseChecks(
        `id: position\nkind: rule\nrule: {type: match, field: name, pattern: secret, flags: ${flags}}\n`,
      ).checks[0] as RuleCheck;
    expect(evaluateRule(check("g"), snap, true)?.params.count).toBe("2");
    expect(evaluateRule(check("y"), snap, true)).toBeNull();
  });
});

describe("saved trace smoke", () => {
  it("keeps all evidence for 60 matching runs and none for 60 clean runs", async () => {
    const { checkFiles } = await import("../src/checks/offline.js");
    const home = tmpHome();
    homes.push(home);
    const folder = path.join(home, "checks");
    fs.mkdirSync(folder);
    let positive = 0,
      clean = 0;
    for (let i = 0; i < 120; i++) {
      const expected = i % 2 === 0;
      const trace = hex(16);
      const ids = Array.from({ length: 4 }, () => hex(8));
      const spans = ids.map((spanId) =>
        span({
          traceId: trace,
          spanId,
          name: expected ? "secret" : "plain",
          kind: "tool",
        }),
      );
      const file = path.join(home, "trace.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          resourceSpans: [
            { resource: { attributes: [] }, scopeSpans: [{ spans }] },
          ],
        }),
      );
      fs.writeFileSync(
        path.join(folder, "rule.yaml"),
        `id: smoke\nkind: rule\nrule: {type: match, field: name, pattern: secret, flags: ${["g", "y", "gi", "iy"][Math.floor(i / 2) % 4]}}\n`,
      );
      const result = checkFiles([file], { dirs: [folder], only: ["smoke"] });
      expect(result.errors).toEqual([]);
      const findings = result.runs[0].findings;
      if (expected) {
        expect(findings).toHaveLength(1);
        expect(findings[0].evidence_span_ids).toEqual(ids);
        expect(findings[0].params.count).toBe("4");
        positive++;
      } else {
        expect(findings).toEqual([]);
        clean++;
      }
    }
    expect({ positive, clean }).toEqual({ positive: 60, clean: 60 });
  });
});
