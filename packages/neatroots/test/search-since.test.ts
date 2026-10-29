import { afterEach, describe, expect, it } from "vitest";
import { parseSince } from "../src/util/since.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

// since: used to accept only h, d and w, and handed anything else to Date.parse. A value it
// couldn't read (30m, 7D, 7days) was dropped, so the search quietly covered every run, and a bare
// number became a year: "30" read as 2030 (nothing matched) and "12" as December 2001.
describe("since values", () => {
  it("reads minutes, hours, days and weeks, in either case", () => {
    expect(parseSince("30m", NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince("24h", NOW)).toBe(NOW - 24 * 3_600_000);
    expect(parseSince("7D", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseSince("2w", NOW)).toBe(NOW - 14 * 86_400_000);
  });

  it("reads dates", () => {
    expect(parseSince("2026-10-01", NOW)).toBe(Date.parse("2026-10-01"));
    expect(parseSince("2026-10-01T08:00:00Z", NOW)).toBe(Date.parse("2026-10-01T08:00:00Z"));
  });

  it("refuses what it can't read instead of guessing a year", () => {
    for (const v of ["", "30", "12", "7days", "1h30m", "yesterday", "2026-13-45", `${"9".repeat(400)}m`]) expect(parseSince(v, NOW), v).toBeUndefined();
  });
});

describe("search with since:", () => {
  it("filters to the window, and refuses a since: it can't read rather than searching every run", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    const ingest = (name: string, agoMs: number) => {
      const traceId = hex(16);
      const root = span({ traceId, name, kind: "workflow" });
      const start = BigInt(Date.now() - agoMs) * 1_000_000n;
      root.startTimeUnixNano = start.toString();
      root.endTimeUnixNano = (start + 5_000_000n).toString();
      t!.roots.ingest([batch([root], "e2e")]);
      return traceId;
    };
    const recent = ingest("recent", 60_000);
    ingest("old", 3 * 3_600_000);

    const search = async (q: string) => {
      const res = await fetch(`${t!.url}/api/search/runs?q=${encodeURIComponent(q)}`);
      return { status: res.status, body: (await res.json()) as { runs?: { trace_id: string }[]; error?: string } };
    };

    const minutes = await search("since:30m");
    expect(minutes.status).toBe(200);
    expect(minutes.body.runs!.map((r) => r.trace_id)).toEqual([recent]);

    for (const q of ["since:30x", "since:30", "since:7days", 'since:""', `since:${"9".repeat(400)}m`]) {
      const bad = await search(q);
      expect(bad.status, q).toBe(400);
      expect(bad.body.error, q).toMatch(/since: takes 30m, 24h, 7d, 2w or a date/);
    }
  });
});
