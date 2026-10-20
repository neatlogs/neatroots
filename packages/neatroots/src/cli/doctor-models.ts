import { rootsHome, type RootsConfig } from "../config.js";
import { DecisionModel } from "../models/decision.js";
import { LAYA_DOWNLOAD_MB, LayaManager, type LayaStatus } from "../models/laya.js";
import { LlmClient } from "../models/llm.js";
import { providerById } from "../models/providers.js";
import { getSecret } from "../relay/keychain.js";
import { api } from "./util.js";

type Line = (pass: boolean | "warn", msg: string) => void;

interface ServerModels {
  engine: { llm: { ok: boolean; where?: string; model?: string; error?: string }; decision: { backend: string | null; model: string | null } } | null;
  classifier: { laya: LayaStatus & { consent: "yes" | "no" | null }; jev_cloud: { enabled: boolean; has_key: boolean } };
}

const gb = (LAYA_DOWNLOAD_MB / 1000).toFixed(1);
const layaHint = `Download Laya (about ${gb} GB): neatroots laya install. Or use Jev: neatroots jev login && neatroots jev on`;

/**
 * The model lines of neatroots doctor. While neatroots runs they report what it actually uses:
 * its environment can hold a key (TOGETHER_API_KEY, say) that this terminal doesn't have.
 */
export async function doctorModels(cfg: RootsConfig, up: boolean, port: number, line: Line): Promise<void> {
  const llm = new LlmClient(cfg.llm, { secret: (n) => getSecret(n) });
  const here = await llm.status(true);
  const server = up ? await api<ServerModels>(port, "/api/status").catch(() => undefined) : undefined;
  if (server?.engine) {
    const { llm: s, decision } = server.engine;
    const label = s.where && s.where !== "local" ? (providerById(s.where)?.label ?? s.where) : undefined;
    line(
      s.ok ? true : "warn",
      s.ok
        ? `LLM calls go to ${label ? `${label} ${s.model ?? ""} (hosted, opt-in; run content is sent to it)` : `the local LLM ${s.model ?? ""}`}`.replace(/\s+\(/, " (").trim()
        : `the running neatroots has no LLM (${s.error ?? "none set up"}): questions, explanations and notes need Ollama, LM Studio or a hosted model (neatroots llm use)`,
    );
    if (s.ok && label && here.external && !here.external.ok) {
      line("warn", `this terminal can't see the ${label} key, but the running neatroots can (it's in that process's environment). Checks are fine; to use it from here too: neatroots llm login ${s.where}`);
    }
    const { laya, jev_cloud: jev } = server.classifier;
    if (laya.state === "running" || laya.state === "external") line(true, `Laya answers on 127.0.0.1:${cfg.classifier.laya.port}`);
    else if (laya.state === "installing" || laya.state === "starting") line("warn", `Laya is getting ready: ${laya.message ?? laya.state}`);
    else if (jev.enabled && jev.has_key) line(true, "Jev cloud answers checks");
    else if (laya.state === "stopped") line("warn", "Laya is installed but not running (Settings → Decision model → Restart Laya)");
    else line("warn", `Laya isn't downloaded and Jev cloud isn't set up, so the LLM answers checks (slower). ${layaHint}`);
    line(decision.backend ? true : "warn", decision.backend ? `decisions answered by: ${decision.backend}${decision.model ? ` (${decision.model})` : ""}` : "no decision model (no Laya, no Jev cloud, no LLM)");
    return;
  }

  // Not running: what this machine has.
  line(here.local.ok ? true : "warn", here.local.ok ? `local LLM ${here.local.model} at ${cfg.llm.baseUrl}` : `no local LLM at ${cfg.llm.baseUrl} (${here.local.error})`);
  if (here.external?.enabled) {
    line(here.external.ok, here.external.ok ? `hosted LLM ${here.external.label} ${here.external.model} (opt-in; run content is sent to it)` : `hosted LLM ${here.external.label}: ${here.external.error}`);
  }
  line(
    here.active ? true : "warn",
    here.active ? `LLM calls go to ${here.active === "local" ? "the local LLM" : here.external?.label}` : "no LLM: questions, explanations and notes need Ollama, LM Studio or a hosted model (neatroots llm use)",
  );
  const layaMgr = new LayaManager(rootsHome(), cfg.classifier);
  const dm = new DecisionModel(cfg.classifier, llm, { laya: async () => layaMgr.token, jevCloud: () => getSecret("jev-api-key") });
  const jevOn = cfg.classifier.jevCloud.enabled && !!(await getSecret("jev-api-key"));
  if (await dm.laya.available()) line(true, `Laya answers on 127.0.0.1:${cfg.classifier.laya.port}`);
  else if (layaMgr.installed()) line("warn", "Laya is installed but not running (neatroots start runs it)");
  else if (jevOn) line(true, "Laya isn't downloaded; Jev cloud answers checks");
  else if (cfg.classifier.laya.consent === "yes") line("warn", "Laya will download the next time neatroots starts (or now: neatroots laya install)");
  else line("warn", `Laya isn't downloaded and Jev cloud isn't set up, so the LLM answers checks (slower). ${layaHint}`);
  const st = await dm.status();
  line(st.backend ? true : "warn", st.backend ? `decisions answered by: ${st.backend}${st.model ? ` (${st.model})` : ""}` : "no decision model (no Laya, no Jev cloud, no LLM)");
}
