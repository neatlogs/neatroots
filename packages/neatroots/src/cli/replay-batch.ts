import type { BatchSummary } from "../replay/batches.js";
import { repeatCount } from "../replay/batches.js";
import { api } from "./util.js";

export function cliRepeatCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("times must be an integer from 1 to 20");
  return repeatCount(Number(value));
}

export async function runBatch(port: number, trace: string, times: number, overrides: object): Promise<void> {
  let batch = await api<BatchSummary>(port, `/api/runs/${trace}/replay`, {
    method: "POST", body: JSON.stringify({ ...overrides, times }),
  });
  console.log(`Batch ${batch.id}; Ctrl+C cancels remaining repeats (active work may finish).`);
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    if (cancellation) {
      console.error(`Stopped waiting for batch ${batch.id}; active server work may continue. Status: http://localhost:${port}/api/replay-batches/${batch.id}`);
      process.exit(130); // Do not await a stalled cancellation or status request.
    }
    console.error("Cancelling remaining repeats; active work may finish. Press Ctrl+C again to stop waiting.");
    cancellation = api(port, `/api/replay-batches/${batch.id}/cancel`, { method: "POST" }).catch((e: Error) => {
      console.error(`Could not cancel ${batch.id}: ${e.message}`);
    });
  };
  process.on("SIGINT", cancel);
  try {
    while (batch.state === "running" || batch.state === "cancelling") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      batch = await api(port, `/api/replay-batches/${batch.id}`);
    }
    console.log(`Replayed ${batch.times} requested times (sequential), ${batch.linked}/${batch.times} linked; ${batch.state}`);
    for (const f of batch.findings) console.log(`  ${f.check_id}  ${f.count}/${batch.settled} settled (original run: ${f.original ? "yes" : "no"})`);
    console.log(`  clean runs ${batch.clean}/${batch.settled} settled; pending ${batch.pending}, execution failures ${batch.execution_failed}, check failures ${batch.evaluation_failed}, unlinked ${batch.unlinked}, cancelled ${batch.cancelled}`);
    console.log(`Refresh: GET /api/replay-batches/${batch.id}`);
  } finally {
    process.off("SIGINT", cancel);
    await cancellation;
  }
}
