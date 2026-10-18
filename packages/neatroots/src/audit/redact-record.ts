import { CREDENTIAL_KINDS, redactString, type RedactionHit, type RedactionRule } from "../relay/redact.js";

/** Keep each JSON field's key available to the existing context-sensitive credential rules. */
export function redactRecord(value: unknown, rules: RedactionRule[], hits: RedactionHit[], key?: string): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    if (key !== undefined) {
      const contextual: RedactionHit[] = [];
      const credentialRules = rules.filter((rule) => CREDENTIAL_KINDS.includes(rule.kind) || rule.kind === "custom");
      redactString(JSON.stringify({ [key]: typeof value === "bigint" ? value.toString() : value }), credentialRules, "audit sidecar field", contextual);
      // Named credentials may contain quotes/newlines or be shorter than the regex's minimum.
      // Classify the key with the same prefix-aware rules, without exposing the value in a label.
      if (!contextual.length) {
        const probe: RedactionHit[] = [];
        redactString(JSON.stringify({ [key]: "a".repeat(64) }),
          credentialRules.filter((rule) => rule.keepPrefix && rule.kind !== "custom"), "audit sidecar field", probe);
        if (probe.length) contextual.push({ kind: probe[0].kind, where: "audit sidecar field", sample: "[redacted]" });
      }
      if (contextual.length) {
        hits.push(...contextual);
        // Mask the whole leaf, including escaped suffixes a textual regex might only partly match.
        return `[redacted:${contextual[0].kind}]`;
      }
    }
    return typeof value === "string" ? redactString(value, rules, "audit sidecar string", hits) : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactRecord(item, rules, hits, key));
  if (value && typeof value === "object") {
    const fields = Object.entries(value).map(([field, item]) => ({
      field, item, masked: redactString(field, rules, "audit sidecar key", hits),
    }));
    // Reserve every natural output name before allocating suffixes, including later fields.
    const reserved = new Set(fields.map(({ masked }) => masked));
    const unchanged = new Set(fields.filter(({ field, masked }) => field === masked).map(({ field }) => field));
    const used = new Set<string>();
    return Object.fromEntries(fields.map(({ field, item, masked }) => {
      let name = masked;
      // An unchanged key owns its original name regardless of input order.
      if (used.has(name) || (field !== masked && unchanged.has(masked))) {
        let ordinal = 2;
        do { name = `${masked}#${ordinal++}`; } while (reserved.has(name) || used.has(name));
      }
      used.add(name);
      // fromEntries defines own data properties, so __proto__ never invokes a setter.
      return [name, redactRecord(item, rules, hits, field)];
    }));
  }
  return value;
}
