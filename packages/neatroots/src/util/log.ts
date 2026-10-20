const DEBUG = !!process.env.NEATROOTS_DEBUG;
let quiet = false;

export function setQuiet(q: boolean): void {
  quiet = q;
}

export const log = {
  info: (...a: unknown[]) => {
    if (!quiet) console.error("[neatroots]", ...a);
  },
  warn: (...a: unknown[]) => {
    if (!quiet) console.error("[neatroots] warn:", ...a);
  },
  error: (...a: unknown[]) => console.error("[neatroots] error:", ...a),
  debug: (...a: unknown[]) => {
    if (DEBUG) console.error("[neatroots] debug:", ...a);
  },
};
