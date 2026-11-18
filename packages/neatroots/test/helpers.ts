import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ServerType } from "@hono/node-server";
import { Roots } from "../src/core.js";
import { defaultConfig, type RootsConfig } from "../src/config.js";
import { createApp, startServer } from "../src/server/app.js";
import type { KeyValue, OtlpSpan, ResourceSpansBatch } from "../src/otlp/types.js";
import { Store } from "../src/store/db.js";
import { setQuiet } from "../src/util/log.js";

setQuiet(true);

// Code that reads the config home directly (CLI helpers, rootsHome()) must never see the
// developer's real ~/.neatroots while tests run.
if (!process.env.NEATROOTS_HOME?.includes("neatroots-test-")) process.env.NEATROOTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-home-"));

export function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-"));
}

const trackedStores = new Set<Store>();

export function trackedStore(dir: string): Store {
  const store = new Store(dir);
  trackedStores.add(store);
  return store;
}

export function closeTrackedStores(): void {
  for (const store of trackedStores) if (store.db.open) store.close();
  trackedStores.clear();
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface TestRoots {
  roots: Roots;
  url: string;
  server?: ServerType;
  close: () => Promise<void>;
}

export async function makeRoots(opts: { llmUrl?: string; serve?: boolean; noEngine?: boolean; config?: (c: RootsConfig) => void } = {}): Promise<TestRoots> {
  const home = tmpHome();
  const cfg = defaultConfig();
  cfg.port = await freePort();
  cfg.llm.baseUrl = opts.llmUrl ?? "http://127.0.0.1:9/v1";
  cfg.llm.model = opts.llmUrl ? "mock-model" : "auto";
  cfg.llm.enabled = !!opts.llmUrl;
  cfg.classifier.backend = "llm";
  cfg.classifier.baseUrl = "http://127.0.0.1:9";
  cfg.classifier.laya.enabled = false;
  opts.config?.(cfg);
  const roots = new Roots({ home, config: cfg, noEngine: opts.noEngine });
  let server: ServerType | undefined;
  if (opts.serve) server = await startServer(roots, createApp(roots));
  return {
    roots,
    url: `http://127.0.0.1:${cfg.port}`,
    server,
    close: async () => {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      roots.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export const hex = (n: number) => crypto.randomBytes(n).toString("hex");

export function s(key: string, value: string | number | boolean): KeyValue {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
}

let clock = BigInt(Date.now()) * 1_000_000n;

export function span(p: { traceId: string; spanId?: string; parent?: string; name: string; kind: string; attrs?: KeyValue[]; status?: number; message?: string; durMs?: number; events?: OtlpSpan["events"]; flags?: number }): OtlpSpan {
  const start = clock;
  const end = start + BigInt(Math.round((p.durMs ?? 5) * 1_000_000));
  clock = end + 1_000_000n;
  return {
    traceId: p.traceId,
    spanId: p.spanId ?? hex(8),
    parentSpanId: p.parent ?? "",
    name: p.name,
    kind: 1,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    attributes: [s("neatlogs.span.kind", p.kind.toLowerCase()), ...(p.attrs ?? [])],
    events: p.events ?? [],
    links: [],
    status: { code: p.status ?? 1, ...(p.message ? { message: p.message } : {}) },
    ...(p.flags !== undefined ? { flags: p.flags } : {}),
  };
}

export function batch(spans: OtlpSpan[], service = "test-agent", scope = "neatlogs.test"): ResourceSpansBatch {
  return {
    resource: { attributes: [s("service.name", service), s("neatlogs.workflow_name", service), s("telemetry.sdk.language", "python")] },
    scope: { name: scope, attributes: [] },
    spans,
  };
}

export function llmSpan(traceId: string, parent: string, opts: { system?: string; user: string; out?: string; toolCalls?: { name: string; args: string }[]; tools?: string[] }): OtlpSpan {
  const attrs: KeyValue[] = [s("neatlogs.llm.model_name", "mock"), s("neatlogs.llm.token_count.prompt", "10"), s("neatlogs.llm.token_count.completion", "5"), s("neatlogs.llm.token_count.total", "15")];
  let i = 0;
  if (opts.system) {
    attrs.push(s(`neatlogs.llm.input_messages.${i}.role`, "system"), s(`neatlogs.llm.input_messages.${i}.content`, opts.system));
    i++;
  }
  attrs.push(s(`neatlogs.llm.input_messages.${i}.role`, "user"), s(`neatlogs.llm.input_messages.${i}.content`, opts.user));
  if (opts.out !== undefined) attrs.push(s("neatlogs.llm.output_messages.0.role", "assistant"), s("neatlogs.llm.output_messages.0.content", opts.out));
  (opts.toolCalls ?? []).forEach((c, j) => attrs.push(s(`neatlogs.llm.tool_calls.${j}.name`, c.name), s(`neatlogs.llm.tool_calls.${j}.arguments`, c.args)));
  (opts.tools ?? []).forEach((t, j) => attrs.push(s(`neatlogs.llm.tools.${j}.name`, t)));
  return span({ traceId, parent, name: "openai.chat.completions.create", kind: "llm", attrs });
}

export function toolSpan(traceId: string, parent: string, name: string, input: string, output?: string, error?: string): OtlpSpan {
  const attrs: KeyValue[] = [s("neatlogs.tool.name", name), s("neatlogs.tool.input", input)];
  if (output !== undefined) attrs.push(s("neatlogs.tool.output", output));
  return span({ traceId, parent, name, kind: "tool", attrs, status: error ? 2 : 1, message: error });
}

export function markerSpan(traceId: string, root: string): OtlpSpan {
  return {
    ...span({ traceId, parent: root, name: "neatlogs.trace.complete", kind: "Neatlogs.INTERNAL", attrs: [s("neatlogs.trace.complete", true), s("neatlogs.internal", true)], status: 0 }),
  };
}

/**
 * A scripted OpenAI-compatible chat server for neatroots' own LLM. Answers typed questions
 * "yes" when the question contains one of `yesWhen`, else "no", with logprobs.
 */
export async function mockLlm(
  opts: { yesWhen?: string[]; delayMs?: number; rejectWhen?: string[]; plan?: { id: string; params?: Record<string, string> }[] } = {},
): Promise<{ url: string; requests: any[]; close: () => Promise<void> }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
        return;
      }
      const b = JSON.parse(body || "{}");
      requests.push(b);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const schema = b.response_format?.json_schema?.name;
      const user = String(b.messages?.[b.messages.length - 1]?.content ?? "");
      let content = "{}";
      let logprobs: any;
      const isDecision = schema === "answer" && !!b.response_format?.json_schema?.schema?.properties?.answer?.enum;
      if (schema === "answer" && !isDecision) {
        content = JSON.stringify({ answer: "The lookup_order tool returned 404 for order 4512.", evidence: [] });
      } else if (isDecision) {
        const q = (user.match(/Question: (.*)/)?.[1] ?? "").toLowerCase();
        const enumVals: string[] = b.response_format.json_schema.schema.properties.answer.enum;
        let ans: string;
        if (enumVals.includes("yes")) ans = (opts.yesWhen ?? []).some((w) => q.includes(w.toLowerCase())) ? "yes" : "no";
        else if (enumVals.includes("error")) ans = "error";
        else ans = enumVals[Math.min(3, enumVals.length - 1)];
        content = JSON.stringify({ answer: ans });
        const other = enumVals.find((v) => v !== ans) ?? ans;
        logprobs = {
          content: [
            { token: '{"', logprob: -0.01, top_logprobs: [{ token: '{"', logprob: -0.01 }] },
            { token: "answer", logprob: -0.01, top_logprobs: [{ token: "answer", logprob: -0.01 }] },
            { token: '":"', logprob: -0.01, top_logprobs: [{ token: '":"', logprob: -0.01 }] },
            { token: ans, logprob: -0.05, top_logprobs: [{ token: ans, logprob: -0.05 }, { token: other, logprob: -3.2 }] },
            { token: '"}', logprob: -0.01, top_logprobs: [{ token: '"}', logprob: -0.01 }] },
          ],
        };
      } else if (schema === "verification") {
        // The second look: turned down when asked about a problem in rejectWhen, otherwise
        // confirmed with a quote that really is in the evidence.
        const problem = (user.match(/Possible problem: (.*)/)?.[1] ?? "").toLowerCase();
        const rejected = (opts.rejectWhen ?? []).some((w) => problem.includes(w.toLowerCase()));
        const ev = user.split("<run>\n")[1] ?? "";
        content = JSON.stringify({ quote: rejected ? "" : ev.slice(0, 40), shows_problem: !rejected });
      } else if (schema === "plan") {
        const checks = opts.plan ?? [{ id: "ignored-tool-error" }, { id: "unfinished-task" }, { id: "repeat-without-progress" }];
        content = JSON.stringify({ rationale: "mock plan", checks, new_questions: [] });
      } else if (schema === "note") {
        content = JSON.stringify({ note: "Stop retrying lookup_order with the same id and tell the user the order was not found." });
      } else if (schema === "summary") {
        content = JSON.stringify({ lines: ["Asked to refund an order.", "Looked it up three times.", "Ended without a refund."] });
      } else if (schema === "investigation") {
        content = JSON.stringify({ cause: "The order id does not exist, and the agent kept retrying it.", evidence: [], fix: "Validate the order id and stop after one 404." });
      } else if (schema === "check") {
        content = JSON.stringify({ id: "refund-without-ownership", title: "Refund without ownership check", ask: "Did the agent issue a refund without confirming the customer owns the order?", scope: "trace", span_type: "any", guidance: "Confirm ownership before refunding." });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", model: "mock-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop", logprobs }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

export async function until<T>(fn: () => T | undefined | false | null, timeoutMs = 8000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Like until, for conditions that need an await (an HTTP read, say). */
export async function poll<T>(fn: () => Promise<T | undefined | false | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}
