import type { ChildProcess } from "node:child_process";

/**
 * Reads a CLI child's stdout as JSON lines and keeps the last 4,000 characters of stderr.
 * Both streams use the UTF-8 decoder, so a multibyte character split across pipe reads is
 * buffered instead of becoming U+FFFD (issue #616). Returns a getter for the stderr tail.
 */
export function pipeChild(child: ChildProcess, opts: { active: () => boolean; onEvent: (ev: Record<string, unknown>) => void }): () => string {
  let buf = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    if (!opts.active()) return;
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        opts.onEvent(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* not an event line */
      }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  return () => stderr;
}
