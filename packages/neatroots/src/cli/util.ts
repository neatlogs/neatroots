import readline from "node:readline";
import { loadConfig, DEFAULT_PORT } from "../config.js";

export function port(opt?: string): number {
  return opt ? Number(opt) : loadConfig().port || DEFAULT_PORT;
}

/** "4s ago", "3m ago", "2h ago", "5d ago". */
export function since(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/**
 * One phrase for whether a steering hook is actually talking to neatroots. `hooks_connected` is the
 * SSE subscriber count, and only the Python hook streams: the TypeScript hook polls and never
 * appears there, so last contact is the number that answers "is my hook wired up".
 */
export function steeringHook(lastSeenMs: number | null, project: string | null, streams: number): string {
  const streamPart = `${streams} streaming client${streams === 1 ? "" : "s"} (Python)`;
  if (!lastSeenMs) return `no steering hook has asked yet (is the hook in place?) · ${streamPart}`;
  return `last hook asked ${since(lastSeenMs)}${project ? ` (${project})` : ""} · ${streamPart}`;
}

export async function api<T = unknown>(p: number, route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://localhost:${p}${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function running(p: number): Promise<boolean> {
  try {
    return (await fetch(`http://localhost:${p}/health`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

export function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    // End of input (Ctrl-D) is no answer, not Enter: callers mustn't take their default from it.
    rl.on("close", () => {
      if (!answered) reject(new Error("no answer given"));
    });
    if (hidden) {
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) write.call(rl, s);
        else write.call(rl, "*".repeat(s.length ? 1 : 0));
      };
    }
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
