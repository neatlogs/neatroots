import type { Command } from "commander";
import { loadConfig, saveConfig } from "../config.js";
import { api, running } from "./util.js";
import { maskedWebhookUrl, parseWebhooks } from "../webhook/config.js";
import { postWebhook } from "../webhook/payload.js";

export function registerWebhookCommands(program: Command): void {
  const webhook = program.command("webhook").description("Configure private, opt-in outgoing notifications");
  webhook.command("list").description("List destinations with paths and credentials hidden").action(() => {
    const cfg = loadConfig();
    for (const [i, hook] of (cfg.webhooks ?? []).entries()) console.log((i + 1) + ". " + maskedWebhookUrl(hook.url) + " " + hook.format + " " + hook.events.join(","));
    if (!cfg.webhooks?.length) console.log("No outgoing webhooks configured.");
  });
  webhook.command("add <url>").option("--events <events>", "halt,finding", "halt,finding")
    .option("--format <format>", "json, slack or discord", "json")
    .action(async (url: string, opts: { events: string; format: string }) => {
      const cfg = loadConfig();
      const hooks = parseWebhooks([...(cfg.webhooks ?? []), { url, events: opts.events.split(","), format: opts.format }]);
      if (await running(cfg.port)) {
        try { await api(cfg.port, "/api/settings", { method: "POST", body: JSON.stringify({ webhooks: hooks }) }); }
        catch { throw new Error("Could not update webhook configuration on the running instance"); }
      } else { cfg.webhooks = hooks; saveConfig(cfg); }
      console.log("Added webhook " + maskedWebhookUrl(hooks[hooks.length - 1].url));
    });
  webhook.command("test <url>").option("--format <format>", "json, slack or discord", "json")
    .action(async (url: string, opts: { format: string }) => {
      const [hook] = parseWebhooks([{ url, events: ["halt", "finding"], format: opts.format }]);
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        const result = await postWebhook(hook, { event: "test", state: "test" }, abort.signal);
        if (result !== "sent") throw new Error("Webhook test failed (no destination or response content is logged)");
        console.log("Webhook test delivered.");
      } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    });
}
