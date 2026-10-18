import type { Roots } from "../core.js";
import type { ReplayOverrides } from "./replay.js";

/** Bound the tool call, not the batch. A timed-out caller can poll or cancel by batch ID. */
export async function batchTool(roots: Roots, trace: string, times: unknown, overrides: ReplayOverrides, timeoutSec = 300) {
  const { batch, done } = roots.replayBatches.start(trace, times, overrides);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([done, new Promise<typeof batch>((resolve) => {
      timer = setTimeout(() => resolve(roots.replayBatches.get(batch.id)!), timeoutSec * 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
