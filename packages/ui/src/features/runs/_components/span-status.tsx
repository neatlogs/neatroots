import { StatusPill } from "@/components/ui/status-pill";
import type { Span } from "@/lib/api";

/** Call presentation only; never changes the stored span or run status. */
export function spanState(span: Pick<Span, "status_code" | "error" | "span_kind" | "stream_cancelled">) {
  if (span.status_code === 2 || span.error) return "Failed";
  if (span.span_kind === "LLM" && span.stream_cancelled === true) return "Abandoned";
  return undefined;
}

/** Display a failure or abandonment label without changing recorded status. */
export function SpanStatus({ span }: { span: Parameters<typeof spanState>[0] }) {
  const state = spanState(span);
  return state ? <StatusPill className="shrink-0" size="sm" tone={state === "Failed" ? "danger" : "warning"}>{state}</StatusPill> : null;
}
