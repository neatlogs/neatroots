import { CREDENTIAL_KINDS, redactString, type RedactionHit, type RedactionRule } from "../relay/redact.js";

/** Keep each JSON field's key available to the existing context-sensitive credential rules. */
export function redactRecord(value: unknown, rules: RedactionRule[], hits: RedactionHit[], key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined) {
      const contextual: RedactionHit[] = [];
      const credentialRules = rules.filter((rule) => CREDENTIAL_KINDS.includes(rule.kind) || rule.kind === "custom");
      redactString(JSON.stringify({ [key]: value }), credentialRules, "audit sidecar field", contextual);
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
    return redactString(value, rules, "audit sidecar string", hits);
  }
  if (Array.isArray(value)) return value.map((item) => redactRecord(item, rules, hits, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, item]) => [
    redactString(field, rules, "audit sidecar key", hits), redactRecord(item, rules, hits, field),
  ]));
  return value;
}
