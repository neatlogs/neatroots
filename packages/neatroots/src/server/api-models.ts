import type { Hono } from "hono";
import { err, body } from "./util.js";
import type { Roots } from "../core.js";
import type { RootsConfig } from "../config.js";
import { getSecret, setSecret, deleteSecret, secretEnvSource } from "../relay/keychain.js";
import { LlmUnavailableError } from "../models/llm.js";
import { PROVIDERS, llmKeyName, providerById } from "../models/providers.js";

const REDACT = ["secrets", "all", "off"] as const;

export interface ExternalLlmInput {
  enabled?: boolean;
  provider?: string;
  model?: string;
  base_url?: string;
  redact?: string;
  fallback_to_local?: boolean;
}

/** Applies a change to llm.external, returning an error message when it is invalid. */
export function applyExternalLlm(cfg: RootsConfig["llm"]["external"], b: ExternalLlmInput): string | undefined {
  const next = { ...cfg };
  if (b.model !== undefined && typeof b.model !== "string") return "model must be a string";
  if (b.base_url !== undefined && typeof b.base_url !== "string") return "base_url must be a string";
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return "enabled must be a boolean";
  if (b.fallback_to_local !== undefined && typeof b.fallback_to_local !== "boolean") return "fallback_to_local must be a boolean";
  if (b.provider !== undefined) {
    const p = providerById(b.provider);
    if (!p) return `provider must be one of ${PROVIDERS.map((x) => x.id).join(", ")}`;
    if (b.provider !== next.provider) {
      next.provider = b.provider;
      next.model = p.defaultModel;
      next.baseUrl = "";
    }
  }
  if (b.model !== undefined) next.model = b.model.trim();
  if (b.base_url !== undefined) {
    const u = b.base_url.trim();
    if (u && !/^https?:\/\//.test(u)) return "base URL must start with http:// or https://";
    next.baseUrl = u;
  }
  if (b.redact !== undefined) {
    if (!(REDACT as readonly string[]).includes(b.redact)) return "redact must be secrets, all or off";
    next.redact = b.redact as (typeof REDACT)[number];
  }
  if (b.fallback_to_local !== undefined) next.fallbackToLocal = !!b.fallback_to_local;
  if (b.enabled !== undefined) next.enabled = !!b.enabled;
  const p = providerById(next.provider);
  if (next.enabled && !(next.baseUrl || p?.baseUrl)) return "this provider needs a base URL";
  if (next.enabled && !(next.model || p?.defaultModel)) return "pick a model first";
  Object.assign(cfg, next);
  return undefined;
}

/** Routes for the LLM and the decision models: status, keys, provider choice, tests. */
export function mountModelsApi(app: Hono, roots: Roots): void {
  app.get("/api/llm", async (c) => {
    const force = c.req.query("check") === "1";
    const status = await roots.llm.status(force);
    const keys = await Promise.all(
      PROVIDERS.map(async (p) => {
        const name = llmKeyName(p.id);
        const env = secretEnvSource(name);
        return [p.id, env ? `env:${env}` : (await getSecret(name)) ? "stored" : null] as const;
      }),
    );
    return c.json({
      ...status,
      config: roots.config.llm.external,
      providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, api: p.api, base_url: p.baseUrl, default_model: p.defaultModel, suggested: p.suggested, key_url: p.keyUrl, key: Object.fromEntries(keys)[p.id] })),
    });
  });

  app.post("/api/llm/external", async (c) => {
    const b = await body<ExternalLlmInput>(c);
    const error = applyExternalLlm(roots.config.llm.external, b);
    if (error) return err(c, 400, error);
    roots.saveConfig();
    roots.llm.resetKey();
    roots.decisions.reset();
    roots.bus.emit("settings", {});
    return c.json({ ok: true, status: await roots.llm.status(!!roots.config.llm.external.enabled) });
  });

  app.post("/api/llm/key", async (c) => {
    const b = await body<{ provider?: string; key?: string }>(c);
    const p = providerById(b.provider ?? "");
    if (!p) return err(c, 400, "unknown provider");
    if (!b.key || b.key.trim().length < 8) return err(c, 400, `paste the ${p.label} API key`);
    const where = await setSecret(llmKeyName(p.id), b.key.trim());
    roots.llm.resetKey();
    roots.decisions.reset();
    return c.json({ ok: true, stored_in: where });
  });

  app.delete("/api/llm/key", async (c) => {
    const p = providerById(c.req.query("provider") ?? "");
    if (!p) return err(c, 400, "unknown provider");
    await deleteSecret(llmKeyName(p.id));
    roots.llm.resetKey();
    roots.decisions.reset();
    return c.json({ ok: true });
  });

  app.get("/api/llm/models", async (c) => {
    const target = c.req.query("target") === "external" ? "external" : "local";
    try {
      return c.json({ models: (await roots.llm.listModels(target)).sort() });
    } catch (e) {
      return err(c, 502, (e as Error).message);
    }
  });

  app.post("/api/llm/test", async (c) => {
    try {
      const r = await roots.llm.chat(
        [
          { role: "system", content: "Reply with JSON only." },
          { role: "user", content: 'Reply with {"ok": true}.' },
        ],
        { schema: { name: "ping", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }, maxTokens: 32, priority: "urgent", timeoutSec: 60 },
      );
      return c.json({ ok: (r.json as { ok?: boolean } | undefined)?.ok === true, where: r.where, model: r.model, latency_ms: r.latencyMs });
    } catch (e) {
      return err(c, e instanceof LlmUnavailableError ? 503 : 502, (e as Error).message);
    }
  });

  // ------------------------------------------------------ decision models

  app.post("/api/classifier/laya", async (c) => {
    const b = await body<{ action?: string }>(c);
    if (b.action === "install") {
      roots.config.classifier.laya.enabled = true;
      roots.config.classifier.laya.consent = "yes";
      roots.saveConfig();
      void roots.laya.ensure({ install: true }).then(() => roots.decisions.reset());
    } else if (b.action === "skip") {
      // Not downloading Laya: Jev cloud (or the LLM, until then) answers checks.
      roots.config.classifier.laya.consent = "no";
      roots.saveConfig();
      void roots.laya.ensure();
    } else if (b.action === "restart") {
      void roots.laya.restart().then(() => roots.decisions.reset());
    } else if (b.action === "stop") {
      roots.laya.stop();
      roots.decisions.reset();
    } else return err(c, 400, "action must be install, skip, restart or stop");
    return c.json({ ok: true, laya: roots.laya.state });
  });

  app.post("/api/classifier/jev-key", async (c) => {
    const b = await body<{ key?: string }>(c);
    if (!b.key || b.key.length < 8) return err(c, 400, "paste the TypeSafe API key");
    const where = await setSecret("jev-api-key", b.key.trim());
    roots.decisions.reset();
    return c.json({ ok: true, stored_in: where });
  });

  app.delete("/api/classifier/jev-key", async (c) => {
    await deleteSecret("jev-api-key");
    roots.decisions.reset();
    return c.json({ ok: true });
  });
}
