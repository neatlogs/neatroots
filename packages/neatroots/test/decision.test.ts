import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { distributionFromLogprobs, JevBackend, parseJevAnswer } from "../src/models/decision.js";
import { parseJsonLoose } from "../src/models/llm.js";

describe("decision model", () => {
  it("turns answer-token logprobs into a distribution", () => {
    const tokens = [
      { token: '{"', logprob: -0.1 },
      { token: "answer", logprob: -0.1 },
      { token: ' "', logprob: -0.1 },
      { token: "yes", logprob: -0.47, top_logprobs: [{ token: "yes", logprob: -0.47 }, { token: "Yes", logprob: -1.01 }, { token: "true", logprob: -5.38 }, { token: "No", logprob: -6.85 }] },
    ];
    const d = distributionFromLogprobs(["yes", "no"], tokens, "yes")!;
    const p = d.yes / (d.yes + d.no);
    expect(p).toBeGreaterThan(0.99);
    expect(distributionFromLogprobs(["success", "empty", "error"], [{ token: "error", logprob: -0.1, top_logprobs: [{ token: "error", logprob: -0.1 }, { token: "empty", logprob: -2.5 }] }], "error")!.error).toBeGreaterThan(0.8);
  });

  it("parses Jev-style answers for every question type", () => {
    expect(parseJevAnswer({ name: "q", type: "yes_no", ask: "?" }, { type: "noul", noul: 0.97 }).probability).toBeCloseTo(0.97);
    const c = parseJevAnswer({ name: "c", type: "choice", ask: "?", options: { a: "", b: "" } }, { choice: "b", confidence: 0.8 });
    expect(c.choice).toBe("b");
    expect(c.distribution.b).toBeCloseTo(0.8);
    const sc = parseJevAnswer({ name: "s", type: "score", ask: "?", levels: ["0", "1", "2"] }, { score: 1.5 });
    expect(sc.score).toBeCloseTo(1.5);
  });

  it("talks to a Jev-compatible server over POST /v1/systemone", async () => {
    let seen: any;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
        const answers: Record<string, unknown> = {};
        for (const [name, q] of Object.entries<any>(seen.body.questions)) answers[name] = q.type === "noul" ? { type: "noul", noul: 0.9 } : q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.7 } : { type: "score", score: 2 };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "laya-test", answers }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const jev = new JevBackend({ name: "laya", baseUrl: () => base, model: () => "typed-decisions", apiKey: async () => "k", timeoutSec: 5, probe: true });
    expect(await jev.available()).toBe(true);
    const r = await jev.decide("state text", [
      { name: "yn", type: "yes_no", ask: "Bad?" },
      { name: "ch", type: "choice", ask: "Which?", options: { x: "x desc", y: "y desc" } },
      { name: "sc", type: "score", ask: "How bad?", levels: ["none", "low", "high"] },
    ]);
    expect(seen.url).toBe("/v1/systemone");
    expect(seen.auth).toBe("Bearer k");
    expect(seen.body.questions.yn).toEqual({ type: "noul", instructions: "Bad?" });
    expect(seen.body.questions.sc.criteria).toEqual(["none", "low", "high"]);
    expect(r.model).toBe("laya-test");
    expect(r.backend).toBe("laya");
    expect(seen.body.model).toBe("typed-decisions");
    expect(r.answers.yn.probability).toBeCloseTo(0.9);
    expect(r.answers.ch.choice).toBe("x");
    expect(r.answers.sc.score).toBe(2);
    server.close();
  });

  it("parses model JSON loosely", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Sure! {"a": [1,2]} trailing')).toEqual({ a: [1, 2] });
    expect(parseJsonLoose("nope")).toBeUndefined();
  });
});

describe("decision routing", () => {
  async function jevServer(name: string, seen: string[]) {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push(`${name}:${req.headers.authorization ?? ""}`);
        const b = JSON.parse(body || "{}");
        const answers = Object.fromEntries(Object.keys(b.questions ?? {}).map((k) => [k, { type: "noul", noul: 0.7 }]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: `${name}-model`, answers }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, port: (server.address() as AddressInfo).port };
  }

  it("prefers Laya, uses Jev cloud only when switched on, and never sends to the cloud otherwise", async () => {
    const { defaultConfig } = await import("../src/config.js");
    const { LlmClient } = await import("../src/models/llm.js");
    const { DecisionModel } = await import("../src/models/decision.js");
    const seen: string[] = [];
    const laya = await jevServer("laya", seen);
    const cloud = await jevServer("cloud", seen);
    const cfg = defaultConfig();
    cfg.llm.enabled = false;
    cfg.classifier.laya.port = laya.port;
    cfg.classifier.baseUrl = "";
    cfg.classifier.jevCloud.baseUrl = `http://127.0.0.1:${cloud.port}`;
    const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm), { laya: async () => "laya-token", jevCloud: async () => "cloud-key" });
    const q = [{ name: "q", type: "yes_no" as const, ask: "Bad?" }];
    expect((await dm.decide("s1", q)).backend).toBe("laya");
    expect(seen.at(-1)).toBe("laya:Bearer laya-token");
    // Laya down, cloud off: nothing goes to the cloud.
    laya.server.close();
    dm.reset();
    await expect(dm.decide("s2", q)).rejects.toThrow();
    expect(seen.some((s) => s.startsWith("cloud"))).toBe(false);
    // Cloud switched on: it answers.
    cfg.classifier.jevCloud.enabled = true;
    dm.reset();
    const r = await dm.decide("s3", q);
    expect(r.backend).toBe("jev-cloud");
    expect(seen.at(-1)).toBe("cloud:Bearer cloud-key");
    cloud.server.close();
  });
});

describe("Laya trust", () => {
  it("shadows the LLM, records agreement, and promotes a question to Laya once trusted", async () => {
    const { defaultConfig } = await import("../src/config.js");
    const { LlmClient } = await import("../src/models/llm.js");
    const { DecisionModel, memoryTrust, TRUST_MIN_SAMPLES } = await import("../src/models/decision.js");
    const { mockLlm } = await import("./helpers.js");
    const llm = await mockLlm({ yesWhen: ["bad"] });
    let layaCalls = 0;
    const laya = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        layaCalls++;
        const b = JSON.parse(body || "{}");
        const answers = Object.fromEntries(Object.keys(b.questions ?? {}).map((k) => [k, { type: "noul", noul: 0.9 }]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "typed-decisions", answers }));
      });
    });
    await new Promise<void>((r) => laya.listen(0, "127.0.0.1", () => r()));
    const cfg = defaultConfig();
    cfg.llm.baseUrl = llm.url;
    cfg.llm.model = "mock-model";
    cfg.classifier.baseUrl = "";
    cfg.classifier.laya.port = (laya.address() as AddressInfo).port;
    const trust = memoryTrust();
    const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm), { laya: async () => "t", jevCloud: async () => undefined }, trust);
    const q = [{ name: "bad-check", type: "yes_no" as const, ask: "Is this bad?" }];
    const first = await dm.decide("state one", q);
    expect(first.backend).toBe("llm");
    for (let i = 0; i < 50 && trust.get("bad-check").n < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(trust.get("bad-check")).toEqual({ n: 1, agree: 1 });
    for (let i = 1; i < TRUST_MIN_SAMPLES; i++) trust.record("bad-check", true);
    expect(dm.trusted(q)).toBe(true);
    const before = layaCalls;
    const promoted = await dm.decide("state two", q);
    expect(promoted.backend).toBe("laya");
    expect(layaCalls).toBe(before + 1);
    // An untrusted question still goes to the LLM.
    expect((await dm.decide("state three", [{ name: "other", type: "yes_no", ask: "Is this bad?" }])).backend).toBe("llm");
    laya.close();
    await llm.close();
  });
});

describe("decision requests that leave the machine", () => {
  const secrets = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123 and Authorization: Basic dXNlcjpodW50ZXIy";

  async function recorder() {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        bodies.push(body);
        const b = JSON.parse(body || "{}");
        const answers = Object.fromEntries(Object.keys(b.questions ?? {}).map((k) => [k, { type: "noul", noul: 0.2 }]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "m", answers }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { bodies, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  async function decideVia(baseUrl: (local: string) => string, redact?: "secrets" | "all" | "off") {
    const { vi } = await import("vitest");
    const { defaultConfig } = await import("../src/config.js");
    const { LlmClient } = await import("../src/models/llm.js");
    const { DecisionModel } = await import("../src/models/decision.js");
    const rec = await recorder();
    // A remote host can't be reached from a test, so its requests are delivered to the local recorder.
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const u = new URL(String(input));
      return realFetch(u.hostname === "jev.example.com" ? `${rec.url}${u.pathname}` : input, init);
    });
    try {
      const cfg = defaultConfig();
      cfg.llm.enabled = false;
      if (redact) cfg.llm.external.redact = redact;
      cfg.classifier.laya.port = 1;
      cfg.classifier.baseUrl = "";
      cfg.classifier.backend = "jev-cloud";
      cfg.classifier.jevCloud.enabled = true;
      cfg.classifier.jevCloud.baseUrl = baseUrl(rec.url);
      const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm), { laya: async () => undefined, jevCloud: async () => "cloud-key" });
      const r = await dm.decide(`tool read_env returned: ${secrets}`, [{ name: "q", type: "yes_no", ask: `Did it leak sk-ant-abcdefghijklmnopqrstuvwxyz0123?` }]);
      expect(r.backend).toBe("jev-cloud");
      expect(rec.bodies).toHaveLength(1);
      return rec.bodies[0];
    } finally {
      spy.mockRestore();
      rec.close();
    }
  }

  it("removes credentials from what Jev cloud receives", async () => {
    const body = await decideVia(() => "https://jev.example.com");
    expect(body).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123");
    expect(body).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    expect(body).not.toContain("dXNlcjpodW50ZXIy");
    expect(body).toContain("[redacted:api_key]");
    expect(body).toContain("[redacted:basic_auth]");
  });

  it("sends the original text to a server on this machine, and when redaction is off", async () => {
    expect(await decideVia((local) => local)).toContain(secrets);
    expect(await decideVia(() => "https://jev.example.com", "off")).toContain(secrets);
  });
});
