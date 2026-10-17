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

/** Exact decimal/ProtoJSON exponent conversion. Exponents are bounded by input length
 * before parsing; append at most 19 zeros, never expand an attacker-sized exponent. */
function canonicalInteger(value: string, unsigned: boolean): string | undefined {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!parts) return undefined;
  const fraction = parts[3] ?? "";
  let digits = (parts[2] + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  if (unsigned && parts[1]) return undefined;
  const exponent = parts[4] ?? "0";
  const magnitudeText = exponent.replace(/^[+-]/, "").replace(/^0+/, "") || "0";
  const maxScale = value.length + 20;
  if (magnitudeText.length > String(maxScale).length) return undefined;
  const magnitude = Number(magnitudeText);
  if (magnitude > maxScale) return undefined;
  const scale = (exponent.startsWith("-") ? -magnitude : magnitude) - fraction.length;
  if (scale < 0) {
    const cut = -scale;
    if (cut >= digits.length || /[1-9]/.test(digits.slice(-cut))) return undefined;
    digits = digits.slice(0, -cut);
  } else {
    if (digits.length + scale > 20) return undefined;
    digits += "0".repeat(scale);
  }
  const bound = unsigned ? "18446744073709551615" : parts[1] ? "9223372036854775808" : "9223372036854775807";
  if (digits.length > bound.length || (digits.length === bound.length && digits > bound)) return undefined;
  return parts[1] + digits;
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
      const canonical = bytes.toString("base64");
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      // ProtoJSON accepts standard/URL-safe alphabets, with or without padding.
      // Validate spelling and pad bits rather than relying on Node's permissive decoder.
      if (!/^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}(?:==)?|[A-Za-z0-9+/_-]{3}=?)?$/.test(value)
        || normalized.replace(/=+$/, "") !== canonical.replace(/=+$/, "")) return "";
      // Preserve encoded-string privacy as well as decoded-text privacy; both passes
      // consume the same bounded work/match budget and always return valid base64.
      if (redactString(value, this.rules, "", [], this.budget) !== value) return "";
      if (canonical !== value && redactString(canonical, this.rules, "", [], this.budget) !== canonical) return "";
      const text = bytes.toString("utf8");
      if (Buffer.from(text, "utf8").equals(bytes)) {
        return Buffer.from(redactString(text, this.rules, "", [], this.budget), "utf8").toString("base64");
      }
      return canonical;
    }
    const redacted = redactString(value, this.rules, "", [], this.budget);
    if (redacted !== value) return "0";
    const canonical = canonicalInteger(value, type === "nanos");
    if (canonical === undefined) return "0";
    if (canonical !== value && redactString(canonical, this.rules, "", [], this.budget) !== canonical) return "0";
    return canonical;
  }
}
