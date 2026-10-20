import fs from "node:fs";
import { STATE } from "./global-setup";

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(STATE)) return;
  const s = JSON.parse(fs.readFileSync(STATE, "utf8")) as { pids: number[]; home: string };
  for (const pid of s.pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  if (!process.env.KEEP_E2E_HOME) fs.rmSync(s.home, { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
}
