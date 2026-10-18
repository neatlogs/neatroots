import assert from "node:assert/strict";
import test from "node:test";
import { modelChecksComplete } from "./smoke-checks.mjs";

const done = { state: "done", model: { available: true }, questions: 3, answered: 3, pending: 0, failed: 0 };
test("requires answered model-backed completion", () => assert.equal(modelChecksComplete(done), true));
for (const state of ["partial", "interrupted", "rules-only", "checking"]) {
  test(`rejects ${state} with an idle queue and no failed checks`, () => {
    assert.equal(modelChecksComplete({ ...done, state }), false);
  });
}
for (const change of [{ answered: 2 }, { questions: 0, answered: 0 }, { pending: 1 }, { failed: 1 }, { model: { available: false } }]) {
  test(`rejects incomplete accounting ${JSON.stringify(change)}`, () => assert.equal(modelChecksComplete({ ...done, ...change }), false));
}
