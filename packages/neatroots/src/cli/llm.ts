import fs from "node:fs";
import type { Command } from "commander";
import { loadConfig, saveConfig } from "../config.js";
import { LlmClient, type LlmStatus } from "../models/llm.js";
import { PROVIDERS, llmKeyName, providerById } from "../models/providers.js";
import { getSecret, setSecret, deleteSecret, secretEnvSource } from "../relay/keychain.js";
import { applyExternalLlm, type ExternalLlmInput } from "../server/api-models.js";
import { api, ask, port, running } from "./util.js";

function client(): LlmClient {
  return new LlmClient(loadConfig().llm, { secret: (n) => getSecret(n) });
}

function printStatus(s: LlmStatus): void {
  const cfg = loadConfig();
  console.log(s.local.ok ? `local    ✓ ${s.local.model} at ${s.local.baseUrl}` : `local    ✗ ${s.local.error} (${s.local.baseUrl})`);
  const e = s.external;
  if (e) {
    const state = !e.enabled ? "off" : e.ok ? "✓" : `✗ ${e.error}`;
    console.log(`external ${state} · ${e.label}${e.model ? ` · ${e.model}` : ""} · key ${e.hasKey ? "stored" : "none"} · redact ${cfg.llm.external.redact}`);
  }
  console.log(`\nLLM calls go to: ${s.active ? (s.active === "local" ? "the local LLM" : e?.label) : "nowhere; start Ollama or turn on a provider"}`);
}

/** Applies a change to llm.external in the running app, or in the config file when it is stopped. */
async function change(p: number, input: ExternalLlmInput): Promise<void> {
  if (await running(p)) {
    await api(p, "/api/llm/external", { method: "POST", body: JSON.stringify(input) });
    return;
  }
  const cfg = loadConfig();
  const error = applyExternalLlm(cfg.llm.external, input);
  if (error) throw new Error(error);
  saveConfig(cfg);
}

/** neatroots llm: the local LLM and opt-in hosted providers. */
export function registerLlmCommands(program: Command): void {
  const llm = program.command("llm").description("The LLM neatroots uses: local by default, or a hosted provider you turn on");

  llm
    .command("status", { isDefault: true })
    .description("Show the local LLM, the external provider, and where calls go")
    .action(async () => printStatus(await client().status(true)));

  llm
    .command("providers")
    .description("List the hosted providers neatroots can use")
    .action(async () => {
      for (const p of PROVIDERS) {
        const name = llmKeyName(p.id);
        const env = secretEnvSource(name);
        const key = env ? `key from $${env}` : (await getSecret(name)) ? "key stored" : "no key";
        console.log(`${p.id.padEnd(11)} ${p.label.padEnd(30)} ${(p.defaultModel || "pick a model").padEnd(18)} ${key}`);
      }
      console.log("\nneatroots llm login <provider>, then neatroots llm use <provider> [--model <id>]");
    });

  llm
    .command("login")
    .argument("<provider>", PROVIDERS.map((p) => p.id).join(", "))
    .description("Store a provider's API key (macOS Keychain; a 0600 file elsewhere)")
    .option("-p, --port <port>")
    .action(async (provider: string, opts) => {
      const p = providerById(provider);
      if (!p) throw new Error(`unknown provider; one of ${PROVIDERS.map((x) => x.id).join(", ")}`);
      if (p.keyUrl) console.log(`Get a key at ${p.keyUrl}`);
      const key = process.stdin.isTTY ? await ask(`Paste your ${p.label} API key: `, true) : fs.readFileSync(0, "utf8").trim();
      if (!key) throw new Error("no key given");
      const where = await setSecret(llmKeyName(p.id), key);
      if (await running(port(opts.port))) await api(port(opts.port), "/api/llm/external", { method: "POST", body: "{}" });
      console.log(`✓ stored in the ${where === "keychain" ? "macOS Keychain" : `file ~/.neatroots/${llmKeyName(p.id)}`}. Turn it on with: neatroots llm use ${p.id}`);
    });

  llm
    .command("logout")
    .argument("<provider>")
    .option("-p, --port <port>")
    .action(async (provider: string, opts) => {
      if (!providerById(provider)) throw new Error("unknown provider");
      await deleteSecret(llmKeyName(provider));
      if (await running(port(opts.port))) await api(port(opts.port), "/api/llm/external", { method: "POST", body: "{}" });
      console.log("✓ removed");
    });

  llm
    .command("use")
    .argument("<provider>", PROVIDERS.map((p) => p.id).join(", "))
    .description("Send LLM work (planning, questions, investigations, notes, summaries) to a hosted provider")
    .option("--model <id>", "model id; see neatroots llm models <provider>")
    .option("--base-url <url>", "API base URL (needed for custom)")
    .option("--redact <mode>", "strip before sending: secrets (default), all, or off")
    .option("--no-fallback", "fail instead of using the local LLM when the provider is unavailable")
    .option("-p, --port <port>")
    .action(async (provider: string, opts) => {
      const p = providerById(provider);
      if (!p) throw new Error(`unknown provider; one of ${PROVIDERS.map((x) => x.id).join(", ")}`);
      const current = loadConfig().llm.external;
      const model = opts.model ?? (current.provider === p.id && current.model ? current.model : p.defaultModel);
      if (!model) throw new Error(`pick a model: neatroots llm models ${p.id}, then neatroots llm use ${p.id} --model <id>`);
      if (!(await getSecret(llmKeyName(p.id)))) throw new Error(`no key stored for ${p.label}: neatroots llm login ${p.id}`);
      await change(port(opts.port), { provider: p.id, model, base_url: opts.baseUrl, redact: opts.redact, fallback_to_local: opts.fallback, enabled: true });
      console.log(`${p.label} is on (${model}). The run content each LLM task needs is sent to ${p.label}${opts.redact === "off" ? "" : ", with secrets removed"}.`);
      console.log("Rules, storage and the app stay on this machine. Back to local only: neatroots llm local\n");
      const r = await client().status(true);
      printStatus(r);
      if (r.external && !r.external.ok) process.exitCode = 1;
    });

  llm
    .command("local")
    .description("Stop using a hosted provider; everything runs on this machine")
    .option("-p, --port <port>")
    .action(async (opts) => {
      await change(port(opts.port), { enabled: false });
      console.log("The LLM is local only. Nothing is sent to a hosted provider.");
    });

  llm
    .command("models")
    .argument("[provider]", "a provider id, or omit for the local server")
    .description("List the models a provider (or the local server) offers")
    .action(async (provider?: string) => {
      const cfg = loadConfig();
      const ext = cfg.llm.external;
      if (provider && provider !== ext.provider) {
        if (!providerById(provider)) throw new Error("unknown provider");
        ext.provider = provider;
        ext.baseUrl = "";
      }
      const c = new LlmClient(cfg.llm, { secret: (n) => getSecret(n) });
      const models = (await c.listModels(provider ? "external" : "local")).sort();
      for (const m of models) console.log(m);
      if (!models.length) console.log("no models listed");
    });

  llm
    .command("test")
    .description("Send one tiny prompt to wherever LLM calls go now")
    .option("-p, --port <port>")
    .action(async (opts) => {
      const p = port(opts.port);
      const r = (await running(p))
        ? await api<{ ok: boolean; where: string; model: string; latency_ms: number }>(p, "/api/llm/test", { method: "POST", body: "{}" })
        : await (async () => {
            const res = await client().chat(
              [
                { role: "system", content: "Reply with JSON only." },
                { role: "user", content: 'Reply with {"ok": true}.' },
              ],
              { schema: { name: "ping", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }, maxTokens: 32, priority: "urgent" },
            );
            return { ok: (res.json as { ok?: boolean } | undefined)?.ok === true, where: res.where ?? "local", model: res.model, latency_ms: res.latencyMs };
          })();
      console.log(`${r.ok ? "✓" : "✗"} ${r.where} · ${r.model} · ${r.latency_ms} ms`);
      process.exitCode = r.ok ? 0 : 1;
    });
}
