import { parentPort, workerData } from "node:worker_threads";
import { Store } from "./store/db.js";

const { dir, maxAgeDays, maxBytes, startedMs } = workerData as { dir: string; maxAgeDays: number; maxBytes: number; startedMs: number };
const store = new Store(dir);
try {
  parentPort!.postMessage(store.sweepDetached(maxAgeDays, maxBytes, startedMs));
} finally {
  store.close();
}
