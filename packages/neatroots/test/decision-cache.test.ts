import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { DecisionModel, type DecisionResult } from "../src/models/decision.js";
import { LlmClient } from "../src/models/llm.js";

const questions = [{ name: "q", type: "yes_no" as const, ask: "Did the run fail?" }];

function answer(backend: string, probability: number): DecisionResult {
  return {
    backend,
    model: `${backend}-model`,
    answers: { q: { name: "q", type: "yes_no", probability, distribution: { yes: probability, no: 1 - probability } } },
    latencyMs: 10,
  };
}

function setup() {
  const cfg = defaultConfig();
  cfg.classifier.backend = "laya";
  const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm));
  vi.spyOn(dm.laya, "available").mockResolvedValue(true);
  vi.spyOn(dm.jev, "available").mockResolvedValue(true);
  const laya = vi.spyOn(dm.laya, "decide").mockResolvedValue(answer("laya", 0.1));
  const jev = vi.spyOn(dm.jev, "decide").mockResolvedValue(answer("jev", 0.99));
  return { cfg, dm, laya, jev };
}

afterEach(() => vi.restoreAllMocks());

describe("decision cache reset", () => {
  it("reuses identical decisions until reset, then evaluates with the selected backend", async () => {
    const { cfg, dm, laya, jev } = setup();
    const first = await dm.decide("same evidence", questions);
    expect(await dm.decide("same evidence", questions)).toEqual({ ...first, latencyMs: 0 });
    expect(laya).toHaveBeenCalledTimes(1);

    cfg.classifier.backend = "jev";
    dm.reset();
    const current = await dm.decide("same evidence", questions);
    expect(current).toEqual(answer("jev", 0.99));
    expect(await dm.decide("same evidence", questions)).toEqual({ ...current, latencyMs: 0 });
    expect(jev).toHaveBeenCalledTimes(1);
  });

  it("reevaluates identical evidence after changing the model on the same backend", async () => {
    const { cfg, dm, jev } = setup();
    cfg.classifier.backend = "jev";
    jev.mockImplementation(async () => ({ ...answer("jev", 0.99), model: cfg.classifier.model }));
    cfg.classifier.model = "old-model";
    expect((await dm.decide("same evidence", questions)).model).toBe("old-model");
    cfg.classifier.model = "new-model";
    dm.reset();
    expect((await dm.decide("same evidence", questions)).model).toBe("new-model");
    expect(jev).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("isolates a pre-reset request when the new answer is already cached: %s", async (cacheNewFirst) => {
    const { cfg, dm, laya, jev } = setup();
    let finishOld!: (result: DecisionResult) => void;
    let started!: () => void;
    const oldStarted = new Promise<void>((resolve) => { started = resolve; });
    laya.mockImplementation(() => {
      started();
      return new Promise<DecisionResult>((resolve) => { finishOld = resolve; });
    });
    const oldRequest = dm.decide("same evidence", questions);
    await oldStarted;
    cfg.classifier.backend = "jev";
    dm.reset();
    if (cacheNewFirst) expect(await dm.decide("same evidence", questions)).toEqual(answer("jev", 0.99));

    // An existing caller may finish with its old answer, but cannot cache it for new callers.
    finishOld(answer("laya", 0.1));
    expect(await oldRequest).toEqual(answer("laya", 0.1));
    const current = await dm.decide("same evidence", questions);
    expect(current).toEqual({ ...answer("jev", 0.99), latencyMs: cacheNewFirst ? 0 : 10 });
    expect(await dm.decide("same evidence", questions)).toEqual({ ...current, latencyMs: 0 });
    expect(jev).toHaveBeenCalledTimes(1);
    expect(laya).toHaveBeenCalledTimes(1);
  });
});
