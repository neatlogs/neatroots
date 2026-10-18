import { chromaDevices, chromaFrame, type ChromaDevice, type ChromaEffect } from "./chroma-frames.js";
import type { AmbientOutput, AmbientSignal, AmbientState } from "./types.js";

const DEFAULT_BASE = "http://localhost:54235/razer/chromasdk";
export interface ChromaStatus {
  enabled: boolean;
  phase: "inactive" | "connecting" | "ready" | "unavailable";
  state: AmbientState;
  error: "service-unavailable" | null;
}
/** Overrides are for in-process loopback tests only; production uses the fixed default. */
export interface ChromaTestOptions {
  baseUrl?: string;
  timeoutMs?: number;
  heartbeatMs?: number;
  maxResponseBytes?: number;
  /** Test-only monotonic clock and frame cadence. */
  now?: () => number;
  frameMs?: number;
}

export interface ChromaOptions extends ChromaTestOptions {
  /** Explicit opt-in; defaults to static lighting. */
  animation?: boolean;
  /** Defaults to ChromaLink only; a finite documented allowlist. */
  devices?: readonly ChromaDevice[];
}

interface PendingFrame { version: number; next: number; body: ChromaEffect; }

/** One serialized HTTP owner; only a named state's static color leaves this component. */
export class ChromaOutput implements AmbientOutput {
  private readonly base: URL;
  private readonly timeout: number;
  private readonly heartbeat: number;
  private readonly maxBytes: number;
  private session: string | null = null;
  private sessionGeneration = 0;
  private wanted: AmbientState = "idle";
  private readonly devices: readonly ChromaDevice[];
  private readonly animation: boolean;
  private readonly now: () => number;
  private readonly frameMs: number;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private frameDue = false;
  private frameStarted = 0;
  private stateVersion = 0;
  private frame: PendingFrame | null = null;
  private enabled = false;
  private closed = false;
  private generation = 0;
  private beat = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private restart = false;
  private snapshot: ChromaStatus = { enabled: false, phase: "inactive", state: "inactive", error: null };

  constructor(options: ChromaOptions = {}) {
    this.devices = chromaDevices(options.devices);
    if (options.animation !== undefined && typeof options.animation !== "boolean") throw new Error("Invalid Chroma animation option");
    this.animation = options.animation ?? false;
    this.now = options.now ?? (() => performance.now());
    this.frameMs = options.frameMs ?? 100;
    if (!Number.isSafeInteger(this.frameMs) || this.frameMs < 10 || this.frameMs > 1000) throw new Error("Invalid Chroma frame cadence");
    this.base = new URL(options.baseUrl ?? DEFAULT_BASE);
    if (!this.local(this.base) || this.base.pathname !== "/razer/chromasdk") throw new Error("Invalid Chroma base");
    this.timeout = options.timeoutMs ?? 1500;
    this.heartbeat = options.heartbeatMs ?? 1000;
    this.maxBytes = options.maxResponseBytes ?? 16384;
    if (![this.timeout, this.heartbeat, this.maxBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid Chroma limits");
  }

  status(): Readonly<ChromaStatus> { return { ...this.snapshot }; }

  setEnabled(enabled: boolean): void {
    if (this.closed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    this.restart = true;
    this.clearTimer();
    this.frameStarted = this.now();
    this.snapshot = { enabled, phase: enabled ? "connecting" : "inactive", state: enabled ? this.wanted : "inactive", error: null };
    this.kick();
  }

  setState(signal: Readonly<AmbientSignal>): void {
    if (signal.state === "inactive") { this.setEnabled(false); return; }
    if (this.wanted !== signal.state) {
      this.wanted = signal.state;
      this.stateVersion++;
      this.frameStarted = this.now();
      this.clearFrame();
    }
    if (this.enabled) { this.snapshot.state = signal.state; this.kick(); }
  }

  async close(): Promise<void> {
    this.setEnabled(false);
    this.closed = true;
    await this.flush();
  }

  /** Wait for currently requested work, without waiting for future heartbeats. */
  async flush(): Promise<void> {
    while (this.running) await this.running;
  }

  private local(url: URL): boolean {
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  }

  private sessionUrl(value: unknown): string {
    if (typeof value !== "string" || value.length > 256) throw new Error("Invalid session");
    const url = new URL(value);
    if (!this.local(url) || url.hostname !== this.base.hostname || url.pathname !== "/chromasdk") throw new Error("Invalid session");
    return url.href;
  }

  private clearFrame(): void {
    clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
    this.frameDue = false;
    this.frame = null;
  }
  private clearTimer(): void {
    clearTimeout(this.timer); this.timer = undefined; this.beat = false;
    this.clearFrame();
  }
  private needsFrame(): boolean {
    return !this.frame || this.frame.version !== this.stateVersion || this.frame.next < this.devices.length || this.frameDue;
  }
  private nextFrame(): PendingFrame {
    if (!this.frame || this.frame.version !== this.stateVersion || (this.frame.next >= this.devices.length && this.frameDue)) {
      const value = chromaFrame(this.wanted, this.now() - this.frameStarted, this.animation);
      this.frame = { version: this.stateVersion, next: 0, body: value.body };
      this.frameDue = false;
      if (value.moving && !this.frameTimer && this.enabled && !this.closed) {
        this.frameTimer = setTimeout(() => { this.frameTimer = undefined; this.frameDue = true; this.kick(); }, this.frameMs);
      }
    }
    return this.frame;
  }
  private armHeartbeat(): void {
    if (this.enabled && !this.closed && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.beat = true; this.kick(); }, this.heartbeat);
  }
  private kick(): void {
    if (this.running) return;
    this.restart = false;
    this.running = this.pump().finally(() => {
      this.running = undefined;
      if (this.restart || (this.enabled && (this.needsFrame() || this.beat))) this.kick();
    });
  }

  private async request(url: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(url, { method, redirect: "error", signal: controller.signal,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) throw new Error("HTTP error");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > this.maxBytes) { await reader.cancel(); throw new Error("Oversized response"); }
        chunks.push(part.value);
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid response");
      return data as Record<string, unknown>;
    } finally { clearTimeout(timer); }
  }

  private async sdk(url: string, method: string, body?: unknown): Promise<void> {
    if ((await this.request(url, method, body)).result !== 0) throw new Error("SDK error");
  }

  private async dispose(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.clearFrame();
    if (!session) return;
    // Cleanup is bounded and best effort, including after a failed effect/heartbeat.
    for (const device of this.devices) {
      try { await this.sdk(`${session}/${device}`, "PUT", { effect: "CHROMA_NONE" }); } catch { /* unavailable */ }
    }
    try { await this.sdk(session, "DELETE"); } catch { /* unavailable */ }
  }

  private async pump(): Promise<void> {
    let requestGeneration = this.generation;
    try {
      for (;;) {
        requestGeneration = this.generation;
        if (this.session && this.sessionGeneration !== this.generation) await this.dispose();
        if (!this.enabled) { await this.dispose(); if (!this.enabled) return; }
        if (!this.session) {
          const generation = this.generation;
          const registration = await this.request(this.base.href, "POST", {
            title: "neatroots", description: "Local run status", author: { name: "neatroots", contact: "https://github.com/neatlogs/neatroots" },
            device_supported: this.devices, category: "application",
          });
          if ((registration.result !== undefined && registration.result !== 0) || !Number.isSafeInteger(registration.sessionid)) throw new Error("Invalid registration");
          this.session = this.sessionUrl(registration.uri);
          this.sessionGeneration = generation;
          if (!this.enabled || generation !== this.generation) { await this.dispose(); continue; }
          this.snapshot.phase = "ready";
          this.armHeartbeat();
        }
        if (this.beat) {
          this.beat = false;
          const response = await this.request(`${this.session}/heartbeat`, "PUT");
          if (!Number.isSafeInteger(response.tick) || (response.tick as number) < 0
            || (response.result !== undefined && response.result !== 0)) throw new Error("Invalid heartbeat");
          if (requestGeneration === this.generation) this.armHeartbeat();
          continue;
        }
        if (this.needsFrame()) {
          const frame = this.nextFrame();
          const device = this.devices[frame.next];
          // One device per iteration lets due heartbeat preempt even a slow multi-device frame.
          if (device) { await this.sdk(`${this.session}/${device}`, "PUT", frame.body); frame.next++; }
          continue;
        }
        return;
      }
    } catch {
      const wasEnabled = this.enabled && requestGeneration === this.generation;
      if (requestGeneration === this.generation) this.enabled = false;
      this.clearTimer();
      if (wasEnabled) this.snapshot = { enabled: false, phase: "unavailable", state: "inactive", error: "service-unavailable" };
      await this.dispose();
    }
  }
}
