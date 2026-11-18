import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { buildView } from "../src/semantics/view.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, s, span, tmpHome } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function testStore(): Store {
  const h = tmpHome();
  homes.push(h);
  return new Store(path.join(h, "data"));
}

const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const replyTruncatedRule = lib.find((c) => c.id === "reply-truncated")!;

describe("Feature #386: finish_reason and reply-truncated", () => {
  describe("SpanView finishReason extraction", () => {
    it("extracts from neatlogs.llm.finish_reason", () => {
      const sp = span({
        traceId: hex(16),
        name: "chat",
        kind: "llm",
        attrs: [s("neatlogs.llm.finish_reason", "max_tokens")],
      });
      const v = buildView(sp, []);
      expect(v.finishReason).toBe("max_tokens");
    });

    it("extracts from gen_ai.response.finish_reasons (array and string)", () => {
      const spArray = span({
        traceId: hex(16),
        name: "chat",
        kind: "llm",
        attrs: [{ key: "gen_ai.response.finish_reasons", value: { arrayValue: { values: [{ stringValue: "length" }] } } }],
      });
      expect(buildView(spArray, []).finishReason).toBe("length");

      const spStr = span({
        traceId: hex(16),
        name: "chat",
        kind: "llm",
        attrs: [s("gen_ai.response.finish_reasons", "length")],
      });
      expect(buildView(spStr, []).finishReason).toBe("length");
    });

    it("extracts from llm.finish_reason", () => {
      const sp = span({
        traceId: hex(16),
        name: "chat",
        kind: "llm",
        attrs: [s("llm.finish_reason", "stop")],
      });
      expect(buildView(sp, []).finishReason).toBe("stop");
    });
  });

  describe("match rule with field: finish_reason", () => {
    const customMatchCheck: RuleCheck = {
      id: "test-truncated",
      kind: "rule",
      rule: {
        type: "match",
        span: { type: "llm" },
        field: "finish_reason",
        pattern: "^(max_tokens|length|MAX_TOKENS)$",
        flags: "i",
      },
    };

    it("matches truncated replies and ignores end_turn/stop/tool_use", () => {
      const st = testStore();
      const t = hex(16);
      const root = hex(8);

      st.ingest([
        batch([
          span({
            traceId: t,
            spanId: root,
            name: "call-stop",
            kind: "llm",
            attrs: [s("neatlogs.llm.finish_reason", "stop")],
          }),
          span({
            traceId: t,
            name: "call-end-turn",
            kind: "llm",
            attrs: [s("neatlogs.llm.finish_reason", "end_turn")],
          }),
          span({
            traceId: t,
            name: "call-tool-use",
            kind: "llm",
            attrs: [s("neatlogs.llm.finish_reason", "tool_use")],
          }),
        ]),
      ]);

      expect(evaluateRule(customMatchCheck, loadTrace(st, t), false)).toBeNull();

      st.ingest([
        batch([
          span({
            traceId: t,
            name: "call-truncated",
            kind: "llm",
            attrs: [s("neatlogs.llm.finish_reason", "length")],
          }),
        ]),
      ]);

      const hit = evaluateRule(customMatchCheck, loadTrace(st, t), false);
      expect(hit).not.toBeNull();
      expect(hit?.firing).toBe(true);
      expect(hit?.evidenceSpanIds).toHaveLength(1);
    });
  });

  describe("reply-truncated built-in rule", () => {
    it("fires on max_tokens and stays quiet on complete replies", () => {
      const st = testStore();
      const t = hex(16);
      const root = hex(8);

      st.ingest([
        batch([
          span({
            traceId: t,
            spanId: root,
            name: "complete-call",
            kind: "llm",
            attrs: [s("neatlogs.llm.finish_reason", "stop")],
          }),
        ]),
      ]);
      expect(evaluateRule(replyTruncatedRule, loadTrace(st, t), false)).toBeNull();

      st.ingest([
        batch([
          span({
            traceId: t,
            name: "cut-off-call",
            kind: "llm",
            attrs: [s("neatlogs.llm.finish_reason", "max_tokens")],
          }),
        ]),
      ]);
      const hit = evaluateRule(replyTruncatedRule, loadTrace(st, t), false);
      expect(hit).not.toBeNull();
      expect(hit?.firing).toBe(true);
    });
  });
});
