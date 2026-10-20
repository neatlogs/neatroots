import type { Command } from "commander";
import path from "node:path";
import { api, ask, port } from "./util.js";

type Result = { seq: number; head: string; directory?: string; path?: string; ok?: boolean;
  errors?: string[]; preview_token?: string; redactions?: { kind: string; where: string; sample: string }[] };
const head = (r: Result) => console.log(`seq ${r.seq}\nhead ${r.head}`);

export function registerAuditCommands(program: Command): void {
  const audit = program.command("audit").description("Local plaintext audit archives: status, export and verify");
  audit.command("status").description("Show local audit coverage, held runs and archive failures")
    .option("-p, --port <port>")
    .action(async (opts) => {
      const status = await api<Record<string, unknown>>(port(opts.port), "/api/audit/status");
      console.log(JSON.stringify(status, null, 2));
    });
  audit.command("export").argument("<traceId>")
    .description("Archive the original run, or explicitly create a redacted share copy")
    .option("--directory <directory>", "configured archive directory (default: neatroots home/audit)")
    .option("--redacted", "redact a copy of the latest archived version using cloud redaction rules")
    .option("-o, --output <directory>", "separate archive directory for a redacted share copy")
    .option("--preview", "only preview redactions; write nothing")
    .option("-y, --yes", "accept the displayed redaction preview")
    .option("-p, --port <port>")
    .action(async (traceId: string, opts) => {
      if (opts.preview && !opts.redacted) throw new Error("--preview requires --redacted");
      const p = port(opts.port);
      const request = { trace_id: traceId, directory: opts.directory === undefined ? undefined : path.resolve(opts.directory),
        redacted: opts.redacted, output: opts.output === undefined ? undefined : path.resolve(opts.output), preview: opts.preview };
      let preview_token: string | undefined;
      if (opts.redacted) {
        const preview = await api<Result>(p, "/api/audit/export", { method: "POST", body: JSON.stringify({ ...request, preview: true }) });
        for (const hit of preview.redactions ?? []) console.log(`redacting ${hit.kind}: ${hit.sample} in ${hit.where}`);
        head(preview);
        if (opts.preview) return;
        if (!opts.output) throw new Error("--redacted requires --output <separate directory>");
        if (!opts.yes && (await ask("Write this redacted share copy? [y/N] ")).toLowerCase() !== "y") return;
        preview_token = preview.preview_token;
      }
      const result = await api<Result>(p, "/api/audit/export", { method: "POST", body: JSON.stringify({ ...request, preview: false, preview_token }) });
      console.log(`${opts.redacted ? "redacted share copy" : "original archive"}: ${result.directory}/${result.path}`);
      head(result);
    });
  audit.command("verify").description("Verify exact archive bytes and chain; writes nothing")
    .option("--directory <directory>", "configured archive directory (default: neatroots home/audit)")
    .option("--expect-head <hash>", "externally retained head, detecting truncated or rewritten history")
    .option("-p, --port <port>")
    .action(async (opts) => {
      const result = await api<Result>(port(opts.port), "/api/audit/verify", { method: "POST", body: JSON.stringify({
        directory: opts.directory === undefined ? undefined : path.resolve(opts.directory), expect_head: opts.expectHead,
      }) });
      console.log(result.ok ? "archive verified" : "archive verification failed");
      for (const error of result.errors ?? []) console.log(error);
      head(result);
      if (!result.ok) process.exitCode = 1;
    });
}
