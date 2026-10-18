import type { Bus } from "../bus.js";
import type { Store } from "../store/db.js";
import { ChromaOutput, type ChromaOptions, type ChromaStatus } from "./chroma.js";
import { normalizeAmbient } from "./config.js";
import { logOutput } from "./log.js";
import { AmbientService } from "./service.js";
import type { AmbientChecks, AmbientConfig, AmbientOutput, AmbientSignal } from "./types.js";

type DeviceOutput = Pick<ChromaOutput, "setState" | "setEnabled" | "status" | "close">;
const inactive = (): ChromaStatus => ({ enabled: false, phase: "inactive", state: "inactive", error: null });
const empty: AmbientSignal = { state: "inactive", active_runs: 0, trace_id: null, project: null, workflow: null };

/** App owner: isolates outputs and serializes replacement, with only the latest config retained. */
export class AmbientController implements AmbientOutput {
  private readonly service: AmbientService;
  private config = normalizeAmbient(undefined);
  private current = empty;
  private chroma?: DeviceOutput;
  private deviceStatus = inactive();
  private logError = false;
  private version = 0;
  private applied = 0;
  private running?: Promise<void>;
  private closed = false;

  constructor(store: Store, bus: Bus, checks: (id: string) => AmbientChecks,
    private readonly logger: AmbientOutput = logOutput(),
    private readonly createChroma: (options: ChromaOptions) => DeviceOutput = options => new ChromaOutput(options)) {
    this.service = new AmbientService(store, bus, this, checks);
  }

  configure(config: AmbientConfig): void {
    if (this.closed) return;
    const next = normalizeAmbient(config);
    const wasLogging = this.config.enabled && this.config.outputs.log.enabled;
    const changed = this.key(next) !== this.key(this.config);
    this.config = next;
    if (changed) {
      this.version++;
      this.chroma?.setEnabled(false); // Kill pending effects immediately, even while close is awaiting HTTP.
      this.deviceStatus = this.effectiveChroma() ? { ...inactive(), phase: "connecting" } : inactive();
      this.schedule();
    }
    if (wasLogging && !(next.enabled && next.outputs.log.enabled)) this.writeLog(empty);
    this.service.configure(next);
    if (!wasLogging && next.enabled && next.outputs.log.enabled) this.writeLog(this.current);
  }

  private key(config: AmbientConfig): string { return JSON.stringify([config.enabled, config.outputs.chroma]); }
  private effectiveChroma(): boolean { return !this.closed && this.config.enabled && this.config.outputs.chroma?.enabled === true; }
  private writeLog(signal: AmbientSignal): void {
    try { this.logger.setState(signal); this.logError = false; } catch { this.logError = true; }
  }
  setState(signal: Readonly<AmbientSignal>): void {
    this.current = { state: signal.state, active_runs: signal.active_runs, trace_id: null, project: null, workflow: null };
    if (this.config.enabled && this.config.outputs.log.enabled) this.writeLog(this.current);
    this.chroma?.setState(this.current);
  }
  status() {
    return { ...this.service.status(), output_error: this.logError,
      chroma: { ...(this.chroma?.status() ?? this.deviceStatus), configured: this.config.outputs.chroma!.enabled,
        animation: this.config.outputs.chroma!.animation, devices: [...this.config.outputs.chroma!.devices] } };
  }
  retryChroma(): void {
    if (!this.effectiveChroma()) return;
    this.version++;
    this.deviceStatus = { ...inactive(), phase: "connecting" };
    this.schedule();
  }
  private schedule(): void {
    if (this.running) return;
    this.running = this.replace().finally(() => {
      this.running = undefined;
      if (this.applied !== this.version) this.schedule();
    });
  }
  private async replace(): Promise<void> {
    while (this.applied !== this.version) {
      const version = this.version;
      const previous = this.chroma;
      this.chroma = undefined;
      if (previous) await previous.close();
      if (version !== this.version) continue;
      this.applied = version;
      if (!this.effectiveChroma()) { this.deviceStatus = inactive(); continue; }
      try {
        const options = this.config.outputs.chroma!;
        const output = this.createChroma({ animation: options.animation, devices: options.devices });
        this.chroma = output;
        output.setState(this.current.state === "inactive" ? { ...empty, state: "idle" } : this.current);
        output.setEnabled(true);
      } catch { this.deviceStatus = { ...inactive(), phase: "unavailable", error: "service-unavailable" }; }
    }
  }
  async flush(): Promise<void> { while (this.running) await this.running; }
  async close(): Promise<void> {
    this.closed = true;
    this.service.close();
    this.chroma?.setEnabled(false);
    this.version++;
    this.schedule();
    await this.flush();
  }
}
