import { log } from "../util/log.js";
import type { AmbientOutput } from "./types.js";

/** Reference output: fixed state and counters only, never project names, prompts or finding text. */
export function logOutput(write: (message: string) => void = log.info): AmbientOutput {
  return { setState: ({ state, active_runs }) => write(`[ambient] ${JSON.stringify({ state, active_runs })}`) };
}
