import { kvToPlain, type OtlpSpan } from "../otlp/types.js";

/** Response-start timings for an LLM span. Never infer visible text from an empty chunk. */
export function streamTiming(span: OtlpSpan): { firstChunkMs?: number; firstTextMs?: number } {
  const nano = (s: string) => /^\d+$/.test(s) ? BigInt(s) : undefined;
  const start = nano(span.startTimeUnixNano);
  const end = nano(span.endTimeUnixNano);
  if (start === undefined || end === undefined || (end !== 0n && end < start)) return {};
  const duration = end === 0n ? Infinity : Number(end - start) / 1e6;
  const attr = kvToPlain(span.attributes)["gen_ai.response.time_to_first_chunk"];
  let firstChunkMs = typeof attr === "number" && Number.isFinite(attr * 1000) && attr >= 0 && attr * 1000 <= duration ? attr * 1000 : undefined;
  let firstTextMs: number | undefined;
  const chunks = span.events.filter((e) => e.name === "neatlogs.stream.chunk").map((e) => {
    const attrs = kvToPlain(e.attributes);
    return { time: nano(e.timeUnixNano), index: attrs["neatlogs.stream.chunk.index"], summary: attrs["neatlogs.stream.chunk.summary"] };
  }).filter((e) => typeof e.index === "number" && Number.isSafeInteger(e.index) && e.index >= 0)
    .sort((a, b) => Number(a.index) - Number(b.index));
  // A missing or repeated index can hide earlier text. Keep unknown values unknown.
  if (chunks.some((e, i) => i > 0 && e.index === chunks[i - 1].index)) return { firstChunkMs };
  let previous = start;
  for (let i = 0; i < chunks.length; i++) {
    const { time, index, summary: raw } = chunks[i];
    if (index !== i || time === undefined || time < previous || (end !== 0n && time > end)) break;
    previous = time;
    const ms = Number(time - start) / 1e6;
    if (i === 0) firstChunkMs = ms;
    try {
      const summary = typeof raw === "string" ? JSON.parse(raw) : undefined;
      const choices: unknown = summary?.choices;
      if (!Array.isArray(choices) || choices.some((c) => !c || typeof c.content_bytes !== "number" || !Number.isSafeInteger(c.content_bytes) || c.content_bytes < 0)) break;
      if (choices.some((c) => c.content_bytes > 0)) { firstTextMs = ms; break; }
    } catch { break; }
  }
  return { firstChunkMs, firstTextMs };
}
