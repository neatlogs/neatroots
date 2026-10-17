// Regular expressions people write (a check's `match` pattern, cloud redaction patterns) run on the
// server's only thread, against every span. A pattern that backtracks catastrophically, such as
// (a+)+, can take minutes on a 30-character input and stall the collector and the app with it, so
// such patterns are refused when they are saved instead of discovered when they hang.
// This catches nested repeats only: overlapping alternatives in a repeat, like (a|aa)+, also
// backtrack badly and still pass, so patterns from checks people write also run under a time
// limit (testWithin).

import vm from "node:vm";

/** A repeat that can match many times: *, + and {n,} or {n,m} with a range. */
function repeatAt(p: string, i: number): number {
  const c = p[i];
  if (c === "*" || c === "+") return i;
  if (c !== "{") return -1;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
  if (!m || m[2] === undefined) return -1; // {n}: an exact count isn't ambiguous
  if (m[3] !== "" && Number(m[3]) <= Number(m[1])) return -1;
  return i + m[0].length - 1;
}

/** Whether a repeated group contains another repeat (star height above 1), e.g. (a+)+ or (\w+\s?)*. */
export function nestedRepeat(p: string): boolean {
  const stack: { repeat: boolean }[] = [{ repeat: false }];
  let closed: { repeat: boolean } | null = null; // the group the previous token closed
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      i++;
      closed = null;
      continue;
    }
    if (c === "[") {
      i++;
      if (p[i] === "^") i++;
      if (p[i] === "]") i++;
      while (i < p.length && p[i] !== "]") i += p[i] === "\\" ? 2 : 1;
      closed = null;
      continue;
    }
    if (c === "(") {
      stack.push({ repeat: false });
      closed = null;
      if (p[i + 1] === "?") {
        i += 2; // past "(?" onto ":", "=", "!" or "<"
        if (p[i] === "<" && p[i + 1] !== "=" && p[i + 1] !== "!") while (i < p.length && p[i] !== ">") i++;
        else if (p[i] === "<") i++;
      }
      continue;
    }
    if (c === ")") {
      const g = stack.length > 1 ? stack.pop()! : { repeat: false };
      stack[stack.length - 1].repeat ||= g.repeat;
      closed = g;
      continue;
    }
    const end = repeatAt(p, i);
    if (end >= 0) {
      if (closed?.repeat) return true;
      stack[stack.length - 1].repeat = true;
      i = end;
      if (p[i + 1] === "?") i++; // lazy
      closed = null;
      continue;
    }
    closed = null;
  }
  return false;
}

/** Why a pattern can't be used, or null when it can. */
export function regexProblem(pattern: string, flags?: string): string | null {
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    return `not a valid regular expression (${(e as Error).message})`;
  }
  if (nestedRepeat(pattern)) return "a repeated group contains another repeat, like (a+)+, which can freeze neatroots on some inputs; rewrite it without the nesting";
  return null;
}

const sandbox = vm.createContext(Object.create(null));
const testScript = new vm.Script("re.lastIndex = 0; re.test(s)");

/**
 * Tests `re` against `s`, giving up after `ms`: a JS regex can't be interrupted from outside, but a
 * vm script with a timeout can. Returns undefined when the time ran out.
 */
export function testWithin(re: RegExp, s: string, ms: number): boolean | undefined {
  sandbox.re = re;
  sandbox.s = s;
  try {
    return testScript.runInContext(sandbox, { timeout: ms }) === true;
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return undefined;
    throw e;
  } finally {
    sandbox.re = undefined;
    sandbox.s = undefined;
  }
}

const replaceScript = new vm.Script("re.lastIndex = 0; s.replace(re, fn)");

/** Like testWithin, for `s.replace(re, fn)`. Returns undefined when the time ran out. */
export function replaceWithin(re: RegExp, s: string, fn: (m: string, ...groups: unknown[]) => string, ms: number): string | undefined {
  sandbox.re = re;
  sandbox.s = s;
  sandbox.fn = fn;
  try {
    return String(replaceScript.runInContext(sandbox, { timeout: ms }));
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return undefined;
    throw e;
  } finally {
    sandbox.re = undefined;
    sandbox.s = undefined;
    sandbox.fn = undefined;
  }
}
