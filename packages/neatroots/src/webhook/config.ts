export interface WebhookConfig {
  url: string;
  events: ("halt" | "finding")[];
  format: "json" | "slack" | "discord";
}
export class WebhookConfigError extends Error {}
const bad = (): never => { throw new WebhookConfigError("Invalid webhooks: use at most 16 unique HTTP(S) destinations, events halt/finding, and format json/slack/discord"); };
export function parseWebhooks(value: unknown): WebhookConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return bad();
  const urls = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return bad();
    const v = item as Record<string, unknown>;
    if (Object.keys(v).some((k) => !["url", "events", "format"].includes(k))) return bad();
    if (typeof v.url !== "string" || v.url.length > 2048 || !v.url.length) return bad();
    let url: URL;
    try { url = new URL(v.url); } catch { return bad(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return bad();
    if (urls.has(url.href)) return bad();
    urls.add(url.href);
    if (!Array.isArray(v.events) || !v.events.length || v.events.length > 2 ||
        v.events.some((x) => x !== "halt" && x !== "finding") || new Set(v.events).size !== v.events.length) return bad();
    if (v.format !== undefined && (typeof v.format !== "string" || !["json", "slack", "discord"].includes(v.format))) return bad();
    return { url: url.href, events: [...v.events] as WebhookConfig["events"], format: (v.format ?? "json") as WebhookConfig["format"] };
  });
}
export function maskedWebhookUrl(url: string): string {
  try { const u = new URL(url); return u.protocol + "//" + u.hostname + (u.port ? ":" + u.port : "") + "/[redacted]"; }
  catch { return "[invalid destination]"; }
}
