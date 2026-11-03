const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** What `since` accepts, for error messages. */
export const SINCE_FORMS = "30m, 24h, 7d, 2w or a date such as 2026-10-01";

/**
 * A `since` value (30m, 24h, 7d, 2w, or a date) as a start time in ms, or undefined when it is
 * neither. Only a value that starts like a date goes to Date.parse: it reads "30" as the year 2030
 * and "12" as December 2001, so a bare number would turn into a filter nobody asked for.
 */
export function parseSince(v: string, now = Date.now()): number | undefined {
  const m = /^(\d+)\s*([mhdw])$/i.exec(v.trim());
  if (m) {
    // Enough digits make the count Infinity, which would read as "every run".
    const t = now - Number(m[1]) * UNIT_MS[m[2].toLowerCase() as keyof typeof UNIT_MS];
    return Number.isFinite(t) ? t : undefined;
  }
  if (!/^\d{4}-\d{2}/.test(v.trim())) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
