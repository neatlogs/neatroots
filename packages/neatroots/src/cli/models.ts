import fs from "node:fs";
import type { Command } from "commander";
import { rootsHome, loadConfig, saveConfig } from "../config.js";
import { hardwareTier, LlmClient } from "../models/llm.js";
import { DecisionModel } from "../models/decision.js";
import { LAYA_DOWNLOAD_MB, LayaManager } from "../models/laya.js";
import { askForLaya, layaAllowed, layaNextSteps, shouldAskForLaya, type LayaConsent } from "../models/laya-consent.js";
import { getSecret, setSecret, deleteSecret } from "../relay/keychain.js";
import { api, ask, port, running } from "./util.js";
import { registerLlmCommands } from "./llm.js";

/** neatroots models, neatroots llm, neatroots laya, neatroots jev. */
export function registerModelCommands(program: Command): void {
  program
    .command("models")
    .description("Show the hardware tier and which local models neatroots will use")
    .action(async () => {
      const cfg = loadConfig();
      const tier = hardwareTier();
      console.log(`${tier.memoryGb} GB memory → ${tier.tier} tier: ${tier.description}`);
      const llm = new LlmClient(cfg.llm, { secret: (n) => getSecret(n) });
      const probe = await llm.probe(true);
      console.log(probe.ok ? `LLM: ${probe.model} (installed: ${probe.models?.join(", ")})` : `LLM: none at ${cfg.llm.baseUrl} (${probe.error})`);
      const laya = new LayaManager(rootsHome(), cfg.classifier);
      const dm = new DecisionModel(cfg.classifier, llm, { laya: async () => laya.token, jevCloud: () => getSecret("jev-api-key") });
      console.log(`Laya: ${(await dm.laya.available()) ? `running on 127.0.0.1:${cfg.classifier.laya.port}` : laya.installed() ? "installed, not running (neatroots start runs it)" : `not installed (neatroots laya install, about ${(LAYA_DOWNLOAD_MB / 1000).toFixed(1)} GB)`}`);
      console.log(`Jev cloud: ${cfg.classifier.jevCloud.enabled ? "on" : "off"}${(await getSecret("jev-api-key")) ? ", key stored" : ", no key"}`);
      const st = await dm.status();
      console.log(`decisions now: ${st.backend ?? "none"}${st.model ? ` (${st.model})` : ""}`);
    });

  const laya = program.command("laya").description("Laya, the local decision model neatroots runs");

  laya
    .command("install")
    .description("Download and install Laya into ~/.neatroots/laya now, and check that it starts")
    .action(async () => {
      const cfg = loadConfig();
      cfg.classifier.laya.enabled = true;
      cfg.classifier.laya.consent = "yes";
      saveConfig(cfg);
      const m = new LayaManager(rootsHome(), cfg.classifier);
      console.log(`Installing Laya ${"(about " + (LAYA_DOWNLOAD_MB / 1000).toFixed(1) + " GB)"} into ${m.dir}…`);
      const t = setInterval(() => {
        const s = m.state;
        if (s.message) process.stdout.write(`\r  ${s.message}${s.progress !== null ? ` (${Math.round(s.progress * 100)}%)` : ""}`.padEnd(90));
      }, 1000);
      await m.ensure({ install: true });
      clearInterval(t);
      const s = m.state;
      console.log(`\n${s.state === "running" ? "✓" : "✗"} Laya ${s.state}${s.message ? `: ${s.message}` : ""}`);
      m.stop();
      process.exitCode = s.state === "running" ? 0 : 1;
    });

  const record = async (consent: LayaConsent) => {
    // Saved here, not only through a running neatroots: one from before this question rejects it.
    const cfg = loadConfig();
    cfg.classifier.laya.consent = consent;
    if (consent === "yes") cfg.classifier.laya.enabled = true;
    saveConfig(cfg);
    // A running neatroots takes the answer now (a yes starts the download in the background).
    const p = port();
    const live = (await running(p)) && (await api(p, "/api/classifier/laya", { method: "POST", body: JSON.stringify({ action: consent === "yes" ? "install" : "skip" }) }).then(() => true, () => false));
    console.log(consent === "yes" ? layaAllowed(new LayaManager(rootsHome(), cfg.classifier).installed(), live) : layaNextSteps(consent));
  };

  laya
    .command("choose")
    .description("Explain what Laya is for and ask whether to download it (the installer runs this)")
    .option("--no-ask", "only say how to choose later")
    .action(async (opts: { ask: boolean }) => {
      const cfg = loadConfig();
      const m = new LayaManager(rootsHome(), cfg.classifier);
      // Installed already, or answered before (an update runs the installer again): nothing to ask.
      if (!shouldAskForLaya(cfg, m.installed())) return;
      if (!opts.ask || !process.stdin.isTTY) {
        console.log(`Laya (the local decision model, about ${(LAYA_DOWNLOAD_MB / 1000).toFixed(1)} GB) isn't downloaded: neatroots laya install, or use Jev cloud: neatroots jev login && neatroots jev on`);
        return;
      }
      await record(await askForLaya(m.dir, (q) => ask(q)));
    });

  laya
    .command("allow")
    .description("Let neatroots download Laya the next time it starts (in the background)")
    .action(() => record("yes"));

  laya
    .command("skip")
    .description("Don't download Laya; use Jev cloud for check answers instead")
    .action(() => record("no"));

  laya
    .command("status")
    .action(async () => {
      const cfg = loadConfig();
      const m = new LayaManager(rootsHome(), cfg.classifier);
      const dm = new DecisionModel(cfg.classifier, new LlmClient(cfg.llm, { secret: (n) => getSecret(n) }), { laya: async () => m.token, jevCloud: async () => undefined });
      console.log(`installed: ${m.installed() ? "yes" : "no"} · enabled: ${cfg.classifier.laya.enabled} · running: ${(await dm.laya.available()) ? `yes on 127.0.0.1:${cfg.classifier.laya.port}` : "no"}`);
    });

  laya
    .command("off")
    .description("Stop using Laya (neatroots falls back to Jev cloud if on, else the local LLM)")
    .action(() => {
      const cfg = loadConfig();
      cfg.classifier.laya.enabled = false;
      saveConfig(cfg);
      console.log("Laya is off. Restart neatroots to stop a running Laya.");
    });

  const jev = program.command("jev").description("Jev cloud (TypeSafe), an opt-in hosted decision model");

  jev
    .command("login")
    .description("Store your TypeSafe API key (macOS Keychain)")
    .action(async () => {
      const key = process.stdin.isTTY ? await ask("Paste your TypeSafe API key: ", true) : fs.readFileSync(0, "utf8").trim();
      if (!key) {
        console.error("no key given");
        process.exit(1);
      }
      const where = await setSecret("jev-api-key", key);
      console.log(`✓ stored in the ${where === "keychain" ? "macOS Keychain" : "file ~/.neatroots/jev-api-key"}. Turn it on with: neatroots jev on`);
    });

  jev.command("logout").action(async () => {
    await deleteSecret("jev-api-key");
    console.log("✓ removed");
  });

  for (const state of ["on", "off"] as const) {
    jev
      .command(state)
      .description(state === "on" ? "Use Jev cloud for decisions (span content a question needs is sent to api.typesafe.ai)" : "Stop using Jev cloud")
      .option("-p, --port <port>")
      .action(async (opts) => {
        const p = port(opts.port);
        if (await running(p)) await api(p, "/api/settings", { method: "POST", body: JSON.stringify({ jev_cloud_enabled: state === "on" }) });
        else {
          const cfg = loadConfig();
          cfg.classifier.jevCloud.enabled = state === "on";
          saveConfig(cfg);
        }
        console.log(state === "on" ? "Jev cloud is on. Span content a question needs is sent to api.typesafe.ai; everything else stays local." : "Jev cloud is off.");
      });
  }

  registerLlmCommands(program);
}
