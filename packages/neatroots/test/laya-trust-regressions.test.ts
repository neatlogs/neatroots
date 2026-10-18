import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { DecisionModel, createTrustStore, memoryTrust, questionSignature, type DecisionQuestion, type DecisionResult } from "../src/models/decision.js";
import { toQuestion } from "../src/engine/engine.js";
import { LlmClient } from "../src/models/llm.js";
import { Store } from "../src/store/db.js";
import { makeRoots, tmpHome } from "./helpers.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const question: DecisionQuestion = { name: "approval", type: "yes_no", ask: "Was approval missing?" };
const earn = (trust: ReturnType<typeof memoryTrust>, q: DecisionQuestion) => { for (let i = 0; i < 30; i++) trust.record(q, true); };

describe("definition trust integrity", () => {
  it("cannot promote name-only observations, before or after a definition is active", () => {
    const trust = memoryTrust();
    for (let i = 0; i < 30; i++) trust.record(question.name, true);
    expect(trust.get(question)).toEqual({ n: 0, agree: 0 });
    trust.activate?.(question);
    trust.record(question.name, true);
    expect(trust.get(question)).toEqual({ n: 0, agree: 0 });
  });

  it("distinguishes exact effective text and ordered levels while canonicalizing option keys", () => {
    expect(questionSignature(question)).not.toBe(questionSignature({ ...question, ask: question.ask + " " }));
    const choice: DecisionQuestion = { ...question, type: "choice", options: { z: "Z", a: "A" } };
    expect(questionSignature(choice)).toBe(questionSignature({ ...choice, options: { a: "A", z: "Z" } }));
    expect(questionSignature(choice)).not.toBe(questionSignature({ ...choice, options: { a: "Changed", z: "Z" } }));
    const score: DecisionQuestion = { ...question, type: "score", levels: ["safe", "unsafe"] };
    expect(questionSignature(score)).not.toBe(questionSignature({ ...score, levels: ["unsafe", "safe"] }));
    const trust = memoryTrust(); earn(trust, choice); earn(trust, score);
    expect(trust.get({ ...choice, options: { a: "A", z: "Z" } }).n).toBe(30);
    expect(trust.get({ ...score, levels: ["unsafe", "safe"] }).n).toBe(0);
  });

  it.each([{ n: -1, agree: 0 }, { n: 30, agree: 31 }, { n: 30.5, agree: 30 }, { n: Infinity, agree: 30 }, { n: 30, agree: NaN }])("rejects malformed persisted counters %j", stats => {
    const sig = questionSignature(question);
    const trust = createTrustStore({ approval: { activeSig: sig, defs: { [sig]: stats } } });
    expect(trust.get(question)).toEqual({ n: 0, agree: 0 });
  });

  it("shares exact observations between callers and flushes them before a real store reopen", () => {
    const home = tmpHome(); cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const first = new Store(home); cleanup.push(() => { if (first.db.open) first.close(); });
    const a = first.trustStore(); earn(a, question);
    const b = first.trustStore();
    for (let i = 0; i < 10; i++) a.record(question, false);
    b.record(question, true);
    expect(a.get(question)).toEqual({ n: 41, agree: 31 });
    expect(b.get(question)).toEqual({ n: 41, agree: 31 });
    first.close();
    const second = new Store(home); cleanup.push(() => second.close());
    expect(second.trustStore().get(question)).toEqual({ n: 41, agree: 31 });
  });

  it("does not promote legacy counts after reopening the actual store", () => {
    const home = tmpHome(); cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const first = new Store(home);
    first.setMeta("laya_trust", JSON.stringify({ approval: { n: 30, agree: 30 } })); first.close();
    const second = new Store(home); cleanup.push(() => second.close());
    expect(second.trustStore().get(question)).toEqual({ n: 0, agree: 0 });
  });

  it.each(["yes_no", "choice", "score"] as const)("captures the effective %s definition before awaiting the reference backend", async type => {
    const cfg = defaultConfig(); cfg.classifier.backend = "auto"; cfg.classifier.baseUrl = "";
    const trust = memoryTrust();
    const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm), undefined, trust);
    vi.spyOn(dm.llmBackend, "available").mockResolvedValue(true);
    vi.spyOn(dm.laya, "available").mockResolvedValue(true);
    let release!: (r: DecisionResult) => void;
    const reference = new Promise<DecisionResult>(resolve => { release = resolve; });
    const llm = vi.spyOn(dm.llmBackend, "decide").mockReturnValue(reference);
    const original: DecisionQuestion = { ...question, type, options: { bad: "Unsafe", good: "Safe" }, levels: ["safe", "unsafe"] };
    const result: DecisionResult = { backend: "llm", model: "mock", latencyMs: 1, answers: { approval: { name: "approval", type, probability: 0.9, choice: "bad", score: 1, distribution: { yes: 0.9, no: 0.1 } } } };
    const shadow = vi.spyOn(dm.laya, "decide").mockResolvedValue({ ...result, backend: "laya" });
    const mutable = { ...original, options: { ...original.options }, levels: [...original.levels!] };
    const pending = dm.decide("evidence", [mutable]);
    await vi.waitFor(() => expect(llm).toHaveBeenCalledOnce());
    mutable.ask = "A different question";
    mutable.options.bad = "Changed option";
    mutable.levels[0] = "Changed level";
    release(result); await pending;
    await vi.waitFor(() => expect(shadow).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(trust.get(original)).toEqual({ n: 1, agree: 1 }));
    expect(trust.get(mutable)).toEqual({ n: 0, agree: 0 });
    // The same captured state/definition is cached without another fabricated observation.
    await dm.decide("evidence", [{ ...original }]);
    expect(llm).toHaveBeenCalledOnce(); expect(shadow).toHaveBeenCalledOnce();
  });

  it.each(["auto", "laya", "llm"] as const)("keeps %s routing compatible for an uncalibrated edited definition", async backend => {
    const cfg = defaultConfig(); cfg.classifier.backend = backend; cfg.classifier.baseUrl = "";
    const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm));
    vi.spyOn(dm.laya, "available").mockResolvedValue(true);
    // Auto must retain the documented no-reference fallback even without earned trust.
    vi.spyOn(dm.llmBackend, "available").mockResolvedValue(backend !== "auto");
    const empty = { model: "mock", latencyMs: 0, answers: {} };
    vi.spyOn(dm.laya, "decide").mockResolvedValue({ ...empty, backend: "laya" });
    vi.spyOn(dm.llmBackend, "decide").mockResolvedValue({ ...empty, backend: "llm" });
    expect(dm.trusted([question])).toBe(false);
    expect((await dm.decide("state", [question])).backend).toBe(backend === "llm" ? "llm" : "laya");
    expect(dm.trust.get(question)).toEqual({ n: 0, agree: 0 });
  });

  it("reports current registry defaults without mutating runtime trust, including a file reload", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true }); cleanup.push(tb.close);
    const check = { id: "approval", kind: "yes_no" as const, ask: "Was {tool} approval missing?", params: { tool: "lookup" } };
    const saved = tb.roots.checks.save(check, "user");
    const defaults = toQuestion(check, check.params);
    const runtime = toQuestion(check, { tool: "refund" });
    const trust = tb.roots.decisions.trust;
    earn(trust, runtime); trust.activate?.(runtime);
    const before = trust.all(); const metaBefore = tb.roots.store.getMeta("laya_trust");
    const status = await (await fetch(`${tb.url}/api/status`)).json();
    expect(status.classifier.trust.find((r: { question: string }) => r.question === "approval")).toMatchObject({ n: 0, trusted: false });
    expect(trust.all()).toEqual(before);
    expect(tb.roots.store.getMeta("laya_trust")).toBe(metaBefore);
    expect(tb.roots.decisions.trusted([runtime])).toBe(true);
    expect(tb.roots.decisions.trusted([defaults])).toBe(false);
    earn(trust, defaults);
    const file = tb.roots.checks.get(saved.check.id)!.path!;
    fs.writeFileSync(file, "id: approval\nkind: yes_no\nask: Did the agent ignore approval?\n");
    tb.roots.checks.reload();
    const edited = await (await fetch(`${tb.url}/api/status`)).json();
    expect(edited.classifier.trust.find((r: { question: string }) => r.question === "approval")).toMatchObject({ n: 0, trusted: false });
    // Default reporting never transfers or clears previously earned effective definitions.
    expect(trust.get(defaults)).toEqual({ n: 30, agree: 30 });
    expect(trust.get(runtime)).toEqual({ n: 30, agree: 30 });
    expect(path.isAbsolute(file)).toBe(true);
  });
});
