import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, guidance } from "../src/index.js";

const firstTrace = "a".repeat(32);
const gateTrace = "b".repeat(32);
const note = { id: "n1", kind: "template", text: "Check the order first.", finding_id: "f1" };
const flush = vi.fn(async () => undefined);
let firstMode = "off";
let firstNote: typeof note | null = null;
const claim = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  return Response.json(body.trace_id === firstTrace ? { mode: firstMode, note: firstNote } : { mode: "gate", note });
});

beforeEach(() => {
  firstMode = "off";
  firstNote = null;
  flush.mockClear();
  claim.mockClear();
  configure({ disabled: false, neatlogs: { flush } });
  vi.stubGlobal("fetch", claim);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("steering mode belongs to its trace", () => {
  it.each(["off", "advisory", "self-check"])("resolves and flushes a new run after a %s run", async (mode) => {
    firstMode = mode;
    expect(await guidance(firstTrace)).toBeUndefined();
    expect(await guidance(gateTrace)).toEqual(note);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(claim.mock.calls[1][1]?.body))).toMatchObject({ trace_id: gateTrace, gate_ms: 300 });
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("still claims halt notes after learning that steering is off", async () => {
    await guidance(firstTrace);
    firstNote = { ...note, kind: "halt", text: "Stop now." };
    await expect(guidance(firstTrace)).rejects.toThrow("Stop now.");
    expect(claim).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("clears the cached trace when reconfigured", async () => {
    await guidance(firstTrace);
    configure({});
    await guidance(firstTrace);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
