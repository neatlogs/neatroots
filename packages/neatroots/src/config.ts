import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export type SteeringMode = "off" | "advisory" | "gate" | "self-check";

export interface ProjectSettings {
  /** Steering is opt-in per project. */
  steering: SteeringMode;
  /** Re-export this project's runs to Neatlogs Cloud as they finish. */
  forward: boolean;
}

export interface RootsConfig {
  port: number;
  host: string;
  /** OTLP over gRPC (what plain OpenTelemetry exporters send to Neatlogs). 0 turns it off. */
  grpcPort: number;
  llm: {
    /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama). */
    baseUrl: string;
    /** Model name; "auto" picks an installed model. */
    model: string;
    apiKey?: string;
    /** Seconds the LLM may take for one call. */
    timeoutSec: number;
    enabled: boolean;
    /**
     * An opt-in hosted LLM (Anthropic, OpenAI, OpenRouter, Gemini, any OpenAI-compatible URL)
     * used instead of the local one. The run content each LLM task needs is sent to it.
     */
    external: {
      enabled: boolean;
      /** A provider id from models/providers.ts. */
      provider: string;
      model: string;
      /** "" uses the provider's default URL. */
      baseUrl: string;
      /** What to strip before sending: secrets (keys, tokens), all (also emails, phones, your cloud patterns), or off. */
      redact: "secrets" | "all" | "off";
      /** Use the local LLM when the provider fails or has no key. */
      fallbackToLocal: boolean;
      timeoutSec: number;
    };
  };
  classifier: {
    /**
     * auto: Laya on this machine, then a custom Jev-compatible server, then Jev cloud (only
     * when enabled), then the local LLM as a stand-in. Or pin one of them.
     */
    backend: "auto" | "laya" | "jev" | "jev-cloud" | "llm";
    /** A custom Jev-compatible typed-decision server (POST /v1/systemone). */
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutSec: number;
    /**
     * Laya, installed and run by neatroots on 127.0.0.1. consent: the person's answer to "download
     * Laya?" (about 1.4 GB); it is only downloaded after a yes. An installed Laya runs regardless.
     */
    laya: { enabled: boolean; port: number; consent?: "yes" | "no" };
    /** TypeSafe's hosted Jev. Opt-in: span content a question needs is sent to it. */
    jevCloud: { enabled: boolean; baseUrl: string; model: string };
  };
  embeddings: {
    /** Empty disables the vector index; full-text search is always on. */
    model: string;
  };
  budgets: {
    plansPerRun: number;
    investigationsPerRun: number;
    notesPerRun: number;
    summariesPerRun: number;
  };
  retention: {
    days: number;
    maxGb: number;
  };
  steering: {
    /** Global kill switch. When false nothing is ever sent to agents. */
    enabled: boolean;
    maxNotesPerRun: number;
    gateWaitMs: number;
  };
  cloud: {
    endpoint: string;
    /** Where people open runs in Neatlogs Cloud. */
    appUrl: string;
    /** Public API base for importing traces; derived from the endpoint when unset. */
    apiBase?: string;
    /** The Neatlogs Cloud project imports read from (x-project-id), for a service account that sees several. */
    projectId?: string;
    /** Send keys to a cloud endpoint outside *.neatlogs.com (https only), e.g. a self-hosted Neatlogs. */
    trustEndpoint?: boolean;
    /** User regexes to redact before forwarding, in addition to the built-ins. */
    redactPatterns: string[];
  };
  /** Who may write runs to the /v1 collector routes. */
  ingest: {
    /**
     * Web pages allowed to send traces from a browser, as origins (https://staging.example.com).
     * Pages on this machine (localhost, 127.0.0.1, [::1]) and requests with no Origin (SDKs,
     * exporters, curl) are always allowed. "*" allows every website.
     */
    allowedOrigins: string[];
  };
  /** How to re-run each project's agent (MCP rerun tool, replays): a command, or an HTTP replay endpoint. */
  rerun: Record<string, { command?: string; cwd?: string; url?: string }>;
  /** Extra directories holding checks (YAML), e.g. <repo>/.neatroots/checks. */
  checkDirs: string[];
  projects: Record<string, Partial<ProjectSettings>>;
}

export const DEFAULT_PORT = 4100;

export function defaultConfig(): RootsConfig {
  return {
    port: DEFAULT_PORT,
    host: "127.0.0.1",
    grpcPort: 4317,
    llm: {
      baseUrl: "http://localhost:11434/v1",
      model: "auto",
      timeoutSec: 120,
      enabled: true,
      external: {
        enabled: false,
        provider: "anthropic",
        model: "claude-opus-5-5",
        baseUrl: "",
        redact: "secrets",
        fallbackToLocal: true,
        timeoutSec: 120,
      },
    },
    classifier: {
      backend: "auto",
      baseUrl: "http://localhost:8000",
      model: "typed-decisions",
      timeoutSec: 15,
      laya: { enabled: true, port: 4101 },
      jevCloud: { enabled: false, baseUrl: "https://api.typesafe.ai", model: "jev-latest" },
    },
    embeddings: { model: "" },
    budgets: {
      plansPerRun: 1,
      investigationsPerRun: 3,
      notesPerRun: 3,
      summariesPerRun: 1,
    },
    retention: { days: 14, maxGb: 5 },
    steering: { enabled: true, maxNotesPerRun: 3, gateWaitMs: 300 },
    cloud: { endpoint: "https://ingest.neatlogs.com", appUrl: "https://app.neatlogs.com", redactPatterns: [] },
    ingest: { allowedOrigins: [] },
    rerun: {},
    checkDirs: [],
    projects: {},
  };
}

export function rootsHome(): string {
  if (process.env.NEATROOTS_HOME) return process.env.NEATROOTS_HOME;
  const home = path.join(os.homedir(), ".neatroots");
  // The installer creates ~/.neatroots for the app before neatroots ever runs, so only settings or
  // runs make it the home. Until then, installs from before the rename keep their data (and their
  // Laya environment, which can't be moved) where they were.
  const hasState = (d: string) => fs.existsSync(path.join(d, "config.yaml")) || fs.existsSync(path.join(d, "data"));
  if (hasState(home)) return home;
  const legacy = [".neatbolt", ".bolts"].map((d) => path.join(os.homedir(), d)).find(hasState);
  return legacy ?? home;
}

export function configPath(): string {
  return path.join(rootsHome(), "config.yaml");
}

const isSection = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Lays a parsed config.yaml over the defaults. A hand-edited value of the wrong shape is skipped
 * and its key recorded in `skipped`, so the default stays: a section written as a scalar
 * (`retention: 5`, `llm: ollama`) would otherwise replace the whole section and crash startup or a
 * later read. A list setting given as one string (`checkDirs: ./checks`) becomes a one-item list.
 */
function deepMerge<T>(base: T, over: unknown, skipped: string[] = [], prefix = ""): T {
  if (!isSection(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null) continue;
    // No setting has these names; assigning them would change the object's prototype.
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const cur = out[k];
    const key = prefix + k;
    if (isSection(cur)) {
      if (isSection(v)) out[k] = deepMerge(cur, v, skipped, `${key}.`);
      else skipped.push(key);
    } else if (Array.isArray(cur) && !Array.isArray(v)) {
      if (typeof v === "string") out[k] = [v];
      else skipped.push(key);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(): RootsConfig {
  const file = configPath();
  let cfg = defaultConfig();
  if (fs.existsSync(file)) {
    try {
      const skipped: string[] = [];
      cfg = deepMerge(cfg, YAML.parse(fs.readFileSync(file, "utf8")), skipped);
      for (const key of skipped) console.warn(`[neatroots] ignoring ${key} in ${file}: wrong shape, using the default`);
    } catch (err) {
      console.warn(`[neatroots] could not read ${file}: ${(err as Error).message}`);
    }
  }
  if (process.env.NEATROOTS_PORT) cfg.port = Number(process.env.NEATROOTS_PORT);
  if (process.env.NEATROOTS_LLM_BASE_URL) cfg.llm.baseUrl = process.env.NEATROOTS_LLM_BASE_URL;
  if (process.env.NEATROOTS_LLM_MODEL) cfg.llm.model = process.env.NEATROOTS_LLM_MODEL;
  if (process.env.NEATROOTS_CLASSIFIER_URL) cfg.classifier.baseUrl = process.env.NEATROOTS_CLASSIFIER_URL;
  if (process.env.NEATROOTS_CLASSIFIER_BACKEND) {
    cfg.classifier.backend = process.env.NEATROOTS_CLASSIFIER_BACKEND as RootsConfig["classifier"]["backend"];
  }
  // A hand edit may put an origin straight under ingest, or make allowedOrigins a single string.
  if (!cfg.ingest || typeof cfg.ingest !== "object" || Array.isArray(cfg.ingest)) cfg.ingest = { allowedOrigins: [] };
  const origins: unknown = cfg.ingest.allowedOrigins;
  cfg.ingest.allowedOrigins = (Array.isArray(origins) ? origins : typeof origins === "string" ? [origins] : []).filter((o): o is string => typeof o === "string");
  // Clamp retention to the same range the settings API enforces, so a stray
  // value in config.yaml (e.g. days: 0) can't delete every unpinned run.
  if (!Number.isFinite(cfg.retention.days) || cfg.retention.days < 1) cfg.retention.days = 14;
  cfg.retention.days = Math.min(Math.round(cfg.retention.days), 3650);
  if (!Number.isFinite(cfg.retention.maxGb) || cfg.retention.maxGb <= 0) cfg.retention.maxGb = 5;
  cfg.retention.maxGb = Math.min(cfg.retention.maxGb, 10_000);
  return cfg;
}

export function saveConfig(cfg: RootsConfig, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(cfg), "utf8");
}

export function projectSettings(cfg: RootsConfig, project: string): ProjectSettings {
  const p = cfg.projects[project] ?? {};
  return { steering: p.steering ?? "off", forward: p.forward ?? false };
}
