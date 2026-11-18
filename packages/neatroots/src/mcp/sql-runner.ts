import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** Most rows query_sql returns, and how long one query may run before it is stopped. */
export const SQL_ROW_CAP = 200;
export const SQL_TIMEOUT_MS = 5_000;
const SQL_CELL_CHARS = 2000;

// Runs in a separate Node process that owns its own read-only connection (opened per query and
// closed before it exits, like the in-process connection it replaces). SQLite can't be interrupted from JavaScript, and an aggregate or
// ORDER BY over an unbounded recursive CTE never returns its first row, so stopping after N rows
// isn't enough: the query has to run where it can be killed. The SQL comes in on stdin and the
// rows go back as JSON on stdout.
const CHILD = String.raw`
const [driver, file, cap, cellChars] = process.argv.slice(1);
const Database = require(driver);
const clipCell = (v) => (typeof v === "string" && v.length > +cellChars ? v.slice(0, +cellChars - 1) + "\u2026" : v);
let sql = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (sql += d));
process.stdin.on("end", () => {
  let out;
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const stmt = db.prepare(sql);
      if (!stmt.reader) out = { error: "only queries that return rows are allowed" };
      else {
        const rows = [];
        for (const r of stmt.iterate()) {
          rows.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clipCell(v)])));
          if (rows.length > +cap) break;
        }
        out = { rows };
      }
    } finally {
      db.close();
    }
  } catch (e) {
    out = { error: e && e.message ? e.message : String(e) };
  }
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
});
`;

let driver: string | undefined;

/**
 * Runs one read-only query against the store file in a child process and kills it if it runs
 * past `timeoutMs`, so a runaway query never blocks the server's event loop.
 */
export function runReadonlySql(file: string, sql: string, opts: { timeoutMs?: number } = {}): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const timeoutMs = opts.timeoutMs ?? SQL_TIMEOUT_MS;
  driver ??= createRequire(import.meta.url).resolve("better-sqlite3");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", CHILD, driver!, file, String(SQL_ROW_CAP), String(SQL_CELL_CHARS)], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errText = "";
    let done = false;
    let timedOut = false;
    const kill = () => child.kill("SIGKILL");
    process.once("exit", kill);
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener("exit", kill);
      settle();
    };
    // On timeout, settle once the killed child has exited, so its read-only handle on the store
    // is gone by the time the caller hears back (matters on Windows and for test cleanup).
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (errText += d));
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", () =>
      finish(() => {
        if (timedOut) return reject(new Error(`the query ran longer than ${timeoutMs / 1000}s and was stopped; add a LIMIT inside any recursive CTE, or narrow it with WHERE`));
        let r: { rows?: Record<string, unknown>[]; error?: string };
        try {
          r = JSON.parse(out);
        } catch {
          return reject(new Error(`the query failed: ${errText.trim().split("\n").pop() || "no result"}`));
        }
        if (r.error || !r.rows) return reject(new Error(r.error ?? "the query failed"));
        resolve({ rows: r.rows.slice(0, SQL_ROW_CAP), truncated: r.rows.length > SQL_ROW_CAP });
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(sql);
  });
}
