import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { loadConfig, saveConfig } from "../config.js";
import { cloudApiBase, listCloudProjects } from "../ingest/importers/neatlogs-cloud.js";
import { endpointProblem } from "../relay/endpoint.js";
import { deleteCloudToken, getCloudToken, setCloudToken } from "../relay/keychain.js";
import type { ImportSource } from "../ingest/importers/types.js";
import { api, ask, port, running } from "./util.js";

// neatroots import, replay and rerun: bring runs in from files and Neatlogs Cloud, and re-run them.

const CLOUD: Pick<ImportSource, "id" | "label" | "description" | "fields"> = {
  id: "neatlogs-cloud",
  label: "Neatlogs Cloud",
  description: "Traces from your Neatlogs Cloud project, read with a service-account token (neatroots cloud token).",
  fields: [{ name: "traceIds", label: "Trace ids, comma-separated (default: the most recent)" }],
};
const SOURCES = [CLOUD];

function windowMs(v: string | undefined, fallbackDays: number): number {
  if (!v) return Date.now() - fallbackDays * 86_400_000;
  const m = /^(\d+)([hdw])$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`--since takes 24h, 7d, 2w or a date, not "${v}"`);
  return t;
}

async function needRunning(): Promise<number> {
  const p = port();
  if (!(await running(p))) throw new Error(`neatroots isn't running on port ${p}. Start it first: neatroots start`);
  return p;
}

const flag = (name: string) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export function registerDataCommands(program: Command): void {
  const imp = program
    .command("import")
    .argument("[files...]", "trace files (.json, .jsonl), or neatlogs-cloud")
    .description("Bring traces into neatroots: trace files, or your Neatlogs Cloud project")
    .option("--since <when>", "earliest trace to import: 24h, 7d, 2w or a date (default 7d)")
    .option("--limit <n>", "most traces to import (default 100)")
    .option("--project <name>", "local project name for the imported runs")
    .option("--list", "show what each kind of import needs")
    .allowUnknownOption(true);
  for (const s of SOURCES) for (const f of s.fields) if (!imp.options.some((o) => o.long === flag(f.name))) imp.option(`${flag(f.name)} <value>`, `${s.label}: ${f.label}${f.env ? ` (or $${f.env})` : ""}`);
  imp.action(async (args: string[], opts: Record<string, string>) => {
    if (opts.list || !args.length) {
      for (const s of SOURCES) {
        console.log(`${s.id.padEnd(16)} ${s.description}`);
        for (const f of s.fields) console.log(`${"".padEnd(16)}   ${flag(f.name)}${f.required ? " (required)" : ""}  ${f.label}${f.env ? `  [$${f.env}]` : ""}`);
      }
      console.log(`\nFiles: neatroots import traces.json export.jsonl …  (OTLP JSON, Neatlogs trace exports, Neatlogs HTTP traces)`);
      return;
    }
    const p = await needRunning();
    const source = SOURCES.find((s) => s.id === args[0]);
    if (!source) {
      let traces = 0;
      for (const file of args) {
        if (!fs.existsSync(file)) throw new Error(`no such file: ${file} (to import from Neatlogs Cloud: neatroots import neatlogs-cloud)`);
        const r = await api<{ traces: number; spans: number }>(p, "/api/imports/file", {
          method: "POST",
          body: JSON.stringify({ name: path.basename(file), content: fs.readFileSync(file, "utf8"), project: opts.project }),
        });
        traces += r.traces;
        console.log(`✓ ${file}: ${r.traces} run${r.traces === 1 ? "" : "s"}, ${r.spans} spans`);
      }
      console.log(`\nOpen http://localhost:${p}/#/runs to see ${traces === 1 ? "it" : "them"}.`);
      return;
    }
    const values: Record<string, string> = {};
    for (const f of source.fields) {
      const v = opts[f.name] ?? (f.env ? process.env[f.env] : undefined);
      if (v) values[f.name] = v;
    }
    const job = await api<{ id: string }>(p, "/api/imports", {
      method: "POST",
      body: JSON.stringify({ source: source.id, values, since_ms: windowMs(opts.since, 7), limit: opts.limit ? Number(opts.limit) : 100, project: opts.project }),
    });
    process.stdout.write(`Importing from ${source.label}`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const { jobs } = await api<{ jobs: { id: string; state: string; traces: number; spans: number; failed: number; last_error: string | null }[] }>(p, "/api/imports");
      const j = jobs.find((x) => x.id === job.id);
      if (!j) throw new Error("the import disappeared");
      process.stdout.write(`\rImporting from ${source.label}: ${j.traces} runs, ${j.spans} spans${j.failed ? `, ${j.failed} failed` : ""}   `);
      if (j.state === "running") continue;
      console.log();
      if (j.state === "failed") throw new Error(j.last_error ?? "import failed");
      console.log(`✓ ${j.state}. Open http://localhost:${p}/#/runs`);
      return;
    }
  });

  program
    .command("replay")
    .argument("<trace-id>")
    .description("Replay a run: one LLM call with --span (no agent needed), or the whole agent through its registered rerun command or endpoint")
    .option("--span <id>", "replay only this LLM span, with the configured LLM")
    .option("--input <text>", "run the agent with this input instead")
    .option("--model <model>")
    .option("--system <prompt>", "system prompt override")
    .action(async (traceId: string, opts) => {
      const p = await needRunning();
      const r = await api<{ id: string; state: string; new_trace_id: string | null; output_preview: string | null; error: string | null }>(p, `/api/runs/${traceId}/replay`, {
        method: "POST",
        body: JSON.stringify({ span_id: opts.span, input: opts.input, model: opts.model, system: opts.system }),
      });
      let cur = r;
      while (cur.state === "running") {
        await new Promise((res) => setTimeout(res, 1000));
        cur = await api(p, `/api/replays/${r.id}`);
      }
      if (cur.state === "failed") throw new Error(cur.error ?? "replay failed");
      console.log(`✓ new run ${cur.new_trace_id}: http://localhost:${p}/#/runs/${cur.new_trace_id}`);
      if (cur.output_preview) console.log(`\n${cur.output_preview}`);
    });

  const rerun = program.command("rerun").description("How neatroots re-runs your agent, per project (replays and the MCP rerun tool)");
  rerun
    .command("add")
    .argument("<project>")
    .argument("[command]", "command that runs the agent once")
    .option("--cwd <dir>", "working directory (default: current)")
    .option("--url <url>", "or an HTTP replay endpoint on this machine the agent serves (POST, JSON body)")
    .action(async (project: string, command: string | undefined, opts) => {
      if (!command && !opts.url) throw new Error("give a command, or --url for an HTTP replay endpoint");
      const entry = { command, cwd: command ? path.resolve(opts.cwd ?? process.cwd()) : undefined, url: opts.url };
      if (entry.cwd && !(fs.existsSync(entry.cwd) && fs.statSync(entry.cwd).isDirectory())) throw new Error(`no such folder: ${entry.cwd}`);
      const p = port();
      if (await running(p)) await api(p, `/api/projects/${encodeURIComponent(project)}/rerun`, { method: "POST", body: JSON.stringify(entry) });
      else {
        const cfg = loadConfig();
        cfg.rerun[project] = entry;
        saveConfig(cfg);
      }
      console.log(`✓ ${project}: ${command ? `${command} (in ${entry.cwd})` : opts.url}`);
      console.log(`  During a replay the agent sees NEATROOTS_REPLAY_INPUT, NEATROOTS_REPLAY_MODEL and NEATROOTS_REPLAY_SYSTEM_PROMPT; neatroots_steer.replay_input() and wrap() use them.`);
    });
  rerun.command("list").action(() => {
    const cfg = loadConfig();
    const entries = Object.entries(cfg.rerun);
    if (!entries.length) console.log("No rerun commands yet: neatroots rerun add <project> \"<command>\"");
    for (const [k, v] of entries) console.log(`${k}: ${v.command ?? v.url}${v.cwd ? `  (cwd ${v.cwd})` : ""}`);
  });
  rerun
    .command("remove")
    .argument("<project>")
    .action(async (project: string) => {
      const p = port();
      if (await running(p)) await api(p, `/api/projects/${encodeURIComponent(project)}/rerun`, { method: "POST", body: "{}" });
      else {
        const cfg = loadConfig();
        delete cfg.rerun[project];
        saveConfig(cfg);
      }
      console.log(`✓ removed ${project}`);
    });
}

/** Sets the import project in the running neatroots, or in config.yaml when it isn't running. */
async function setImportProject(projectId: string | null): Promise<void> {
  const p = port();
  if (await running(p)) await api(p, "/api/cloud/import-auth", { method: "POST", body: JSON.stringify({ project_id: projectId }) });
  else {
    const cfg = loadConfig();
    cfg.cloud.projectId = projectId ?? undefined;
    saveConfig(cfg);
  }
}

/**
 * Where the CLI sends the service-account token: the same check as the server's cloudImportBase,
 * so a hand-edited cloud.apiBase can't send the token over plain http or to another host.
 */
export function checkedCloudApiBase(cfg: ReturnType<typeof loadConfig>): string {
  const base = cloudApiBase(cfg.cloud.endpoint, cfg.cloud.apiBase);
  const problem = endpointProblem(base, !!cfg.cloud.trustEndpoint);
  if (problem) throw new Error(problem);
  return base;
}

/** neatroots cloud token / cloud project: what importing from Neatlogs Cloud reads with. */
export function registerCloudImportCommands(cloud: Command): void {
  cloud
    .command("token")
    .description("Store a Neatlogs service-account token (nlsa_…) for importing traces from Neatlogs Cloud")
    .option("--remove", "remove the stored token")
    .action(async (opts: { remove?: boolean }) => {
      if (opts.remove) {
        await deleteCloudToken();
        await setImportProject(null);
        console.log("✓ removed the service-account token");
        return;
      }
      const token = process.stdin.isTTY ? await ask("Paste your Neatlogs service-account token (nlsa_…): ", true) : fs.readFileSync(0, "utf8").trim();
      if (!token) throw new Error("no token given");
      const where = await setCloudToken(token);
      console.log(`✓ stored in the ${where === "keychain" ? "macOS Keychain" : "file ~/.neatroots/cloud-service-token"}`);
      const cfg = loadConfig();
      const projects = await Promise.resolve()
        .then(() => listCloudProjects(checkedCloudApiBase(cfg), token))
        .catch((e: Error) => {
          console.log(`! couldn't list its projects: ${e.message}`);
          return null;
        });
      if (!projects) return;
      if (projects.length === 1) {
        await setImportProject(projects[0].id);
        console.log(`✓ imports come from ${projects[0].name}`);
      } else if (projects.length > 1) {
        console.log("It can read several projects. Choose the one imports come from:  neatroots cloud project <id>");
        for (const pr of projects) console.log(`  ${pr.id}  ${pr.name}${pr.isDefault ? "  (default)" : ""}`);
      }
    });

  cloud
    .command("project")
    .argument("[id]", "the project's id")
    .description("Show or choose the Neatlogs Cloud project imports come from")
    .action(async (id: string | undefined) => {
      if (id) {
        await setImportProject(id);
        console.log(`✓ imports come from project ${id}`);
        return;
      }
      const token = await getCloudToken();
      if (!token) throw new Error("no service-account token stored: run neatroots cloud token");
      const cfg = loadConfig();
      const projects = await listCloudProjects(checkedCloudApiBase(cfg), token);
      if (!projects.length) console.log("The token can't read any project.");
      for (const pr of projects) console.log(`${pr.id === cfg.cloud.projectId ? "→" : " "} ${pr.id}  ${pr.name}${pr.isDefault ? "  (default)" : ""}`);
    });
}
