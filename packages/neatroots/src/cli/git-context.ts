import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import { api, port, running } from "./util.js";

const exec = promisify(execFile);

export interface GitContext {
  commit: string;
  branch?: string | null;
  observed_at: string;
  dirty: boolean;
}

export async function readGitContext(repo: string, includeBranch = false): Promise<GitContext> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const deadline = Date.now() + 10_000;
  const git = async (...args: string[]): Promise<string> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("git context read timed out");
    try {
      const { stdout } = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repo, ...args], {
        env, encoding: "utf8", timeout: Math.min(3000, remaining), killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
      return args[0] === "status" ? stdout : stdout.trim();
    } catch (error) {
      if ((error as { killed?: boolean }).killed) throw new Error("git context read timed out; no note was added");
      throw new Error("could not read git context: choose a git checkout with a commit using --repo");
    }
  };
  const commit = await git("rev-parse", "--verify", "HEAD");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("git returned an invalid commit id");
  const branch = includeBranch ? await git("rev-parse", "--abbrev-ref", "HEAD") : undefined;
  if (branch !== undefined && (!branch || /[\x00-\x20\x7f]/.test(branch))) throw new Error("git returned an invalid branch; no note was added");
  const status = await git("status", "--porcelain=v1", "--untracked-files=normal");
  if (status && !status.trimEnd().split("\n").every((line) => /^[ MADRCUT?!]{2} .+$/.test(line))) {
    throw new Error("git returned an invalid status; no note was added");
  }
  const dirty = status.length > 0;
  if (await git("rev-parse", "--verify", "HEAD") !== commit) throw new Error("git HEAD changed while reading context; try again");
  return { commit, ...(includeBranch ? { branch: branch === "HEAD" ? null : branch } : {}), dirty, observed_at: new Date().toISOString() };
}

export function registerGitContextCommand(program: Command): void {
  program.command("annotate-git")
    .argument("<trace-id>")
    .requiredOption("--repo <path>", "checkout whose current git context to attach")
    .option("--include-branch", "include the branch name, which may contain private project or ticket details")
    .description("Note the checkout at annotation time, not run provenance; no git tags are created")
    .action(async (traceId: string, opts: { repo: string; includeBranch?: boolean }) => {
      const context = await readGitContext(opts.repo, opts.includeBranch);
      const p = port();
      if (!(await running(p))) throw new Error(`neatroots isn't running on port ${p}. Start it first: neatroots start`);
      await api(p, `/api/runs/${encodeURIComponent(traceId)}`);
      await api(p, "/api/annotations", {
        method: "POST",
        body: JSON.stringify({ trace_id: traceId, require_run: true, label: "note", author: "user", text: `Git checkout at annotation time (not run provenance):\n${JSON.stringify(context)}` }),
      });
      console.log(`added current git context to run ${traceId}`);
    });
}
