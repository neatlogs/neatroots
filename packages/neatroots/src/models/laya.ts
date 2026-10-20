import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RootsConfig } from "../config.js";
import { log } from "../util/log.js";

/**
 * Runs Laya, an open 421M typed-decision model (Apache-2.0, convaiinnovations/laya), as
 * neatroots' default on-device classifier. neatroots installs it into ~/.neatroots/laya with its own
 * Python environment and serves it with `laya-serve` on 127.0.0.1 only, behind a
 * per-install token. Its API is the Jev typed-decision API (POST /v1/systemone).
 */

export type LayaState = "disabled" | "not_installed" | "installing" | "starting" | "running" | "stopped" | "failed" | "external";

export interface LayaStatus {
  state: LayaState;
  message: string | null;
  progress: number | null;
  url: string | null;
}

export const LAYA_VERSION = "0.4.0";
export const LAYA_MODEL = "typed-decisions";
/** Approximate first-install download: Python packages plus the typed-decisions checkpoint. */
export const LAYA_DOWNLOAD_MB = 1400;

function which(cmd: string): string | undefined {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  const p = r.stdout?.split("\n")[0]?.trim();
  return r.status === 0 && p ? p : undefined;
}

function pythonOk(py: string): boolean {
  const r = spawnSync(py, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]);
  return r.status === 0;
}

export class LayaManager {
  private child?: ChildProcess;
  private status: LayaStatus = { state: "not_installed", message: null, progress: null, url: null };
  private restarts = 0;
  private stopping = false;
  private installing?: Promise<void>;
  readonly dir: string;
  readonly token: string;

  constructor(
    home: string,
    private readonly cfg: RootsConfig["classifier"],
  ) {
    // One Laya install serves every neatroots home on this machine; NEATROOTS_LAYA_DIR moves it.
    this.dir = process.env.NEATROOTS_LAYA_DIR || path.join(home, "laya");
    fs.mkdirSync(this.dir, { recursive: true });
    const tokenFile = path.join(this.dir, "token");
    if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
    this.token = fs.readFileSync(tokenFile, "utf8").trim();
    if (!cfg.laya.enabled) this.status = { state: "disabled", message: "Laya is turned off in settings.", progress: null, url: null };
    else if (this.installed()) this.status = { state: "stopped", message: null, progress: null, url: null };
  }

  get url(): string {
    return `http://127.0.0.1:${this.cfg.laya.port}`;
  }

  get state(): LayaStatus {
    return { ...this.status };
  }

  private set(s: Partial<LayaStatus>): void {
    this.status = { ...this.status, ...s };
  }

  private venvPython(): string {
    return path.join(this.dir, ".venv", "bin", "python");
  }

  private serveBin(): string {
    return path.join(this.dir, ".venv", "bin", "laya-serve");
  }

  installed(): boolean {
    return fs.existsSync(this.serveBin()) && fs.existsSync(path.join(this.dir, "installed-version"));
  }

  /** Whether something already answers the Jev API on Laya's port (e.g. a previous neatroots' Laya). */
  private async answering(): Promise<boolean> {
    try {
      const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Installs (if needed) and starts Laya. Safe to call repeatedly. */
  async ensure(opts: { install?: boolean } = {}): Promise<void> {
    if (!this.cfg.laya.enabled && !opts.install) return;
    if (this.status.state === "running" || this.status.state === "starting") return;
    if (await this.answering()) {
      this.set({ state: "running", message: `Serving on ${this.url}`, url: this.url, progress: null });
      return;
    }
    if (!this.installed()) {
      if (this.cfg.laya.consent !== "yes" && !opts.install) {
        this.set({
          state: "not_installed",
          message:
            this.cfg.laya.consent === "no"
              ? "You chose not to download Laya. Set up Jev cloud for check answers, or download Laya any time."
              : `Not downloaded yet. Download Laya (about ${(LAYA_DOWNLOAD_MB / 1000).toFixed(1)} GB) to answer checks on this machine, or set up Jev cloud instead.`,
          progress: null,
        });
        return;
      }
      this.installing ??= this.install().finally(() => (this.installing = undefined));
      await this.installing;
      if (!this.installed()) return;
    }
    await this.start();
  }

  private run(cmd: string, args: string[], step: string, progress: number): Promise<void> {
    this.set({ state: "installing", message: step, progress });
    log.info(`laya: ${step}`);
    return new Promise((resolve, reject) => {
      const logFile = fs.openSync(path.join(this.dir, "install.log"), "a");
      const p = spawn(cmd, args, { cwd: this.dir, stdio: ["ignore", logFile, logFile], env: { ...process.env, VIRTUAL_ENV: path.join(this.dir, ".venv") } });
      p.on("error", reject);
      p.on("close", (code) => {
        fs.closeSync(logFile);
        if (code === 0) resolve();
        else reject(new Error(`${step} failed (exit ${code}); see ${path.join(this.dir, "install.log")}`));
      });
    });
  }

  private async install(): Promise<void> {
    const venv = path.join(this.dir, ".venv");
    let venvHint = "";
    try {
      // A failed venv or package install is not usable, and both uv and Python refuse to
      // recreate it cleanly on the next attempt.
      if (!this.installed()) fs.rmSync(venv, { recursive: true, force: true });
      const uv = which("uv");
      if (uv) {
        await this.run(uv, ["venv", "--quiet", "--python", "3.12", venv], "Creating Laya's Python environment", 0.05);
        await this.run(uv, ["pip", "install", "--quiet", "--python", this.venvPython(), `laya[serve]==${LAYA_VERSION}`], "Installing Laya and PyTorch (about 0.5 GB)", 0.15);
      } else {
        const py = ["python3.12", "python3.11", "python3.10", "python3"].map(which).find((p) => p && pythonOk(p));
        if (!py) throw new Error("Laya needs Python 3.10 or newer, or uv (https://docs.astral.sh/uv/). Install one and restart neatroots.");
        venvHint = ` Install ${path.basename(py)}-venv (Ubuntu/Debian), or install uv from https://docs.astral.sh/uv/.`;
        await this.run(py, ["-m", "venv", venv], "Creating Laya's Python environment", 0.05);
        await this.run(this.venvPython(), ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], "Updating pip", 0.1);
        await this.run(this.venvPython(), ["-m", "pip", "install", "--quiet", `laya[serve]==${LAYA_VERSION}`], "Installing Laya and PyTorch (about 0.5 GB)", 0.15);
      }
      // Fetch the checkpoint now, so the first check does not wait on an 843 MB download.
      await this.run(
        this.venvPython(),
        ["-c", `import os; os.environ["HF_HOME"]=${JSON.stringify(path.join(this.dir, "hf"))}; from huggingface_hub import snapshot_download; snapshot_download("convaiinnovations/laya", allow_patterns=["${LAYA_MODEL}/*", "*.py", "rl_agent_config.json"])`],
        "Downloading the typed-decisions checkpoint (843 MB)",
        0.6,
      );
      fs.writeFileSync(path.join(this.dir, "installed-version"), LAYA_VERSION);
      this.set({ state: "stopped", message: "Installed", progress: 1 });
    } catch (err) {
      if (!this.installed()) fs.rmSync(venv, { recursive: true, force: true });
      const message = `${(err as Error).message}${(err as Error).message.startsWith("Creating Laya's Python environment failed") ? venvHint : ""}`;
      this.set({ state: "failed", message, progress: null });
      log.warn(`laya install failed: ${message}`);
    }
  }

  private async start(): Promise<void> {
    // Two callers can both get here after one install (Download clicked twice): start one server.
    if (this.child) return;
    this.stopping = false;
    this.set({ state: "starting", message: "Loading the typed-decisions checkpoint", progress: null, url: null });
    const out = fs.openSync(path.join(this.dir, "serve.log"), "a");
    const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
    const child = spawn(this.serveBin(), [], {
      cwd: this.dir,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        LAYA_HOST: "127.0.0.1",
        LAYA_PORT: String(this.cfg.laya.port),
        LAYA_MODELS: LAYA_MODEL,
        LAYA_DEFAULT_MODEL: LAYA_MODEL,
        LAYA_PRELOAD: "1",
        LAYA_MAX_LOADED: "1",
        LAYA_THREADS: String(threads),
        LAYA_API_KEY: this.token,
        LAYA_LOG_LEVEL: "warning",
        HF_HOME: path.join(this.dir, "hf"),
        USE_TF: "0",
        TOKENIZERS_PARALLELISM: "false",
      },
    });
    this.child = child;
    child.on("exit", (code, signal) => {
      fs.closeSync(out);
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopping) {
        this.set({ state: "stopped", message: null, url: null });
        return;
      }
      const tail = this.logTail();
      this.set({ state: "failed", message: `laya-serve exited (${signal ?? code}). ${tail}`, url: null });
      log.warn(`laya-serve exited (${signal ?? code})`);
      if (this.restarts < 3) {
        this.restarts++;
        setTimeout(() => void this.start(), 2000 * this.restarts).unref();
      }
    });
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (this.child !== child) return;
      if (await this.answering()) {
        this.restarts = 0;
        this.set({ state: "running", message: `Serving on ${this.url}`, url: this.url });
        log.info(`laya: running on ${this.url}`);
        return;
      }
    }
    this.set({ state: "failed", message: `laya-serve did not answer within 2 minutes. ${this.logTail()}` });
  }

  private logTail(): string {
    try {
      const text = fs.readFileSync(path.join(this.dir, "serve.log"), "utf8").trim().split("\n");
      return text.slice(-2).join(" ").slice(0, 300);
    } catch {
      return "";
    }
  }

  async restart(): Promise<void> {
    this.stop();
    await new Promise((r) => setTimeout(r, 500));
    this.restarts = 0;
    await this.ensure();
  }

  stop(): void {
    this.stopping = true;
    if (this.child) {
      this.child.kill("SIGTERM");
      const c = this.child;
      setTimeout(() => c.kill("SIGKILL"), 3000).unref();
    }
    this.child = undefined;
    if (this.status.state === "running" || this.status.state === "starting") this.set({ state: "stopped", url: null });
  }
}
