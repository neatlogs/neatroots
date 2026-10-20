import { AiBrain01Icon, CircleIcon, DatabaseIcon, FlashIcon, GitForkIcon, Robot01Icon, Shield01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useMemo } from "react";
import { Icon } from "@/components/ui/icon";
import type { Span } from "@/lib/api";
import { dur } from "@/lib/format";
import { cn } from "@/lib/utils";

export const KIND_ICON: Record<string, IconSvgElement> = {
  WORKFLOW: GitForkIcon,
  CHAIN: GitForkIcon,
  TASK: GitForkIcon,
  AGENT: Robot01Icon,
  LLM: AiBrain01Icon,
  TOOL: Wrench01Icon,
  MCP_TOOL: Wrench01Icon,
  RETRIEVER: DatabaseIcon,
  EMBEDDING: DatabaseIcon,
  VECTOR_STORE: DatabaseIcon,
  GUARDRAIL: Shield01Icon,
};

export const isGuidance = (s: Span) => s.name === "neatroots.guidance" || s.name === "roots.guidance";

export function treeOrder(spans: Span[]): { span: Span; depth: number }[] {
  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string | null, Span[]>();
  for (const s of spans) {
    const parent = s.parent_span_id && ids.has(s.parent_span_id) ? s.parent_span_id : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  for (const list of children.values()) list.sort((a, b) => a.start_ms - b.start_ms);
  // Parent links come from outside and can loop: each span appears once, and spans in a loop (no
  // root reaches them) are shown at the top level instead of disappearing.
  const out: { span: Span; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      if (seen.has(s.span_id)) continue;
      seen.add(s.span_id);
      out.push({ span: s, depth });
      walk(s.span_id, depth + 1);
    }
  };
  walk(null, 0);
  for (const s of [...spans].sort((a, b) => a.start_ms - b.start_ms)) if (!seen.has(s.span_id)) walk(s.parent_span_id, 0);
  return out;
}

/**
 * The run's steps as a tree, like the Neatlogs trace view: kind, name, a small timing bar and
 * the duration. Fills its box and scrolls; a dot marks evidence for an open problem.
 */
export function TraceTree({ spans, flagged, selected, onSelect }: { spans: Span[]; flagged: Set<string>; selected?: string; onSelect: (id: string) => void }) {
  const rows = useMemo(() => treeOrder(spans), [spans]);
  const start = Math.min(...spans.map((s) => s.start_ms));
  const end = Math.max(...spans.map((s) => s.end_ms), start + 1);
  const total = end - start;
  if (!rows.length) return <p className="px-6 py-4 text-sm text-muted-foreground">Spans appear here as the agent runs.</p>;
  return (
    <div role="tree" aria-label="Trace spans" className="h-full overflow-y-auto py-1">
      {rows.map(({ span: s, depth }) => {
        const failed = s.status_code === 2;
        const guidance = isGuidance(s);
        const isSel = selected === s.span_id;
        const left = ((s.start_ms - start) / total) * 100;
        const width = Math.max(1.5, (s.duration_ms / total) * 100);
        return (
          <div
            key={s.span_id}
            role="treeitem"
            aria-selected={isSel}
            aria-level={depth + 1}
            tabIndex={0}
            onClick={() => onSelect(s.span_id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(s.span_id))}
            className={cn(
              "grid h-9 cursor-pointer grid-cols-[minmax(0,1fr)_6rem_4.5rem] items-center gap-3 px-6 transition-colors focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset",
              isSel ? "bg-surface-active" : "hover:bg-surface-subtle",
            )}
          >
            <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 18 }}>
              {depth > 0 && <span aria-hidden className="-ml-3 h-9 w-px shrink-0 bg-border" />}
              <Icon
                icon={guidance ? FlashIcon : (KIND_ICON[s.span_kind] ?? CircleIcon)}
                size="sm"
                className={cn("shrink-0", guidance ? "text-brand-violet" : failed ? "text-danger-fg" : "text-muted-foreground")}
              />
              <span className={cn("truncate text-sm", guidance ? "text-brand-violet" : failed ? "text-danger-fg" : "text-foreground")}>
                {guidance ? `Note to the agent: ${s.input_preview ?? ""}` : (s.tool_name ?? s.name)}
              </span>
              {!guidance && <span className="shrink-0 text-eyebrow text-2xs text-muted-foreground">{s.span_kind.toLowerCase().replace("_", " ")}</span>}
              {flagged.has(s.span_id) && <span role="img" aria-label="Evidence for an open problem" className="size-1.5 shrink-0 rounded-full bg-warning-fg" />}
            </span>
            <span aria-hidden className="relative h-1.5 rounded-full bg-muted">
              <span className={cn("absolute inset-y-0 rounded-full", failed ? "bg-danger-fg" : guidance ? "bg-brand-violet" : "bg-foreground-subtle")} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
            </span>
            <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">{s.end_ns === "0" ? "not ended" : dur(s.duration_ms)}</span>
          </div>
        );
      })}
    </div>
  );
}
