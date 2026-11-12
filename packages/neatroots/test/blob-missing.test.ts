import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missingBlobNotice } from "../src/store/blobs.js";
import { Store } from "../src/store/db.js";
import { log } from "../src/util/log.js";
import { batch, hex, s, span, tmpHome } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function storeWithTwoBigValues() {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  const t = hex(16);
  const kept = "kept" + "k".repeat(100_000);
  // Unique per call: a missing payload is reported once per process, so tests must not share one.
  const lost = "lost" + hex(6) + "l".repeat(60_000);
  st.ingest([batch([span({ traceId: t, name: "big", kind: "tool", attrs: [s("neatlogs.tool.input", kept), s("neatlogs.tool.output", lost), s("n", 3)] })])]);
  const refs = JSON.parse((st.db.prepare("SELECT blobs FROM spans").get() as { blobs: string }).blobs) as string[];
  const lostSha = refs.find((sha) => st.blobs.get(sha)?.startsWith("lost"))!;
  const readFrom = (store: Store, key: string) => (store.batchesForTraces([t])[0].spans[0].attributes.find((a) => a.key === key)!.value as { stringValue: string }).stringValue;
  const read = (key: string) => readFrom(st, key);
  return { st, kept, lost, lostSha, read, readFrom, h };
}

describe("a blob payload that cannot be read", () => {
  it("reads back as a notice that names it, not as an empty string", () => {
    const { st, kept, lost, lostSha, read } = storeWithTwoBigValues();
    expect(read("neatlogs.tool.output")).toHaveLength(lost.length);
    fs.rmSync(path.join(st.dir, "blobs", lostSha.slice(0, 2), lostSha.slice(2)));

    const shown = read("neatlogs.tool.output");
    expect(shown).not.toBe("");
    expect(shown).toBe(missingBlobNotice({ sha: lostSha, len: lost.length }));
    expect(shown).toContain(lostSha.slice(0, 12));
    expect(shown).toContain(String(lost.length));
    // the payload that is still there, and the small value stored inline, are untouched
    expect(read("neatlogs.tool.input")).toBe(kept);
    st.close();
  });

  it("is reported once per payload, not on every read", () => {
    const { st, lostSha, read } = storeWithTwoBigValues();
    fs.rmSync(path.join(st.dir, "blobs", lostSha.slice(0, 2), lostSha.slice(2)));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    read("neatlogs.tool.output");
    read("neatlogs.tool.output");
    read("neatlogs.tool.output");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(lostSha.slice(0, 12));
    st.close();
  });

  it("is reported once per process even when two stores read it", () => {
    const { st, lostSha, read, readFrom } = storeWithTwoBigValues();
    fs.rmSync(path.join(st.dir, "blobs", lostSha.slice(0, 2), lostSha.slice(2)));
    const second = new Store(st.dir);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    read("neatlogs.tool.output");
    readFrom(second, "neatlogs.tool.output");
    readFrom(second, "neatlogs.tool.output");

    expect(warn).toHaveBeenCalledTimes(1);
    second.close();
    st.close();
  });

  it("is not reported when every payload is there", () => {
    const { st, read } = storeWithTwoBigValues();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    read("neatlogs.tool.output");
    read("neatlogs.tool.input");
    expect(warn).not.toHaveBeenCalled();
    st.close();
  });
});
