/** A named state, shared by outputs; no prompt, tool result or finding payload crosses this seam. */
export type AmbientState = "inactive" | "idle" | "live" | "checking" | "loop" | "error" | "interrupted" | "attention" | "incomplete" | "success";
export type AmbientChecks = "checking" | "settled" | "interrupted" | "unknown";

export interface AmbientSignal {
  state: AmbientState;
  trace_id: string | null;
  project: string | null;
  workflow: string | null;
  active_runs: number;
}

/** An inactive signal must cancel any work the output owns. Stage one has no device/network output. */
export interface AmbientOutput {
  setState(signal: Readonly<AmbientSignal>): void;
}

export interface AmbientConfig {
  /** Global kill switch; each output also needs its own opt-in. */
  enabled: boolean;
  outputs: { log: { enabled: boolean }; chroma?: { enabled: boolean; animation: boolean; devices: import("./chroma-frames.js").ChromaDevice[] } };
}
