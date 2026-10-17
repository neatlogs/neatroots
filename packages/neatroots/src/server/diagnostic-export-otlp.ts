import { randomBytes } from "node:crypto";
import type { DiagnosticRedactionBudget } from "./diagnostic-export-budget.js";
import { redactString, type RedactionRule } from "../relay/redact.js";

const SPAN = "bundle.trace.resourceSpans[].scopeSpans[].spans[]";
const ATTRIBUTE_ROOTS = [
  "bundle.trace.resourceSpans[].resource", "bundle.trace.resourceSpans[].scopeSpans[].scope",
  SPAN, `${SPAN}.events[]`, `${SPAN}.links[]`,
];

/** Exact bundle schema positions, never a property-name exemption inside user data. */
export function otlpScalar(path: string): "trace" | "span" | "nanos" | "int" | "bytes" | undefined {
  const p = path.replace(/\[\d+\]/g, "[]");
  if ([`${SPAN}.traceId`, `${SPAN}.links[].traceId`, "bundle.run.trace_id"].includes(p)) return "trace";
  if ([`${SPAN}.spanId`, `${SPAN}.parentSpanId`, `${SPAN}.links[].spanId`, "bundle.run.root_span_id",
    "bundle.findings[].evidence_span_ids[]", "bundle.findings[].detail.span_id", "bundle.findings[].detail.occurrences[]",
    "bundle.findings[].explanation.evidence_span_ids[]", "bundle.checks.decisions[].span_id"].includes(p)) return "span";
  if ([`${SPAN}.startTimeUnixNano`, `${SPAN}.endTimeUnixNano`, `${SPAN}.events[].timeUnixNano`].includes(p)) return "nanos";
  for (const root of ATTRIBUTE_ROOTS) {
    if (!p.startsWith(`${root}.attributes[].value`)) continue;
    const tail = p.slice(`${root}.attributes[].value`.length);
    if (/^(?:\.arrayValue\.values\[\]|\.kvlistValue\.values\[\]\.value)*\.intValue$/.test(tail)) return "int";
    if (/^(?:\.arrayValue\.values\[\]|\.kvlistValue\.values\[\]\.value)*\.bytesValue$/.test(tail)) return "bytes";
  }
  return undefined;
}

/** Matching identities use random fixed-width aliases, no original-value lookup in the bundle.
 * Matching integers use zero; this sacrifices timing/value fidelity instead of OTLP validity. */
export class DiagnosticOtlpScalars {
  private occupied = new Set<string>();
  private traces = new Map<string, string>();
  private spans = new Map<string, string>();

  constructor(bundle: unknown, private rules: RedactionRule[], private budget: DiagnosticRedactionBudget) {
    // Reserve all original typed IDs before generating aliases, including later references.
    const visit = (value: unknown, path: string, depth: number) => {
      budget.node(depth);
      if (typeof value === "string") {
        const type = otlpScalar(path);
        if (type === "trace" || type === "span") this.occupied.add(value);
      } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`, depth + 1);
    };
    visit(bundle, "bundle", 0);
  }

  redact(path: string, value: string): string | undefined {
    const type = otlpScalar(path);
    if (!type) return undefined;
    if (type === "trace" || type === "span") {
      if (value === "") return ""; // absent parent/link identity remains absent
      const aliases = type === "trace" ? this.traces : this.spans;
      const prior = aliases.get(value);
      const size = type === "trace" ? 16 : 8;
      const valid = new RegExp(`^[a-f0-9]{${size * 2}}$`).test(value) && !/^0+$/.test(value);
      const redacted = redactString(value, this.rules, "", [], this.budget);
      if (prior) return prior;
      if (valid && redacted === value) return value;
      let alias: string;
      do { alias = randomBytes(size).toString("hex"); } while (this.occupied.has(alias) || /^0+$/.test(alias));
      this.occupied.add(alias); aliases.set(value, alias);
      return alias;
    }
    if (type === "bytes") {
      const bytes = Buffer.from(value, "base64");
      if (bytes.toString("base64") !== value) return "";
      // Preserve encoded-string privacy as well as decoded-text privacy; both passes
      // consume the same bounded work/match budget and always return valid base64.
      if (redactString(value, this.rules, "", [], this.budget) !== value) return "";
      const text = bytes.toString("utf8");
      if (Buffer.from(text, "utf8").equals(bytes)) {
        return Buffer.from(redactString(text, this.rules, "", [], this.budget), "utf8").toString("base64");
      }
      return value;
    }
    const redacted = redactString(value, this.rules, "", [], this.budget);
    if (redacted !== value || !/^-?\d+$/.test(value)) return "0";
    if (type === "nanos" && !/^\d+$/.test(value)) return "0";
    if (value.length > (type === "nanos" ? 20 : 21)) return "0";
    const n = BigInt(value);
    const valid = type === "nanos" ? n >= 0n && n <= (1n << 64n) - 1n : n >= -(1n << 63n) && n <= (1n << 63n) - 1n;
    return valid ? value : "0";
  }
}
