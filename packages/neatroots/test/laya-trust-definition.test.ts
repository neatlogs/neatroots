import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { DecisionModel, memoryTrust, TRUST_MIN_SAMPLES, type DecisionQuestion } from "../src/models/decision.js";
import { LlmClient } from "../src/models/llm.js";
import { makeRoots, mockLlm } from "./helpers.js";

describe("Laya definition-scoped trust (#305)", () => {
  it("does not inherit earned trust when ask text, type, options or levels change under the same ID", () => {
    const cfg = defaultConfig();
    const trust = memoryTrust();
    const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm), undefined, trust);

    const original: DecisionQuestion = {
      name: "custom-check",
      type: "yes_no",
      ask: "Did the tool fail?",
    };

    for (let i = 0; i < TRUST_MIN_SAMPLES; i++) {
      trust.record(original.name, true);
    }

    const editedAsk: DecisionQuestion = {
      ...original,
      ask: "Did the agent fail to obtain approval?",
    };
    const editedType: DecisionQuestion = {
      name: "custom-check",
      type: "choice",
      ask: "Did the tool fail?",
      options: { yes: "failed", no: "succeeded" },
    };

    expect(dm.trusted([original])).toBe(true);
    expect(dm.trusted([editedAsk])).toBe(false);
    expect(dm.trusted([editedType])).toBe(false);
    expect(dm.trusted([{ ...editedAsk, name: "fresh-check" }])).toBe(false);
    // Unchanged definition retains its earned trust.
    expect(dm.trusted([original])).toBe(true);
  });

  it("ignores legacy name-only records persisted without definition signatures", async () => {
    const tb = await makeRoots({ noEngine: true });
    try {
      tb.roots.store.setMeta("laya_trust", JSON.stringify({ "legacy-check": { n: 30, agree: 30 } }));
      const reloadedTrust = tb.roots.store.trustStore();
      const dm = new DecisionModel(
        tb.roots.config.classifier,
        tb.roots.llm,
        undefined,
        reloadedTrust,
      );
      const q: DecisionQuestion = {
        name: "legacy-check",
        type: "yes_no",
        ask: "Did the agent ignore an error?",
      };
      expect(reloadedTrust.get(q)).toEqual({ n: 0, agree: 0 });
      expect(dm.trusted([q])).toBe(false);
    } finally {
      await tb.close();
    }
  });

  it("does not let delayed shadow responses for an old definition credit an edited definition", async () => {
    const llm = await mockLlm({ yesWhen: ["bad"] });
    let releaseDelayedShadow: (() => void) | undefined;
    let blockNextShadow = false;
    const laya = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const b = JSON.parse(body || "{}");
        if (b.state !== "ping" && blockNextShadow) {
          blockNextShadow = false;
          await new Promise<void>((r) => {
            releaseDelayedShadow = r;
          });
        }
        const answers = Object.fromEntries(Object.keys(b.questions ?? {}).map((k) => [k, { type: "noul", noul: 0.9 }]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "typed-decisions", answers }));
      });
    });
    await new Promise<void>((r) => laya.listen(0, "127.0.0.1", () => r()));

    try {
      const cfg = defaultConfig();
      cfg.llm.baseUrl = llm.url;
      cfg.llm.model = "mock-model";
      cfg.classifier.baseUrl = "";
      cfg.classifier.laya.port = (laya.address() as AddressInfo).port;
      const trust = memoryTrust();
      const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm), { laya: async () => "t", jevCloud: async () => undefined }, trust);

      const original: DecisionQuestion = { name: "custom-check", type: "yes_no", ask: "Is this bad tool behavior?" };
      const edited: DecisionQuestion = { name: "custom-check", type: "yes_no", ask: "Is this bad approval handling?" };

      // Warm up Laya availability probe, then hold the shadow call for `original`.
      await dm.laya.available();
      blockNextShadow = true;
      const r1 = await dm.decide("state 1", [original]);
      expect(r1.backend).toBe("llm");

      // While original's shadow request is still in flight, evaluate `edited`.
      const r2 = await dm.decide("state 2", [edited]);
      expect(r2.backend).toBe("llm");
      for (let i = 0; i < 50 && trust.get(edited).n < 1; i++) await new Promise((r) => setTimeout(r, 20));
      expect(trust.get(edited)).toEqual({ n: 1, agree: 1 });

      // Release the delayed shadow response for `original`; it must credit `original`, not `edited`.
      releaseDelayedShadow?.();
      for (let i = 0; i < 50 && trust.get(original).n < 1; i++) await new Promise((r) => setTimeout(r, 20));
      expect(trust.get(original)).toEqual({ n: 1, agree: 1 });
      expect(trust.get(edited)).toEqual({ n: 1, agree: 1 });
    } finally {
      laya.close();
      await llm.close();
    }
  });

  it("returns edited checks to LLM routing, updates /api/status, and persists across store restarts", async () => {
    const llm = await mockLlm({ yesWhen: ["bad"] });
    const laya = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b = JSON.parse(body || "{}");
        const answers = Object.fromEntries(Object.keys(b.questions ?? {}).map((k) => [k, { type: "noul", noul: 0.9 }]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "typed-decisions", answers }));
      });
    });
    await new Promise<void>((r) => laya.listen(0, "127.0.0.1", () => r()));

    const tb = await makeRoots({
      serve: true,
      noEngine: true,
      llmUrl: llm.url,
      config: (c) => {
        c.classifier.backend = "auto";
        c.classifier.baseUrl = "";
        c.classifier.laya.enabled = true;
        c.classifier.laya.port = (laya.address() as AddressInfo).port;
      },
    });
    try {
      const saveOriginal = await fetch(`${tb.url}/api/checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "custom-check",
          kind: "yes_no",
          ask: "Is this bad tool behavior?",
        }),
      });
      expect(saveOriginal.status).toBe(200);

      const originalQ: DecisionQuestion = { name: "custom-check", type: "yes_no", ask: "Is this bad tool behavior?" };
      for (let i = 0; i < TRUST_MIN_SAMPLES; i++) {
        tb.roots.decisions.trust.record(originalQ, true);
      }
      expect((await tb.roots.decisions.decide("state", [originalQ])).backend).toBe("laya");

      let status = await (await fetch(`${tb.url}/api/status`)).json();
      expect(status.classifier.trust.find((t: { question: string }) => t.question === "custom-check")).toEqual({
        question: "custom-check",
        n: TRUST_MIN_SAMPLES,
        agreement: 1,
        trusted: true,
      });

      // Edit the check wording under the same ID via POST /api/checks.
      const saveEdited = await fetch(`${tb.url}/api/checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "custom-check",
          kind: "yes_no",
          ask: "Is this bad approval handling?",
        }),
      });
      expect(saveEdited.status).toBe(200);

      const editedQ: DecisionQuestion = { name: "custom-check", type: "yes_no", ask: "Is this bad approval handling?" };
      expect(tb.roots.decisions.trusted([editedQ])).toBe(false);
      status = await (await fetch(`${tb.url}/api/status`)).json();
      expect(status.classifier.trust.find((t: { question: string }) => t.question === "custom-check")).toEqual({
        question: "custom-check",
        n: 0,
        agreement: null,
        trusted: false,
      });

      expect((await tb.roots.decisions.decide("state", [editedQ])).backend).toBe("llm");

      // Reload trustStore from SQLite to verify restart persistence.
      const reloadedTrust = tb.roots.store.trustStore();
      expect(reloadedTrust.get(originalQ)).toEqual({ n: TRUST_MIN_SAMPLES, agree: TRUST_MIN_SAMPLES });
      expect(reloadedTrust.get(editedQ).n).toBeLessThan(TRUST_MIN_SAMPLES);
      expect(reloadedTrust.all()["custom-check"].n).toBeLessThan(TRUST_MIN_SAMPLES);
    } finally {
      await tb.close();
      laya.close();
      await llm.close();
    }
  });
});
