import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { rootsHome } from "../config.js";
import { Store } from "../store/db.js";

// neatroots store: what is on disk. The store is a database plus a tree of payload files beside
// it, and a copy that takes only the database loses every large prompt and output.

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function registerStoreCommands(program: Command): void {
  const store = program.command("store").description("The local store on disk: neatroots.db plus its payload files");

  store
    .command("verify")
    .description("Check the store is readable and whole: SQLite integrity, and every payload a span references")
    .option("--home <dir>", "neatroots home to check (default: the one this machine uses)")
    .action(async (opts: { home?: string }) => {
      const dir = path.join(opts.home ?? rootsHome(), "data");
      if (!fs.existsSync(dir)) {
        console.log(`No store at ${dir}. neatroots creates it on first run.`);
        return;
      }
      let st: Store;
      try {
        st = new Store(dir);
      } catch (err) {
        console.log(`✗ ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      try {
        const r = st.verify();
        console.log(`${r.file}`);
        console.log(`  schema ${r.schema_version ?? "unknown"} · ${r.runs} runs · ${r.spans} spans`);
        console.log(`  sqlite integrity: ${r.quick_check}`);
        console.log(`  payloads: ${r.referenced} referenced, ${r.present} on disk, ${mb(r.present_bytes)}`);
        for (const sha of r.missing) console.log(`  ✗ missing payload ${sha}`);
        for (const sha of r.orphaned) console.log(`  ! payload nothing references: ${sha}`);
        const clean = r.quick_check === "ok" && !r.missing.length;
        console.log(
          clean
            ? `✓ store reads whole${r.orphaned.length ? ` (${r.orphaned.length} unreferenced file(s), harmless)` : ""}`
            : `✗ ${r.missing.length} referenced payload(s) are gone: runs that used them show a missing-payload notice instead of their prompt or output, and forwarding refuses them`,
        );
        if (!clean) process.exitCode = 1;
      } finally {
        st.close();
      }
    });
}
