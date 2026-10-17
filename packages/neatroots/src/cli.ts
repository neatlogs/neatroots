#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { Roots } from "./core.js";
import { createApp, startServer } from "./server/app.js";
import { startGrpc } from "./ingest/grpc.js";
import { VERSION } from "./version.js";
import { rootsHome, loadConfig, saveConfig, type SteeringMode } from "./config.js";
import { runStdioBridge } from "./mcp/stdio.js";
import { api, ask, port, running } from "./cli/util.js";
import { registerModelCommands } from "./cli/models.js";
import { doctorModels } from "./cli/doctor-models.js";
import { registerServiceCommands } from "./cli/service.js";
import { registerConnectCommand } from "./cli/connect.js";
import { registerCloudImportCommands, registerDataCommands } from "./cli/data.js";
import { connectClient, findClient, listClients, serverCommand, CLIENTS } from "./mcp/clients.js";
import { parseChecks } from "./checks/registry.js";
import { checkWarnings } from "./checks/lint.js";
import { checkFiles } from "./checks/offline.js";
import { hardwareTier } from "./models/llm.js";
import { setCloudKey, deleteCloudKey, getCloudKey, getCloudToken } from "./relay/keychain.js";
import { LAYA_DOWNLOAD_MB } from "./models/laya.js";
import { askForLaya, layaNextSteps, shouldAskForLaya } from "./models/laya-consent.js";
import { log } from "./util/log.js";

const program = new Command();
program.name("neatroots").description("neatroots: local, private checks for AI agents while they run").version(VERSION);

// ------------------------------------------------------------------- start

program
  .command("start")
  .description("Run neatroots: collector, checks, steering, app and MCP on one local port")
  .option("-p, --port <port>", "port to listen on (default 4100)")
  .option("--grpc-port <port>", "port for OTLP over gRPC (default 4317; 0 turns it off)")
  .option("--no-engine", "collect and show runs without running checks")
  .option("--no-laya", "do not install or start Laya (the local decision model)")
  .action(async (opts) => {
    const roots = new Roots({
      noEngine: opts.engine === false,
      runtime: {
        port: opts.port ? Number(opts.port) : undefined,
        grpcPort: opts.grpcPort !== undefined ? Number(opts.grpcPort) : undefined,
        layaEnabled: opts.laya === false ? false : undefined,
      },
    });
    // Laya is a big download: ask once, when someone is at the terminal, before downloading it.
    if (shouldAskForLaya(roots.config, roots.laya.installed()) && process.stdin.isTTY && process.stdout.isTTY) {
      // No answer (Ctrl-D) leaves the choice open; the app and the next start ask again.
      const consent = await askForLaya(roots.laya.dir, (q) => ask(q)).catch(() => undefined);
      if (consent) {
        const saved = loadConfig();
        saved.classifier.laya.consent = consent;
        saveConfig(saved);
        roots.config.classifier.laya.consent = consent;
        console.log(`${layaNextSteps(consent)}\n`);
      } else console.log("");
    }
    const app = createApp(roots);
    try {
      await startServer(roots, app);
      await startGrpc(roots);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log.error(`port ${roots.config.port} is in use. Is neatroots already running? Try: neatroots status`);
        process.exit(1);
      }
      throw err;
    }
    roots.startRetention();
    if (roots.config.classifier.laya.enabled && !roots.laya.installed()) {
      const consent = roots.config.classifier.laya.consent;
      if (consent === "yes") log.info(`installing Laya, the local decision model, in the background (about ${(LAYA_DOWNLOAD_MB / 1000).toFixed(1)} GB to ${roots.laya.dir}). Skip with --no-laya.`);
      else if (consent === "no") log.info("Laya skipped. For check answers, set up Jev cloud: neatroots jev login && neatroots jev on (or neatroots laya install).");
      else log.info(`Laya, the local decision model (about ${(LAYA_DOWNLOAD_MB / 1000).toFixed(1)} GB), isn't downloaded. Choose in the app (Settings → Decision model) or run neatroots laya install; or use Jev cloud: neatroots jev login && neatroots jev on.`);
    }
    roots.startModels();
    const status = roots.engine ? await roots.engine.status() : null;
    const tier = hardwareTier();
    log.info(`app: http://localhost:${roots.config.port}`);
    log.info(`point your agent at it: NEATLOGS_ENDPOINT=http://localhost:${roots.config.port} NEATLOGS_API_KEY=neatroots-local`);
    log.info(`machine: ${tier.memoryGb} GB (${tier.tier} tier)`);
    if (status) {
      const where = status.llm.where && status.llm.where !== "local" ? `${status.llm.where} (hosted, opt-in)` : `local at ${roots.config.llm.baseUrl}`;
      log.info(status.llm.ok ? `LLM: ${status.llm.model}, ${where}` : `LLM: not available (${status.llm.error}). Rules still run; start Ollama or LM Studio, or turn on a hosted model (neatroots llm use), for questions and explanations.`);
      const layaComing = roots.laya.installed() || roots.config.classifier.laya.consent === "yes";
      const then = status.decision.backend !== "llm" ? "" : layaComing ? "; Laya takes over when it is ready" : "; Laya or Jev cloud takes over once one is set up";
      log.info(status.decision.backend ? `decision model now: ${status.decision.backend}${status.decision.model ? ` (${status.decision.model})` : ""}${then}` : "decision model: none yet");
    }
    if (roots.checks.errors.length) log.warn(`${roots.checks.errors.length} check file problem(s); see the Checks page`);
    const stop = () => {
      log.info("stopping");
      roots.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

// --------------------------------------------------------------------- mcp

program
  .command("mcp")
  .description("Serve neatroots' MCP tools over stdio for Claude Code, Cursor, Codex or any MCP client (starts neatroots if needed)")
  .option("-p, --port <port>")
  .action(async (opts) => {
    await runStdioBridge(port(opts.port));
  });

// -------------------------------------------------------------------- init

program
  .command("init")
  .description("Set up the current project: point the Neatlogs SDK at neatroots, add a checks folder, optionally enable steering and register the MCP server")
  .option("--project <name>", "project name (the SDK's service.name / workflow_name)")
  .option("--write-env", "write NEATLOGS_ENDPOINT and NEATLOGS_API_KEY to .env")
  .option("--steering <mode>", "enable steering for the project: advisory, gate or self-check")
  .option("--mcp <agent>", `connect a coding agent over MCP: ${CLIENTS.map((c) => c.id).join(", ")}`)
  .action(async (opts) => {
    // Validate flags before writing anything, so a bad --steering doesn't leave
    // .neatroots/ and .env behind (and print a success that was never saved).
    if (opts.steering) {
      if (!opts.project) {
        console.error("--steering needs --project <name> (your SDK workflow_name / service.name)");
        process.exit(1);
      }
      if (!["advisory", "gate", "self-check", "off"].includes(opts.steering)) {
        console.error("steering mode must be advisory, gate, self-check or off");
        process.exit(1);
      }
    }
    const cwd = process.cwd();
    const cfg = loadConfig();
    const p = cfg.port;
    const checksDir = path.join(cwd, ".neatroots", "checks");
    fs.mkdirSync(checksDir, { recursive: true });
    const readme = path.join(cwd, ".neatroots", "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        `# neatroots checks for this project\n\nYAML files in \`checks/\` are loaded by neatroots (https://github.com/neatlogs/neatroots) when it runs on this machine.\nA check with the same id as a library check replaces it. See \`neatroots checks --help\`.\n`,
      );
    }
    if (!cfg.checkDirs.includes(checksDir)) cfg.checkDirs.push(checksDir);
    console.log(`✓ checks folder: ${path.relative(cwd, checksDir)} (registered with neatroots)`);
    const envLines = [`NEATLOGS_ENDPOINT=http://localhost:${p}`, `NEATLOGS_API_KEY=neatroots-local`];
    if (opts.writeEnv) {
      const envPath = path.join(cwd, ".env");
      let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      const set = (key: string, value: string, onlyIfMissing: boolean) => {
        const re = new RegExp(`^${key}=.*$`, "m");
        if (re.test(text)) {
          if (!onlyIfMissing) text = text.replace(re, `${key}=${value}`);
        } else text += `${text && !text.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
      };
      set("NEATLOGS_ENDPOINT", `http://localhost:${p}`, false);
      // A real key stays: neatroots accepts any key and never stores it.
      set("NEATLOGS_API_KEY", "neatroots-local", true);
      fs.writeFileSync(envPath, text);
      console.log(`✓ .env points the Neatlogs SDK at neatroots`);
      // The SDKs read the environment, not .env, so without one of these the agent sends nothing (#49).
      console.log(
        `→ the SDK doesn't read .env on its own; load it when you start the agent:\n` +
          `    set -a; . ./.env; set +a          # then run it as usual\n` +
          `    dotenv run -- python agent.py     # or python-dotenv's load_dotenv() before neatlogs.init\n` +
          `    node --env-file=.env agent.js`,
      );
    } else {
      console.log(`→ point the Neatlogs SDK at neatroots (or rerun with --write-env):\n    ${envLines.join("\n    ")}`);
    }
    if (opts.steering) {
      // Already validated at the top of the action.
      cfg.projects[opts.project] = { ...(cfg.projects[opts.project] ?? {}), steering: opts.steering as SteeringMode };
      console.log(`✓ steering for ${opts.project}: ${opts.steering} (add the neatroots-steer hook to your agent; see docs/steering.md)`);
    }
    saveConfig(cfg);
    if (await running(p)) {
      await api(p, "/api/checks/reload", { method: "POST" }).catch(() => undefined);
      if (opts.steering && opts.project) await api(p, "/api/settings", { method: "POST", body: JSON.stringify({ project: opts.project, steering: opts.steering }) }).catch(() => undefined);
    }
    if (opts.mcp) {
      const c = findClient(opts.mcp);
      if (!c) throw new Error(`unknown agent "${opts.mcp}". Known: ${CLIENTS.map((x) => x.id).join(", ")}`);
      const r = connectClient(c);
      console.log(`${r.ok ? "✓" : "✗"} ${c.label}: ${r.message}`);
    } else {
      const cmd = serverCommand();
      console.log(`\nConnect your coding agents: neatroots connect   (Claude Code, Codex, Cursor, OpenCode, Windsurf, Amp, Gemini CLI, VS Code, Claude Desktop)`);
      console.log(`    or by hand: command "${cmd.command}", args ${JSON.stringify(cmd.args)}, or the HTTP endpoint http://localhost:${p}/mcp`);
    }
    console.log(`\nInstrumentation tip: pass flush_interval=0.5 to neatlogs.init() so neatroots sees spans while the run is still going.`);
  });

// ------------------------------------------------------------------ status

program
  .command("status")
  .description("Show whether neatroots is running, its models and recent runs")
  .option("-p, --port <port>")
  .action(async (opts) => {
    const p = port(opts.port);
    if (!(await running(p))) {
      console.log(`neatroots is not running on port ${p}. Start it with: neatroots start`);
      process.exitCode = 1;
      return;
    }
    const s = await api<any>(p, "/api/status");
    console.log(`neatroots ${s.version} on http://localhost:${s.port} (up ${Math.round(s.uptime_ms / 1000)}s)`);
    console.log(`  runs ${s.stats.runs} · spans ${s.stats.spans} · findings ${s.stats.findings} · ${(s.stats.bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  machine ${s.tier.memoryGb} GB (${s.tier.tier}) · ${s.tier.platform}`);
    if (s.engine) {
      console.log(`  LLM ${s.engine.llm.ok ? `${s.engine.llm.model} (${s.engine.llm.where === "local" ? "local" : `${s.engine.llm.where}, hosted`})` : `unavailable (${s.engine.llm.error})`}`);
      console.log(`  decisions ${s.engine.decision.backend ?? "unavailable"}${s.engine.decision.model ? ` (${s.engine.decision.model})` : ""}`);
      console.log(`  live runs ${s.engine.liveRuns} · pending checks ${s.engine.pendingJobs}`);
    }
    console.log(`  steering ${s.steering.enabled ? "on" : "OFF (global switch)"} · hooks connected ${s.steering.hooks_connected}`);
    console.log(`  cloud ${s.cloud.has_key ? "key stored" : "no key"} → ${s.cloud.endpoint}`);
  });

// ------------------------------------------------------------------ doctor

program
  .command("doctor")
  .description("Check that neatroots, its models and the trace path work on this machine")
  .option("-p, --port <port>")
  .action(async (opts) => {
    const p = port(opts.port);
    const cfg = loadConfig();
    let ok = true;
    const line = (pass: boolean | "warn", msg: string) => {
      console.log(`${pass === "warn" ? "!" : pass ? "✓" : "✗"} ${msg}`);
      if (pass === false) ok = false;
    };
    const up = await running(p);
    line(up, up ? `neatroots answers on http://localhost:${p}` : `neatroots is not running on port ${p} (neatroots start)`);
    await doctorModels(cfg, up, p, line);
    const tier = hardwareTier();
    line(true, `${tier.memoryGb} GB memory: ${tier.tier} tier, ${tier.description}`);
    const agents = listClients();
    const linked = agents.filter((a) => a.connected).map((a) => a.label);
    const unlinked = agents.filter((a) => a.detected && !a.connected).map((a) => a.label);
    line(linked.length ? true : "warn", linked.length ? `coding agents connected over MCP: ${linked.join(", ")}` : `no coding agent connected${unlinked.length ? ` (found ${unlinked.join(", ")}: neatroots connect)` : ""}`);
    if (up) {
      const traceId = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const spanId = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const now = BigInt(Date.now()) * 1_000_000n;
      const body = {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "neatroots.doctor" } }, { key: "neatlogs.doctor", value: { boolValue: true } }] },
            scopeSpans: [{ scope: { name: "neatroots.doctor" }, spans: [{ traceId, spanId, name: "neatroots.doctor.root", kind: 1, startTimeUnixNano: String(now), endTimeUnixNano: String(now + 1_000_000n), attributes: [{ key: "neatlogs.span.kind", value: { stringValue: "workflow" } }], status: { code: 1 } }] }],
          },
        ],
      };
      try {
        await api(p, "/v1/traces", { method: "POST", body: JSON.stringify(body) });
        const rb = await api<any>(p, `/api/traces/v3/${traceId}`);
        line(rb._id === traceId && rb.spanCount === 1, "trace round trip through /v1/traces and the doctor read-back");
        await api(p, `/api/runs/${traceId}`, { method: "DELETE" });
      } catch (err) {
        line(false, `trace round trip failed: ${(err as Error).message}`);
      }
      const s = await api<any>(p, "/api/status");
      line(s.check_errors.length === 0 ? true : "warn", s.check_errors.length ? `${s.check_errors.length} check file problem(s)` : "all checks load");
    }
    console.log(`\nTo test the SDK path end to end:  NEATLOGS_API_KEY=neatroots-local NEATLOGS_ENDPOINT=http://localhost:${p} python -m neatlogs doctor --probe`);
    process.exitCode = ok ? 0 : 1;
  });

// ---------------------------------------------------------------- steering

program
  .command("steering")
  .description("Show or set steering: neatroots steering [off|advisory|gate|self-check] --project <name>, or neatroots steering stop to turn it off everywhere")
  .argument("[mode]")
  .option("--project <name>")
  .option("-p, --port <port>")
  .action(async (mode: string | undefined, opts) => {
    const p = port(opts.port);
    const cfg = loadConfig();
    const isUp = await running(p);
    if (!mode) {
      console.log(`steering is ${cfg.steering.enabled ? "on" : "OFF"} globally`);
      for (const [name, s] of Object.entries(cfg.projects)) console.log(`  ${name}: ${s.steering ?? "off"}${s.forward ? " · forwarding to cloud" : ""}`);
      return;
    }
    if (mode === "stop" || mode === "start") {
      if (isUp) await api(p, "/api/settings", { method: "POST", body: JSON.stringify({ steering_enabled: mode === "start" }) });
      else {
        cfg.steering.enabled = mode === "start";
        saveConfig(cfg);
      }
      console.log(mode === "stop" ? "steering is off everywhere; nothing will be sent to agents" : "steering is on for projects that enabled it");
      return;
    }
    const modes: SteeringMode[] = ["off", "advisory", "gate", "self-check"];
    if (!modes.includes(mode as SteeringMode)) {
      console.error(`steering mode must be one of: ${modes.join(", ")} (or stop/start)`);
      process.exit(1);
    }
    if (!opts.project) {
      console.error("give --project <name>");
      process.exit(1);
    }
    if (isUp) await api(p, "/api/settings", { method: "POST", body: JSON.stringify({ project: opts.project, steering: mode }) });
    else {
      cfg.projects[opts.project] = { ...(cfg.projects[opts.project] ?? {}), steering: mode as SteeringMode };
      saveConfig(cfg);
    }
    console.log(`steering for ${opts.project}: ${mode}`);
  });

// ------------------------------------------------------------------- cloud

const cloud = program.command("cloud").description("Neatlogs Cloud: send runs (project API key) and import traces (service-account token)");

cloud
  .command("login")
  .description("Store your Neatlogs Cloud project API key, for sending runs (macOS Keychain)")
  .action(async () => {
    const key = process.stdin.isTTY ? await ask("Paste your API key from app.neatlogs.com: ", true) : fs.readFileSync(0, "utf8").trim();
    if (!key) {
      console.error("no key given");
      process.exit(1);
    }
    const where = await setCloudKey(key);
    console.log(`✓ stored in the ${where === "keychain" ? "macOS Keychain" : "file ~/.neatroots/cloud-api-key"}`);
  });

cloud
  .command("logout")
  .description("Remove the stored API key")
  .action(async () => {
    await deleteCloudKey();
    console.log("✓ removed");
  });

cloud
  .command("status")
  .action(async () => {
    const cfg = loadConfig();
    console.log(`endpoint ${cfg.cloud.endpoint} · project API key (sending) ${(await getCloudKey()) ? "stored" : "not stored"}`);
    console.log(`service-account token (importing) ${(await getCloudToken()) ? "stored" : "not stored"}${cfg.cloud.projectId ? ` · project ${cfg.cloud.projectId}` : ""}`);
  });

registerCloudImportCommands(cloud);

cloud
  .command("forward")
  .description("Send runs to Neatlogs Cloud (after a redaction preview)")
  .argument("<traceIds...>")
  .option("-y, --yes", "skip the confirmation")
  .option("-p, --port <port>")
  .action(async (traceIds: string[], opts) => {
    const p = port(opts.port);
    const preview = await api<any>(p, "/api/cloud/preview", { method: "POST", body: JSON.stringify({ trace_ids: traceIds }) });
    console.log(`${preview.span_count} spans from ${traceIds.length} run(s) → ${preview.endpoint}`);
    for (const r of preview.redactions) console.log(`  redacting ${r.count} × ${r.kind} (e.g. ${r.samples[0]?.sample} in ${r.samples[0]?.where})`);
    if (!preview.has_key) {
      console.error("no API key stored: run neatroots cloud login");
      process.exit(1);
    }
    if (!opts.yes && (await ask("Send? [y/N] ")).toLowerCase() !== "y") return;
    const r = await api<any>(p, "/api/cloud/forward", { method: "POST", body: JSON.stringify({ trace_ids: traceIds }) }).catch((e) => ({ status: "error", error: e.message }));
    console.log(r.status === "ok" ? `✓ sent ${r.span_count} spans (${r.bytes} bytes)` : `✗ ${r.error}`);
  });

cloud
  .command("auto")
  .description("Forward a project's runs automatically as they finish (on|off)")
  .argument("<project>")
  .argument("<state>")
  .option("-p, --port <port>")
  .action(async (project: string, state: string, opts) => {
    const p = port(opts.port);
    const on = state === "on";
    if (await running(p)) await api(p, "/api/settings", { method: "POST", body: JSON.stringify({ project, forward: on }) });
    else {
      const cfg = loadConfig();
      cfg.projects[project] = { ...(cfg.projects[project] ?? {}), forward: on };
      saveConfig(cfg);
    }
    console.log(`forwarding for ${project}: ${on ? "on" : "off"}`);
  });

// ------------------------------------------------------------------- rerun

// ------------------------------------------------------------------ check

program
  .command("check")
  .argument("<files...>", "trace files (.json, .jsonl)")
  .description("Run the rule checks over saved traces, with no server and no model. Exits 1 if any rule fires, so it can gate CI")
  .option("--checks <dir...>", "extra checks folders")
  .option("--only <ids>", "only these rule ids, comma-separated")
  .option("--json", "print the result as JSON")
  .action((files: string[], opts: { checks?: string[]; only?: string; json?: boolean }) => {
    try {
      const r = checkFiles(files, { dirs: opts.checks, only: opts.only?.split(",").map((s) => s.trim()).filter(Boolean) });
      const failed = r.runs.filter((x) => x.findings.length);
      if (opts.json) console.log(JSON.stringify({ runs: r.runs, rules: r.rules, errors: r.errors }, null, 2));
      else {
        for (const e of r.errors) console.log(`! ${e}`);
        for (const x of r.runs) {
          const label = `${x.file} ${x.trace_id.slice(0, 8)}${x.root_name ? ` ${x.root_name}` : ""}`;
          if (!x.findings.length) console.log(`✓ ${label}`);
          for (const f of x.findings) console.log(`✗ ${label}: ${f.check_id}: ${f.title}`);
        }
        console.log(`\n${r.runs.length} run${r.runs.length === 1 ? "" : "s"}, ${failed.length} with findings, ${r.rules.length} rules`);
      }
      process.exit(r.errors.length ? 2 : failed.length ? 1 : 0);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      process.exit(2);
    }
  });

// ------------------------------------------------------------------ checks

const checks = program.command("checks").description("List and validate checks");

checks
  .command("list")
  .option("-p, --port <port>")
  .action(async (opts) => {
    const p = port(opts.port);
    const r = await api<any>(p, "/api/checks");
    for (const c of r.checks) {
      const prec = c.precision.precision === null ? "" : ` · precision ${(c.precision.precision * 100).toFixed(0)}% of ${c.precision.hits}`;
      console.log(`${c.enabled ? "●" : "○"} ${c.id.padEnd(32)} ${c.kind.padEnd(7)} ${c.source.padEnd(8)}${prec}`);
    }
    for (const e of r.errors) console.log(`✗ ${e.path}: ${e.message}`);
  });

checks
  .command("validate")
  .argument("<files...>")
  .action((files: string[]) => {
    let bad = 0;
    for (const f of files) {
      const { checks: cs, errors } = parseChecks(fs.readFileSync(f, "utf8"));
      for (const c of cs) {
        console.log(`✓ ${f}: ${c.id} (${c.kind})`);
        for (const w of checkWarnings(c)) console.log(`  ! ${w}`);
      }
      for (const e of errors) {
        bad++;
        console.log(`✗ ${f}${e.id ? ` ${e.id}` : ""}: ${e.message}`);
      }
    }
    process.exitCode = bad ? 1 : 0;
  });

registerModelCommands(program);
registerServiceCommands(program);
registerConnectCommand(program);
registerDataCommands(program);

program
  .command("mock-llm")
  .description("Serve a predictable stand-in LLM (OpenAI and Anthropic APIs) so examples run without API keys")
  .option("-p, --port <port>", "port (default 4110)")
  .action(async (opts) => {
    const { startMockLlm } = await import("./dev/mock-llm.js");
    const p = Number(opts.port ?? 4110);
    await startMockLlm(p);
    console.log(`mock LLM on http://127.0.0.1:${p}/v1  (models: mock, mock-sloppy)`);
    console.log(`  export OPENAI_BASE_URL=http://127.0.0.1:${p}/v1 OPENAI_API_KEY=mock`);
    console.log(`  export ANTHROPIC_BASE_URL=http://127.0.0.1:${p} ANTHROPIC_API_KEY=mock`);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
