import path from "node:path";
import { rootsHome, loadConfig, saveConfig, type RootsConfig } from "./config.js";
import { Bus } from "./bus.js";
import { Store, type TraceUpdate } from "./store/db.js";
import type { ResourceSpansBatch } from "./otlp/types.js";
import { LlmClient } from "./models/llm.js";
import { DecisionModel } from "./models/decision.js";
import { CheckRegistry } from "./checks/registry.js";
import { SteeringHub } from "./steering/hub.js";
import { Engine, resumeUnfinished } from "./engine/engine.js";
import { ImportJobs } from "./ingest/importers/index.js";
import { Replays } from "./replay/replay.js";
import { AgentChats } from "./agents/chat.js";
import { Relay } from "./relay/relay.js";
import { LayaManager } from "./models/laya.js";
import { getSecret } from "./relay/keychain.js";
import { log } from "./util/log.js";

export interface RootsOptions {
  home?: string;
  config?: RootsConfig;
  /** Skip the check engine (used by tests and read-only tools). */
  noEngine?: boolean;
}

/** The running neatroots instance: config, store, models, checks, steering and the event bus every part shares. */
export class Roots {
  readonly config: RootsConfig;
  readonly home: string;
  readonly store: Store;
  readonly bus = new Bus();
  readonly startedMs = Date.now();
  readonly llm: LlmClient;
  readonly decisions: DecisionModel;
  readonly checks: CheckRegistry;
  readonly steering: SteeringHub;
  readonly engine?: Engine;
  readonly relay: Relay;
  readonly laya: LayaManager;
  readonly imports: ImportJobs;
  readonly replays: Replays;
  readonly chats: AgentChats;
  private sweeper?: NodeJS.Timeout;
  /** When a coding agent last called neatroots over MCP. */
  mcpSeenMs: number | null = null;
  /** The run and span the app has in focus, for the MCP get_current_run tool. */
  focus: { trace_id: string; span_id: string | null; at: number } | null = null;
  /** Cloud pushes a coding agent asked for, waiting for the user to confirm in the app. */
  readonly pushes = new Map<string, { id: string; trace_ids: string[]; requested_by: string; created_ms: number; status: "pending" | "sent" | "failed" | "declined"; forward_id?: string; error?: string }>();

  constructor(opts: RootsOptions = {}) {
    this.home = opts.home ?? rootsHome();
    this.config = opts.config ?? loadConfig();
    this.store = new Store(path.join(this.home, "data"));
    this.llm = new LlmClient(this.config.llm, { secret: (n) => getSecret(n), redactPatterns: () => this.config.cloud.redactPatterns });
    this.laya = new LayaManager(this.home, this.config.classifier);
    this.decisions = new DecisionModel(
      this.config.classifier,
      this.llm,
      { laya: async () => this.laya.token, jevCloud: () => getSecret("jev-api-key") },
      this.store.trustStore(),
    );
    this.checks = new CheckRegistry(this.store, path.join(this.home, "checks"), () => this.config.checkDirs);
    this.steering = new SteeringHub(this);
    this.steering.warnInactiveHalts(this.checks.rules().filter((c) => c.source === "user" || c.source === "project").map((c) => c.check));
    this.relay = new Relay(this);
    this.imports = new ImportJobs(this);
    this.replays = new Replays(this);
    this.chats = new AgentChats(this);
    this.store.reindexSearch((n, ok) => (ok ? n && log.info(`search now covers whole inputs and outputs (${n} spans re-indexed)`) : log.warn("couldn't finish re-indexing search; it starts over at the next start")));
    this.store.rebuildSearchIds((n, ready) => (ready ? n && log.info(`search index ready for fast lookups (${n} rows)`) : log.warn("search index lookups couldn't be prepared; search works but is slower on a large store")));
    if (!opts.noEngine) {
      const engine = new Engine(this, this.llm, this.decisions, this.checks, this.steering);
      this.engine = engine;
      // Finish check work a previous process accepted but didn't complete (a restart or a crash).
      setTimeout(() => void resumeUnfinished(engine, this).catch((e: Error) => log.warn(`couldn't resume checks: ${e.message}`)), 1500).unref();
    }
  }

  ingest(batches: ResourceSpansBatch[]): TraceUpdate[] {
    const updates = this.store.ingest(batches);
    for (const u of updates) this.bus.emit("trace", u);
    return updates;
  }

  /** Saves to this instance's own home (the one it was opened with), never another one. */
  saveConfig(): void {
    saveConfig(this.config, path.join(this.home, "config.yaml"));
  }

  /** Applies retention now and every hour. */
  startRetention(): void {
    const run = () => {
      try {
        const removed = this.store.sweep(this.config.retention.days, this.config.retention.maxGb * 1024 ** 3);
        if (removed) log.info(`retention removed ${removed} old runs`);
      } catch (err) {
        log.warn(`retention failed: ${(err as Error).message}`);
      }
    };
    run();
    this.sweeper = setInterval(run, 3_600_000);
    this.sweeper.unref();
  }

  /** Installs (first run) and starts Laya in the background; checks use the LLM until it is ready. */
  startModels(): void {
    if (!this.config.classifier.laya.enabled) return;
    if (this.config.classifier.backend !== "auto" && this.config.classifier.backend !== "laya") return;
    void this.laya.ensure().then(() => this.decisions.reset());
  }

  close(): void {
    clearInterval(this.sweeper);
    this.laya.stop();
    this.store.close();
  }
}
