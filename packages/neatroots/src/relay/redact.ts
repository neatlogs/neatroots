import type { AnyValue, KeyValue, ResourceSpansBatch } from "../otlp/types.js";
import { replaceWithin } from "../util/regex.js";

export interface RedactionRule {
  kind: string;
  re: RegExp;
  /** The pattern's first group is a label to keep readable ("Bearer ", "postgres://user:"). */
  keepPrefix?: boolean;
  /** A pattern someone wrote: it runs under a time limit, since a regex can backtrack for minutes. */
  timed?: boolean;
}

/**
 * A saved redaction pattern can't be applied. Redaction fails closed: whatever was about to leave
 * the machine isn't sent, so data the pattern should remove never goes out unredacted.
 */
export class RedactionPatternError extends Error {}

/** How long one saved pattern may run on one value. */
const PATTERN_MS = 100;

export const BUILTIN_RULES: RedactionRule[] = [
  // Up to its END line, or to the end of the value: prompts and SDK attributes are often clipped
  // before the END line, and the key body must not go out just because its end was cut off.
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  {
    kind: "api_key",
    re: /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|ya29\.[A-Za-z0-9_-]{20,}|nlsa_[A-Za-z0-9_-]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g,
  },
  // Tied to the header name, so a plain hex key counts too.
  { kind: "api_key", re: /\b(x-api-key\\?["']?\s*[:=]\s*\\?["']?)[A-Za-z0-9_-]{16,}/gi, keepPrefix: true },
  { kind: "slack_webhook", re: /\b(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9/_-]{20,}/g, keepPrefix: true },
  // Azure storage and Service Bus / Event Hubs connection strings.
  { kind: "azure_key", re: /\b((?:AccountKey|SharedAccessKey)=)[A-Za-z0-9+/]{40,}={0,2}/g, keepPrefix: true },
  { kind: "bearer_token", re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, keepPrefix: true },
  // Matches start only where the run of token characters starts (a lookbehind, not \b), so a long
  // run of "a." or "eyJ-" is scanned once instead of from every word boundary.
  { kind: "jwt", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // The header's scheme is "Basic" (or any case after "Authorization:"). The value is base64 of
  // user:password, so it has upper and lower case letters and a digit, + or /, doesn't start with
  // a path's "/", and is a whole token: "basic /usr/lib/python3.11" and "Basic authentication1234" aren't.
  { kind: "basic_auth", re: /\b(Basic\s+)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+][A-Za-z0-9+/]{15,}={0,2}(?![A-Za-z0-9+/_-])/g, keepPrefix: true },
  // Tied to the header, so any base64 token counts, even a short default like admin:admin. The
  // quotes may be JSON-escaped (\") when the header sits inside a string attribute.
  { kind: "basic_auth", re: /\b(authorization\\?["']?\s*[:=]\s*\\?["']?basic\s+)[A-Za-z0-9+][A-Za-z0-9+/]{3,}={0,2}(?![A-Za-z0-9+/_-])/gi, keepPrefix: true },
  // The whole value, so a longer one isn't left half visible.
  // AWS secret keys and session tokens, as config keys, JSON (SecretAccessKey) or SDK options (secretAccessKey).
  { kind: "aws_secret", re: /((?:aws_secret_access_key|secret_?access_?key|aws_session_token|session_?token)\\?["']?\s*[=:]\s*\\?["']?)[A-Za-z0-9/+=]{40,}/gi, keepPrefix: true },
  // A password or client secret given as a JSON field (the key names it, so any value counts).
  { kind: "password", re: /(\\?["'](?:password|passwd|pwd|client_secret|api_secret)\\?["']\s*:\s*\\?["'])[^"'\\\r\n]{4,}/gi, keepPrefix: true },
  // Before email, which would otherwise take "password@host" as an address (and miss it for a dotless
  // host). ? and # can't appear unencoded in userinfo, so "host:443?email=a@b.com" is a port and a query.
  { kind: "url_password", re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/?#]+(?=@)/gi, keepPrefix: true },
  { kind: "email", re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // A trailing "." ends a sentence ("call 415-555-0199."); only ".<digit>" continues a longer number.
  { kind: "phone", re: /(?<![\w.])\+?(?:\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\w|\.\d)/g },
];

/** Credentials, as opposed to personal data: the hosted LLM always has these removed. */
export const CREDENTIAL_KINDS = ["private_key", "api_key", "bearer_token", "jwt", "basic_auth", "aws_secret", "url_password", "slack_webhook", "azure_key", "password"];

/**
 * The built-in rules plus the user's saved patterns. A saved pattern that doesn't compile throws
 * (nothing is sent); one that compiles runs with a time limit, including patterns saved before
 * the app started refusing nested repeats, which keep redacting as they did.
 */
export function compileRules(userPatterns: string[]): RedactionRule[] {
  const user: RedactionRule[] = [];
  for (const p of userPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, "g");
    } catch (e) {
      throw new RedactionPatternError(`redaction pattern ${JSON.stringify(p)} isn't a valid regular expression (${(e as Error).message}), so nothing was sent. Fix or remove it in Settings → Cloud.`);
    }
    user.push({ kind: "custom", re, timed: true });
  }
  return [...BUILTIN_RULES, ...user];
}

export interface RedactionHit {
  kind: string;
  where: string;
  sample: string;
}

function mask(s: string): string {
  if (s.length <= 6) return "•".repeat(s.length);
  return s.slice(0, 3) + "•".repeat(Math.min(12, s.length - 5)) + s.slice(-2);
}

export function redactString(s: string, rules: RedactionRule[], where: string, hits: RedactionHit[]): string {
  let out = s;
  for (const r of rules) {
    r.re.lastIndex = 0;
    const replace = (m: string, ...groups: unknown[]): string => {
      // Keep a captured label ("Bearer ", "postgres://user:") readable; only the secret is masked.
      const prefix = r.keepPrefix && typeof groups[0] === "string" ? (groups[0] as string) : "";
      hits.push({ kind: r.kind, where, sample: mask(m) });
      return `${prefix}[redacted:${r.kind}]`;
    };
    if (!r.timed) {
      out = out.replace(r.re, replace);
      continue;
    }
    const next = replaceWithin(r.re, out, replace, PATTERN_MS);
    if (next === undefined) {
      throw new RedactionPatternError(`redaction pattern ${JSON.stringify(r.re.source)} took longer than ${PATTERN_MS} ms on one value, so nothing was sent. Simplify it in Settings → Cloud.`);
    }
    out = next;
  }
  return out;
}

function redactValue(v: AnyValue, rules: RedactionRule[], where: string, hits: RedactionHit[]): AnyValue {
  if ("stringValue" in v) return { stringValue: redactString(v.stringValue, rules, where, hits) };
  if ("bytesValue" in v) {
    const bytes = Buffer.from(v.bytesValue, "base64");
    const text = bytes.toString("utf8");
    // OTLP bytes may contain arbitrary binary data. Only inspect canonical UTF-8 so decoding can
    // never replace invalid sequences or otherwise change bytes that are not actually text.
    if (!Buffer.from(text, "utf8").equals(bytes)) return v;
    const redacted = redactString(text, rules, where, hits);
    return redacted === text ? v : { bytesValue: Buffer.from(redacted, "utf8").toString("base64") };
  }
  if ("arrayValue" in v) return { arrayValue: { values: v.arrayValue.values.map((x) => redactValue(x, rules, where, hits)) } };
  if ("kvlistValue" in v) return { kvlistValue: { values: redactKvs(v.kvlistValue.values, rules, where, hits) } };
  return v;
}

function redactKvs(kvs: KeyValue[], rules: RedactionRule[], where: string, hits: RedactionHit[]): KeyValue[] {
  return kvs.map((kv) => ({ key: kv.key, value: redactValue(kv.value, rules, `${where} ${kv.key}`, hits) }));
}

/** Returns redacted copies of the batches and every redaction made. */
export function redactBatches(batches: ResourceSpansBatch[], rules: RedactionRule[]): { batches: ResourceSpansBatch[]; hits: RedactionHit[] } {
  const hits: RedactionHit[] = [];
  const out = batches.map((b) => ({
    resource: { ...b.resource, attributes: redactKvs(b.resource.attributes, rules, "resource", hits) },
    scope: {
      ...b.scope,
      ...(b.scope.name ? { name: redactString(b.scope.name, rules, "scope name", hits) } : {}),
      ...(b.scope.attributes ? { attributes: redactKvs(b.scope.attributes, rules, "scope", hits) } : {}),
    },
    spans: b.spans.map((s) => {
      // Span and event names often carry a URL or a tool argument, so they are redacted too,
      // and the hit labels use the redacted name so a preview never echoes the raw value.
      const name = redactString(s.name, rules, `span name [${s.spanId.slice(0, 6)}]`, hits);
      return {
        ...s,
        name,
        attributes: redactKvs(s.attributes, rules, `${name} [${s.spanId.slice(0, 6)}]`, hits),
        events: s.events.map((e) => {
          const eventName = redactString(e.name, rules, `${name} event name`, hits);
          return { ...e, name: eventName, attributes: redactKvs(e.attributes, rules, `${name} event ${eventName}`, hits) };
        }),
        links: s.links.map((l) => ({ ...l, attributes: redactKvs(l.attributes, rules, `${name} link`, hits) })),
        status: s.status.message ? { ...s.status, message: redactString(s.status.message, rules, `${name} status`, hits) } : s.status,
      };
    }),
  }));
  return { batches: out, hits };
}
