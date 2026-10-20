import type { WebhookConfig } from "./config.js";
export interface WebhookEvent {
  event: "halt" | "finding" | "test";
  state: "queued" | "delivered" | "raised" | "active" | "test";
  trace_id?: string;
  finding_id?: string;
  note_id?: string;
  check_id?: string;
}
/** User-authored labels, note text and finding params are deliberately not accepted. */
export function webhookPayload(event: WebhookEvent, format: WebhookConfig["format"]): object {
  event = { event: event.event, state: event.state, trace_id: safeId(event.trace_id), finding_id: safeId(event.finding_id), note_id: safeId(event.note_id), check_id: safeId(event.check_id) };
  if (format === "json") return { ...event };
  const message = event.event === "halt"
    ? "neatroots: halt instruction " + event.state + "; this does not confirm the agent stopped."
    : event.event === "finding" ? "neatroots: finding " + event.state + "." : "neatroots: webhook test.";
  const ids = [event.trace_id && "trace " + event.trace_id, event.check_id && "check " + event.check_id].filter(Boolean).join("; ");
  const text = message + (ids ? "\n" + ids : "");
  return format === "slack" ? { text, mrkdwn: false } : { content: text, allowed_mentions: { parse: [] } };
}
export const safeId = (value: string | null | undefined): string | undefined =>
  value && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : undefined;
/** Never follows redirects, reads response text, or includes destinations in an error. */
export async function postWebhook(destination: WebhookConfig, event: WebhookEvent, signal: AbortSignal, timeoutMs = 5000): Promise<"sent" | "retry" | "rejected"> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const response = await fetch(destination.url, {
      method: "POST", redirect: "manual", signal: AbortSignal.any([signal, timeout.signal]),
      headers: { "content-type": "application/json" }, body: JSON.stringify(webhookPayload(event, destination.format)),
    });
    void response.body?.cancel().catch(() => undefined);
    return response.ok ? "sent" : response.status === 429 || response.status >= 500 ? "retry" : "rejected";
  } catch { return signal.aborted ? "rejected" : "retry"; }
  finally { clearTimeout(timer); }
}
