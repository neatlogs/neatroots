import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, closeTrackedStores, hex, s, span, tmpHome, trackedStore, toolSpan } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const check = (parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[]).find(
  (c) => c.id === "unrecovered-tool-failure",
)!;

/** A run whose only tool call failed, then answered with `answer`. */
function fires(answer: string): boolean {
  const h = tmpHome();
  homes.push(h);
  const st = trackedStore(path.join(h, "data"));
  const t = hex(16);
  const root = hex(8);
  st.ingest([
    batch([
      toolSpan(t, root, "book_flight", '{"flight":"W3 101"}', undefined, "payment service unavailable"),
      span({ traceId: t, spanId: root, name: "root", kind: "workflow", status: 1, attrs: [s("neatlogs.workflow.output", answer)] }),
    ]),
  ]);
  return evaluateRule(check, loadTrace(st, t), true)?.firing === true;
}

describe("unrecovered-tool-failure and honest answers", () => {
  it("stays quiet when the answer admits the failure with a curly apostrophe", () => {
    for (const answer of [
      "I couldn\u2019t book the flight because the payment service is down.",
      "I can\u2019t book the flight right now; the payment service is down.",
      "The booking didn\u2019t go through.",
      "The booking did not go through.",
      "The payment did not succeed, so the flight is not booked.",
    ]) {
      expect(fires(answer), answer).toBe(false);
    }
  });

  it("stays quiet on \"wasn't able\" and \"failures\"", () => {
    for (const answer of [
      "I wasn't able to book the flight because the payment service is down.",
      "We weren\u2019t able to complete the booking.",
      "There were two failures with the payment service, so the flight is not booked.",
    ]) {
      expect(fires(answer), answer).toBe(false);
    }
  });

  it("stays quiet on doesn't, won't, \"can not\", and backtick or fullwidth apostrophes", () => {
    for (const answer of [
      "The payment doesn't work right now, so the flight isn't booked.",
      "The booking won\u2019t go through because the payment service is down.",
      "The payment does not work, so the flight is not booked.",
      "I can not book the flight because the payment service is down.",
      "I couldn`t book the flight because the payment service is down.",
      "I couldn\uFF07t book the flight because the payment service is down.",
    ]) {
      expect(fires(answer), answer).toBe(false);
    }
  });

  it("still fires when the answer claims success or denies failures", () => {
    for (const answer of [
      "Your flight is booked. Confirmation sent to your email.",
      "Booked with no failures. You\u2019re all set!",
      "There weren\u2019t any failures, you\u2019re booked.",
      "There wasn't any error. Your flight is booked.",
      "There were not any failures and the flight is booked.",
      "It never hit any errors. Booked!",
      "Booked. There were 0 failures.",
    ]) {
      expect(fires(answer), answer).toBe(true);
    }
  });
});
