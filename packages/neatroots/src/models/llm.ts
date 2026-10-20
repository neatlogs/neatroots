import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import type { RootsConfig } from "../config.js";
import { log } from "../util/log.js";
import { BUILTIN_RULES, compileRules, CREDENTIAL_KINDS, RedactionPatternError, redactString, type RedactionRule } from "../relay/redact.js";
import { isLocalUrl, llmKeyName, providerById, strictSchema, type ProviderPreset } from "./providers.js";
import { trimSlash } from "../util/url.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenLogprob {
  token: string;
  logprob: number;
  top_logprobs?: { token: string; logprob: number }[];
}

export interface ChatResult {
  text: string;
  json?: unknown;
  logprobs?: TokenLogprob[];
  model: string;
  latencyMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Where the call ran: "local" or the external provider id. */
  where?: string;
}

export interface ChatOptions {
  schema?: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  temperature?: number;
  logprobs?: boolean;
  topLogprobs?: number;
  timeoutSec?: number;
  signal?: AbortSignal;
  /**
   * urgent: notes for a running agent. interactive: something a person or coding agent is waiting
   * on (drafting a check, a preview, ask, judge, explain). high: background decisions and
   * planning. low: background investigations and summaries.
   */
  priority?: "urgent" | "interactive" | "high" | "low";
  /** Use this model instead of the configured one (replays). */
  model?: string;
}

export interface ProbeResult {
  ok: boolean;
  /** "local" or the external provider id. */
  where?: string;
  model?: string;
  models?: string[];
  error?: string;
}

export class LlmUnavailableError extends Error {}

/** Preferred models per memory tier, best first. Installed models are always preferred over downloads. */
export const TIER_PREFERENCES: Record<string, string[]> = {
  large: ["qwen3:14b", "gemma4", "gemma3:12b", "qwen3:8b", "llama3.1:8b", "mistral-nemo"],
  medium: ["qwen3:8b", "gemma4", "llama3.1:8b", "gemma3:4b", "qwen3:4b", "llama3.2:3b"],
  small: ["qwen3:4b", "llama3.2:3b", "gemma3:4b", "qwen3:1.7b", "gemma3:1b"],
};

export function hardwareTier(totalBytes = os.totalmem()): { tier: "large" | "medium" | "small"; memoryGb: number; description: string } {
  const gb = Math.round(totalBytes / 1024 ** 3);
  if (gb >= 32) return { tier: "large", memoryGb: gb, description: "8–14B instruct model, everything on device" };
  if (gb >= 16) return { tier: "medium", memoryGb: gb, description: "3–8B instruct model; investigations queue while the agent is busy" };
  return { tier: "small", memoryGb: gb, description: "rules and classifier on device; LLM work needs Ollama elsewhere or a cloud key" };
}

/** An LLM task's error for people: when no LLM is reachable, says so and how to set one up. */
export function llmErrorMessage(e: unknown): string {
  if (e instanceof LlmUnavailableError) {
    return "No LLM is reachable. Set one up in Settings → Models, run `neatroots llm use <provider>`, or start a local LLM (Ollama/LM Studio).";
  }
  return (e as Error).message;
}

/** One place chat calls can go: the local server or a hosted provider. */
interface Transport {
  readonly where: string;
  /** How many calls may run at once. Local models run one at a time next to the user's agent. */
  readonly concurrency: number;
  readonly logprobs: boolean;
  model(): string | undefined;
  probe(force: boolean): Promise<ProbeResult>;
  send(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult>;
}

// ---------------------------------------------------------- OpenAI-compatible

interface OpenAiTarget {
  where: string;
  baseUrl: () => string;
  model: () => string;
  apiKey: () => Promise<string | undefined>;
  timeoutSec: () => number;
  local: boolean;
  logprobs: boolean;
  /** OpenAI's own API wants max_completion_tokens. */
  completionTokensParam: boolean;
}

/** Ways to make a request a stricter or older server accepts, tried in order on HTTP 400. */
const DOWNGRADES: { test: RegExp; apply: (b: Record<string, unknown>) => boolean }[] = [
  { test: /reasoning_effort/i, apply: (b) => del(b, "reasoning_effort") },
  { test: /logprob/i, apply: (b) => del(b, "logprobs") && (del(b, "top_logprobs") || true) },
  { test: /temperature/i, apply: (b) => del(b, "temperature") },
  {
    test: /max_tokens|max_completion_tokens/i,
    apply: (b) => {
      if ("max_tokens" in b) {
        b.max_completion_tokens = b.max_tokens;
        delete b.max_tokens;
      } else if ("max_completion_tokens" in b) {
        b.max_tokens = b.max_completion_tokens;
        delete b.max_completion_tokens;
      } else return false;
      return true;
    },
  },
  {
    test: /response_format|json_schema|schema|strict/i,
    apply: (b) => {
      const rf = b.response_format as { type: string; json_schema?: { strict?: boolean } } | undefined;
      if (!rf) return false;
      if (rf.type === "json_schema" && rf.json_schema?.strict) rf.json_schema.strict = false;
      else if (rf.type === "json_schema") b.response_format = { type: "json_object" };
      else delete b.response_format;
      return true;
    },
  },
];

function del(b: Record<string, unknown>, k: string): boolean {
  if (!(k in b)) return false;
  delete b[k];
  return true;
}

/**
 * Any OpenAI-compatible chat server: Ollama, LM Studio, llama.cpp server, an MLX server,
 * or a hosted API (OpenAI, OpenRouter, Gemini, Groq, Mistral, Together, a custom URL).
 */
class OpenAiTransport implements Transport {
  readonly concurrency: number;
  private resolvedModel?: string;
  private lastProbe = 0;
  private lastResult: ProbeResult = { ok: false, error: "not checked yet" };

  constructor(private readonly t: OpenAiTarget) {
    this.concurrency = t.local ? 1 : 4;
  }

  get where(): string {
    return this.t.where;
  }

  get logprobs(): boolean {
    return this.t.logprobs;
  }

  get baseUrl(): string {
    return trimSlash(this.t.baseUrl());
  }

  model(): string | undefined {
    const m = this.t.model();
    return this.resolvedModel ?? (m && m !== "auto" ? m : undefined);
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const key = await this.t.apiKey();
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: await this.headers(), signal: AbortSignal.timeout(this.t.local ? 3000 : 10_000) });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `the provider rejected the key (HTTP ${res.status})` : `models list failed: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id.replace(/^models\//, ""));
  }

  /** Checks the server and resolves "auto" to an installed model. Cached for 30 s locally, 5 min for hosted APIs. */
  async probe(force = false): Promise<ProbeResult> {
    const ttl = this.t.local ? 30_000 : 300_000;
    if (!force && Date.now() - this.lastProbe < ttl) return this.lastResult;
    this.lastProbe = Date.now();
    if (!this.baseUrl) return (this.lastResult = { ok: false, error: "no base URL set" });
    if (!this.t.local && !(await this.t.apiKey())) return (this.lastResult = { ok: false, error: "no API key stored (neatroots llm login)" });
    try {
      const models = (await this.listModels()).filter((m) => !/embed|bge|minilm|nomic|whisper|tts|dall-e|moderation/i.test(m));
      const want = this.t.model();
      if (want && want !== "auto") {
        this.resolvedModel = want;
      } else if (this.t.local) {
        const prefs = TIER_PREFERENCES[hardwareTier().tier];
        this.resolvedModel = prefs.map((p) => models.find((m) => m === p || m.startsWith(p + ":") || m.startsWith(p))).find(Boolean) ?? models[0];
      } else {
        this.resolvedModel = undefined;
        return (this.lastResult = { ok: false, models, error: "pick a model (neatroots llm models lists them)" });
      }
      const ok = !!this.resolvedModel;
      return (this.lastResult = { ok, model: this.resolvedModel, models, error: ok ? undefined : "no chat model installed" });
    } catch (err) {
      return (this.lastResult = { ok: false, error: (err as Error).message });
    }
  }

  async send(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const probe = await this.probe(false);
    const model = opts.model || this.model();
    if (!probe.ok || !model) throw new LlmUnavailableError(probe.error ?? "no LLM available");
    const body: Record<string, unknown> = { model, messages, temperature: opts.temperature ?? 0, stream: false };
    // Hosted reasoning models count thinking against the limit, so give them room.
    const maxTokens = this.t.local ? (opts.maxTokens ?? 512) : Math.max(opts.maxTokens ?? 512, 4096);
    body[this.t.completionTokensParam ? "max_completion_tokens" : "max_tokens"] = maxTokens;
    // Thinking models spend their budget reasoning; neatroots wants the answer.
    if (this.t.local) body.reasoning_effort = "none";
    if (opts.logprobs && this.t.logprobs) {
      body.logprobs = true;
      body.top_logprobs = opts.topLogprobs ?? 10;
    }
    if (opts.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: opts.schema.name, strict: true, schema: this.t.local ? opts.schema.schema : strictSchema(opts.schema.schema, { allRequired: true }) },
      };
    }
    const started = Date.now();
    const timeout = AbortSignal.timeout((opts.timeoutSec ?? this.t.timeoutSec()) * 1000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const headers = await this.headers();
    let res: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
      } catch (err) {
        this.lastProbe = 0;
        throw new LlmUnavailableError(`LLM request failed: ${(err as Error).message}`);
      }
      if (res.ok) break;
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        this.lastProbe = 0;
        throw new LlmUnavailableError(`${this.where} rejected the key (HTTP ${res.status})`);
      }
      if (res.status === 404) throw new LlmUnavailableError(`${this.where}: model ${model} not found (HTTP 404)`);
      if (res.status !== 400 && res.status !== 422) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      // Servers differ in which parameters they take; adjust the one named, else the next in line.
      const fix = DOWNGRADES.find((d) => d.test.test(text) && d.apply(body)) ?? DOWNGRADES.find((d) => d.apply(body));
      if (!fix) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      log.debug(`llm ${this.where}: retrying after HTTP ${res.status}: ${text.slice(0, 120)}`);
    }
    if (!res?.ok) throw new Error("LLM request was rejected after adjusting its parameters");
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; logprobs?: { content?: TokenLogprob[] } }[];
      usage?: ChatResult["usage"];
      model?: string;
    };
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    const result: ChatResult = {
      text,
      logprobs: choice?.logprobs?.content ?? undefined,
      model: data.model ?? model,
      latencyMs: Date.now() - started,
      usage: data.usage,
      where: this.where,
    };
    if (opts.schema) result.json = parseJsonLoose(text);
    return result;
  }
}

// ------------------------------------------------------------------ Anthropic

/** Models that accept server-side refusal fallbacks ("default" routes by refusal category). */
function supportsFallbacks(model: string): boolean {
  return /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(model);
}

/** Claude through the official Anthropic SDK, with structured JSON output. */
class AnthropicTransport implements Transport {
  readonly concurrency = 4;
  readonly logprobs = false;
  private client?: Anthropic;
  private clientKey?: string;
  private lastProbe = 0;
  private lastResult: ProbeResult = { ok: false, error: "not checked yet" };
  /** Request features this model turned down; not sent again. */
  private unsupported = new Set<"fallbacks" | "effort" | "format">();

  constructor(
    readonly where: string,
    private readonly t: { baseUrl: () => string; model: () => string; apiKey: () => Promise<string | undefined>; timeoutSec: () => number },
  ) {}

  model(): string | undefined {
    return this.t.model() || undefined;
  }

  private async sdk(): Promise<Anthropic | undefined> {
    const key = await this.t.apiKey();
    if (!key) return undefined;
    if (!this.client || this.clientKey !== key) {
      this.client = new Anthropic({ apiKey: key, baseURL: this.t.baseUrl() || undefined, maxRetries: 2 });
      this.clientKey = key;
      this.unsupported.clear();
    }
    return this.client;
  }

  async probe(force = false): Promise<ProbeResult> {
    if (!force && Date.now() - this.lastProbe < 300_000) return this.lastResult;
    this.lastProbe = Date.now();
    const model = this.model();
    if (!model) return (this.lastResult = { ok: false, error: "pick a model" });
    const client = await this.sdk();
    if (!client) return (this.lastResult = { ok: false, error: "no API key stored (neatroots llm login anthropic)" });
    if (!force) return (this.lastResult = { ok: true, model });
    try {
      await client.models.retrieve(model, {}, { timeout: 10_000 });
      return (this.lastResult = { ok: true, model });
    } catch (err) {
      return (this.lastResult = { ok: false, model, error: describeAnthropicError(err) });
    }
  }

  async listModels(): Promise<string[]> {
    const client = await this.sdk();
    if (!client) throw new Error("no API key stored (neatroots llm login anthropic)");
    const ids: string[] = [];
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    return ids;
  }

  async send(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const model = opts.model || this.model();
    const client = await this.sdk();
    if (!model || !client) throw new LlmUnavailableError(model ? "no Anthropic API key stored" : "no Claude model set");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const turns: Anthropic.Beta.BetaMessageParam[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    // Short answers (decisions, notes for a running agent) need little thought; the rest gets the default.
    const effort = (opts.maxTokens ?? 512) <= 64 || opts.priority === "urgent" ? "low" : "medium";
    const started = Date.now();
    for (let attempt = 0; attempt < 4; attempt++) {
      const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
      if (!this.unsupported.has("effort")) outputConfig.effort = effort;
      if (opts.schema && !this.unsupported.has("format")) outputConfig.format = { type: "json_schema", schema: strictSchema(opts.schema.schema) };
      const useFallbacks = supportsFallbacks(model) && !this.unsupported.has("fallbacks");
      const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 16000,
        messages: turns,
        ...(system ? { system } : {}),
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      };
      try {
        const msg = await client.beta.messages.create(params, {
          timeout: (opts.timeoutSec ?? this.t.timeoutSec()) * 1000,
          signal: opts.signal,
        });
        if (msg.stop_reason === "refusal") {
          throw new Error(`Claude declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ""}`);
        }
        const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const result: ChatResult = {
          text,
          model: msg.model,
          latencyMs: Date.now() - started,
          usage: { prompt_tokens: msg.usage.input_tokens, completion_tokens: msg.usage.output_tokens },
          where: this.where,
        };
        if (opts.schema) result.json = parseJsonLoose(text);
        return result;
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError) {
          // Older Claude models do not take every option; drop the one named and retry.
          const m = err.message;
          const drop = /fallback/i.test(m) && useFallbacks ? "fallbacks" : /effort/i.test(m) && !this.unsupported.has("effort") ? "effort" : /format|schema|output_config/i.test(m) && opts.schema && !this.unsupported.has("format") ? "format" : undefined;
          if (drop) {
            this.unsupported.add(drop);
            continue;
          }
          throw new Error(`Claude: ${m.slice(0, 300)}`);
        }
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.APIConnectionError) {
          this.lastProbe = 0;
          throw new LlmUnavailableError(describeAnthropicError(err));
        }
        if (err instanceof Anthropic.APIError) throw new Error(describeAnthropicError(err));
        throw err;
      }
    }
    throw new Error("Claude rejected the request after adjusting its options");
  }
}

function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key";
  if (err instanceof Anthropic.PermissionDeniedError) return "this API key may not use that model";
  if (err instanceof Anthropic.NotFoundError) return "model not found";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached; try again shortly";
  if (err instanceof Anthropic.APIConnectionError) return `could not reach Anthropic: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic error ${err.status ?? ""}: ${err.message.slice(0, 200)}`;
  return (err as Error).message;
}

// --------------------------------------------------------------------- client

export interface LlmClientOptions {
  /** Reads a stored secret (the Keychain in the app). */
  secret?: (name: `llm-api-key-${string}`) => Promise<string | undefined>;
  /** Extra redaction patterns for redact: "all" (the cloud forward's patterns). */
  redactPatterns?: () => string[];
}

export interface LlmStatus {
  /** Where calls go now: "local", a provider id, or null when nothing answers. */
  active: string | null;
  local: ProbeResult & { baseUrl: string };
  external: (ProbeResult & { enabled: boolean; provider: string; label: string; hasKey: boolean }) | null;
}

/**
 * neatroots' LLM: the local server by default, or a hosted provider the user turned on. Calls
 * are queued by priority. Local calls run one at a time so the model is never asked to
 * run several prompts next to the user's agent; hosted calls run a few at once.
 */
export class LlmClient {
  readonly local: OpenAiTransport;
  private ext?: { key: string; transport: OpenAiTransport | AnthropicTransport };
  private keyCache?: { provider: string; at: number; key?: string };
  private urgent: (() => Promise<void>)[] = [];
  private interactive: (() => Promise<void>)[] = [];
  private high: (() => Promise<void>)[] = [];
  private low: (() => Promise<void>)[] = [];
  private active = 0;
  private pending = 0;
  private warnedFallback = 0;

  constructor(
    private readonly cfg: RootsConfig["llm"],
    private readonly opts: LlmClientOptions = {},
  ) {
    this.local = new OpenAiTransport({
      where: "local",
      baseUrl: () => cfg.baseUrl,
      model: () => cfg.model,
      apiKey: async () => cfg.apiKey,
      timeoutSec: () => cfg.timeoutSec,
      local: true,
      logprobs: true,
      completionTokensParam: false,
    });
  }

  get baseUrl(): string {
    return this.local.baseUrl;
  }

  get busy(): number {
    return this.pending;
  }

  get externalEnabled(): boolean {
    return !!this.cfg.external?.enabled;
  }

  get preset(): ProviderPreset | undefined {
    return providerById(this.cfg.external?.provider ?? "");
  }

  /** The model calls go to now (best guess without a network check). */
  get model(): string | undefined {
    if (this.externalEnabled && this.keyCache?.key) return this.cfg.external.model || this.preset?.defaultModel || undefined;
    return this.local.model();
  }

  /** Whether the active target reports token logprobs. */
  get logprobs(): boolean {
    // Asking for a stated confidence is harmless when a call falls back to the local model.
    return this.externalEnabled ? !!this.preset?.logprobs && this.preset.api === "openai" : true;
  }

  async externalKey(): Promise<string | undefined> {
    const provider = this.cfg.external?.provider ?? "";
    if (this.keyCache && this.keyCache.provider === provider && Date.now() - this.keyCache.at < 30_000) return this.keyCache.key;
    const key = (await this.opts.secret?.(llmKeyName(provider))) ?? undefined;
    this.keyCache = { provider, at: Date.now(), key };
    return key;
  }

  /** Forgets a cached key, e.g. after login or logout. */
  resetKey(): void {
    this.keyCache = undefined;
    this.ext = undefined;
  }

  /** The hosted provider's transport for the current settings. */
  private external(): OpenAiTransport | AnthropicTransport | undefined {
    const e = this.cfg.external;
    const p = providerById(e.provider);
    if (!p) return undefined;
    const sig = `${p.id}|${e.baseUrl}`;
    if (this.ext?.key === sig) return this.ext.transport;
    const common = {
      baseUrl: () => e.baseUrl || p.baseUrl,
      model: () => e.model || p.defaultModel,
      apiKey: () => this.externalKey(),
      timeoutSec: () => e.timeoutSec || this.cfg.timeoutSec,
    };
    const transport =
      p.api === "anthropic"
        ? new AnthropicTransport(p.id, common)
        : new OpenAiTransport({ ...common, where: p.id, local: false, logprobs: p.logprobs, completionTokensParam: p.id === "openai" });
    this.ext = { key: sig, transport };
    return transport;
  }

  /** Where the next call goes, in order of preference. */
  private async targets(): Promise<Transport[]> {
    if (!this.cfg.enabled) return [];
    const list: Transport[] = [];
    if (this.externalEnabled) {
      const ext = this.external();
      if (ext && (await this.externalKey())) list.push(ext);
      if (!this.cfg.external.fallbackToLocal) return list;
    }
    list.push(this.local);
    return list;
  }

  async listModels(target: "local" | "external" = "local"): Promise<string[]> {
    if (target === "local") return this.local.listModels();
    const ext = this.external();
    if (!ext) throw new Error("unknown provider");
    return ext instanceof AnthropicTransport ? ext.listModels() : ext.listModels();
  }

  /** Checks the target calls would go to. Cached; force checks the network now. */
  async probe(force = false): Promise<ProbeResult> {
    if (!this.cfg.enabled) return { ok: false, error: "LLM disabled in config" };
    let first: ProbeResult | undefined;
    for (const t of await this.targets()) {
      const r = { ...(await t.probe(force)), where: t.where };
      first ??= r;
      if (r.ok) return r;
    }
    if (this.externalEnabled && !(await this.externalKey())) return { ok: false, error: `no API key stored for ${this.preset?.label ?? this.cfg.external.provider}` };
    return first ?? { ok: false, error: "no LLM configured" };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.probe()).ok;
  }

  async status(force = false): Promise<LlmStatus> {
    const local = { ...(await this.local.probe(force)), baseUrl: this.baseUrl };
    let external: LlmStatus["external"] = null;
    const e = this.cfg.external;
    if (e) {
      const p = providerById(e.provider);
      const hasKey = !!(await this.externalKey());
      const ext = this.external();
      const r = e.enabled && ext ? await ext.probe(force) : { ok: false, model: e.model || p?.defaultModel || undefined };
      external = { ...r, model: r.model ?? (e.model || p?.defaultModel || undefined), enabled: e.enabled, provider: e.provider, label: p?.label ?? e.provider, hasKey };
    }
    const active = external?.enabled && external.ok ? e.provider : (!external?.enabled || e.fallbackToLocal) && local.ok ? "local" : null;
    return { active, local, external };
  }

  /**
   * Queues a chat call: urgent first, then interactive, high, low. A call whose signal aborts
   * while it waits leaves the queue without reaching the model.
   */
  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.pending++;
    return new Promise<ChatResult>((resolve, reject) => {
      const queue = opts.priority === "low" ? this.low : opts.priority === "urgent" ? this.urgent : opts.priority === "interactive" ? this.interactive : this.high;
      let started = false;
      const job = async () => {
        started = true;
        try {
          resolve(await this.chatNow(messages, opts));
        } catch (err) {
          reject(err);
        } finally {
          this.pending--;
        }
      };
      opts.signal?.addEventListener(
        "abort",
        () => {
          if (started) return;
          const i = queue.indexOf(job);
          if (i < 0) return;
          queue.splice(i, 1);
          this.pending--;
          reject(new Error("cancelled before the model started on it"));
        },
        { once: true },
      );
      queue.push(job);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    const limit = this.externalEnabled && (await this.externalKey()) ? 4 : 1;
    while (this.active < limit) {
      const job = this.urgent.shift() ?? this.interactive.shift() ?? this.high.shift() ?? this.low.shift();
      if (!job) return;
      this.active++;
      void job().finally(() => {
        this.active--;
        void this.pump();
      });
    }
  }

  private redactFor(target: Transport): (s: string) => string {
    return target === this.local ? (s) => s : this.redactRemote();
  }

  /** What text sent off the machine goes through (llm.external.redact); Jev cloud uses it too. */
  redactRemote(): (s: string) => string {
    const mode = this.cfg.external.redact;
    if (mode === "off") return (s) => s;
    const rules: RedactionRule[] =
      mode === "all" ? compileRules(this.opts.redactPatterns?.() ?? []) : BUILTIN_RULES.filter((r) => CREDENTIAL_KINDS.includes(r.kind));
    return (s) => redactString(s, rules, "llm", []);
  }

  private async chatNow(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const targets = await this.targets();
    if (!targets.length) {
      throw new LlmUnavailableError(this.externalEnabled ? `no API key stored for ${this.preset?.label ?? this.cfg.external.provider}` : "LLM disabled in config");
    }
    let lastErr: unknown;
    for (const t of targets) {
      try {
        const redact = this.redactFor(t);
        const r = await t.send(
          messages.map((m) => ({ ...m, content: redact(m.content) })),
          opts,
        );
        log.debug(`llm ${r.where} ${r.model} ${r.latencyMs}ms ${r.text.slice(0, 80).replace(/\n/g, " ")}`);
        return r;
      } catch (err) {
        lastErr = err;
        // A saved redaction pattern that can't be applied means this text can't go to the hosted
        // LLM (nothing is sent); the local LLM, which gets unredacted text, can still answer.
        if (!(err instanceof LlmUnavailableError || err instanceof RedactionPatternError)) throw err;
        if (t !== this.local && targets.length > 1 && Date.now() - this.warnedFallback > 60_000) {
          this.warnedFallback = Date.now();
          log.warn(`${t.where} unavailable (${err.message}); using the local LLM`);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new LlmUnavailableError("no LLM available");
  }
}

/** Parses model JSON, tolerating code fences and leading prose. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[{[]/);
    if (start === -1) return undefined;
    for (let end = t.length; end > start; end--) {
      try {
        return JSON.parse(t.slice(start, end));
      } catch {
        /* keep shrinking */
      }
    }
    return undefined;
  }
}

export { isLocalUrl };
