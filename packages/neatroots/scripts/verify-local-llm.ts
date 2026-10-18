/** Opt-in observations of an explicitly selected local server; never starts one. */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config.js";
import { LlmClient } from "../src/models/llm.js";

export interface VerificationOptions {
  endpoint: string;
  model: string;
  runtime: string;
  timeoutMs?: number;
}

export function localEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw new Error("Use an HTTP loopback endpoint ending in /v1, without credentials, query or fragment.");
  }
  // Avoid resolving a user-controlled hostname when forwarding the observations.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  url.pathname = "/v1";
  return url;
}

interface Observation {
  phase: string;
  method: string;
  path: string;
  status: number;
  parameters?: Record<string, unknown>;
}

function validToken(value: unknown): value is { token: string; logprob: number; top_logprobs?: unknown } {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return typeof t.token === "string" && typeof t.logprob === "number" && Number.isFinite(t.logprob) && t.logprob <= 0;
}

async function boundedBody(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error("Response or request exceeded the observation limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function verifyLocalLlm(options: VerificationOptions) {
  const endpoint = localEndpoint(options.endpoint);
  if (!options.model.trim() || options.model === "auto" || !options.runtime.trim()) {
    throw new Error("Supply a named --model and --runtime (version/image and model revision); auto is tested separately.");
  }
  const timeoutMs = options.timeoutMs ?? 45_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("timeoutMs must be 100..60000");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const requests: Observation[] = [];
  let phase = "models";
  let count = 0;
  const recorder = http.createServer(async (req, res) => {
    const observation: Observation = { phase, method: req.method ?? "", path: req.url ?? "", status: 502 };
    requests.push(observation);
    try {
      if (++count > 32 || abort.signal.aborted) throw new Error("Observation budget exhausted");
      const allowed = (req.method === "GET" && req.url === "/v1/models")
        || (req.method === "POST" && req.url === "/v1/chat/completions");
      if (!allowed) throw new Error("Unexpected observation route");
      const body = req.method === "POST" ? await boundedBody(req, 16_384) : undefined;
      if (body) {
        const parsed = JSON.parse(body.toString());
        // Record only transport parameters. Prompts are fixed below; never record headers.
        observation.parameters = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "messages"));
      }
      const upstream = await fetch(`${endpoint.origin}${req.url}`, {
        method: req.method, body: body?.toString("utf8"), headers: { "content-type": "application/json" },
        signal: abort.signal, redirect: "error",
      });
      const data = upstream.body ? await boundedBody(upstream.body, 1_048_576) : Buffer.alloc(0);
      observation.status = upstream.status;
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(data);
    } catch {
      // Do not leak upstream errors, credentials or arbitrary server text into reports.
      observation.status = 502;
      res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":{"message":"Local observation could not complete"}}');
    }
  });
  const checks: Record<string, { passed: boolean; detail?: unknown }> = {};
  try {
    await new Promise<void>((resolve, reject) => {
      recorder.once("error", reject);
      recorder.listen(0, "127.0.0.1", resolve);
    });
    const address = recorder.address() as { port: number };
    const cfg = defaultConfig().llm;
    cfg.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    cfg.model = "auto";
    cfg.timeoutSec = Math.min(10, timeoutMs / 1000);
    cfg.external.enabled = false;
    const auto = new LlmClient(cfg);
    const probe = await auto.probe(true);
    checks.models = { passed: probe.ok && !!probe.models?.includes(options.model), detail: { ids: probe.models, declaredModelListed: !!probe.models?.includes(options.model) } };
    checks.auto = { passed: probe.ok && !!probe.model && !!probe.models?.includes(probe.model), detail: { resolvedModel: probe.model } };
    if (checks.models.passed && checks.auto.passed) {
      const client = new LlmClient({ ...cfg, model: options.model });
      // Warm the availability probe before the measured chat steps.
      await client.probe(true);
      for (const name of ["chat", "jsonSchema", "logprobs"] as const) {
        phase = name;
        try {
          const result = await client.chat([{ role: "user", content: name === "jsonSchema"
            ? 'Return only a JSON object with the single field "answer" set to "yes".' : "Reply with the single word yes." }], {
            maxTokens: 64, temperature: 0, signal: abort.signal,
            ...(name === "jsonSchema" ? { schema: { name: "local_probe", schema: {
              type: "object", properties: { answer: { type: "string", enum: ["yes"] } }, required: ["answer"], additionalProperties: false,
            } } } : {}),
            ...(name === "logprobs" ? { logprobs: true, topLogprobs: 5 } : {}),
          });
          const validLogs = Array.isArray(result.logprobs) && result.logprobs.length > 0 && result.logprobs.every(t => validToken(t)
            && Array.isArray(t.top_logprobs) && t.top_logprobs.length > 0 && t.top_logprobs.every(validToken));
          const json = result.json as Record<string, unknown> | undefined;
          const passed = result.model === options.model && (name === "chat" ? !!result.text.trim()
            : name === "jsonSchema" ? !!json && !Array.isArray(json) && json.answer === "yes" && Object.keys(json).length === 1 : validLogs);
          checks[name] = { passed, detail: { model: result.model, textPresent: !!result.text.trim(), validLogprobs: validLogs } };
        } catch { checks[name] = { passed: false, detail: "Local request failed or exceeded the observation budget" }; }
      }
    }
    return {
      kind: "local-endpoint-observation", runtimeDeclared: options.runtime, modelDeclared: options.model,
      endpoint: endpoint.href, observedAt: new Date().toISOString(),
      passed: ["models", "auto", "chat", "jsonSchema", "logprobs"].every(k => checks[k]?.passed),
      checks, requests,
      limitations: "Runtime/version labels are operator supplied. This does not verify installation identity, decision-model compatibility or calibration accuracy.",
    };
  } finally {
    clearTimeout(timer);
    abort.abort();
    recorder.closeAllConnections();
    await new Promise<void>(resolve => recorder.close(() => resolve()));
  }
}

const usage = "Usage: pnpm --filter @neatlogs/neatroots exec tsx scripts/verify-local-llm.ts --endpoint http://localhost:8000/v1 --model MODEL --runtime VERSION-AND-MODEL-REVISION";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(usage);
  else {
    try {
      const values: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!["--endpoint", "--model", "--runtime"].includes(args[i]) || !args[i + 1] || values[args[i]]) throw new Error(usage);
        values[args[i]] = args[i + 1];
      }
      if (!values["--endpoint"] || !values["--model"] || !values["--runtime"]) throw new Error(usage);
      const report = await verifyLocalLlm({ endpoint: values["--endpoint"], model: values["--model"], runtime: values["--runtime"] });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.passed ? 0 : 1;
    } catch { console.error(`${usage}\nSupply an explicit loopback /v1 endpoint, named model and runtime label; no server is started or discovered.`); process.exitCode = 2; }
  }
}
