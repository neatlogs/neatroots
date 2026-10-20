import { Search01Icon } from "@hugeicons/core-free-icons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListPageLayout } from "@/components/list-page/list-page-layout";
import { NeatBadge } from "@/components/neat-ui/neat-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleChip } from "@/components/ui/toggle-chip";
import { api, type SearchRun } from "@/lib/api";
import { dur, stamp } from "@/lib/format";
import { go } from "@/lib/router";
import { runGoal } from "../../runs/_libs/labels";
import { RunStatusIcon } from "../../runs/_components/run-status-icon";

const QUICK: { token: string; label: string }[] = [
  { token: "has:problems", label: "With problems" },
  { token: "status:failed", label: "Failed" },
  { token: "kind:llm", label: "LLM calls" },
  { token: "kind:tool", label: "Tool calls" },
  { token: "since:24h", label: "Last 24 hours" },
];

/** FTS snippets mark hits as [like this]; show them highlighted. */
function Snippet({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="rounded-sm bg-warning-surface px-0.5 text-foreground">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/**
 * Search everything neatroots has recorded: the text of inputs, outputs, errors and tool calls,
 * with filters. Results are runs, each with the spans that matched.
 */
export function SearchPage({ query }: { query: URLSearchParams }) {
  const [q, setQ] = useState(query.get("q") ?? "");
  const input = useRef<HTMLInputElement>(null);
  const dq = useDebounced(q.trim(), 250);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const next = dq ? `search?q=${encodeURIComponent(dq)}` : "search";
    if (window.location.hash !== `#/${next}`) window.history.replaceState(null, "", `#/${next}`);
  }, [dq]);
  const { data, isFetching } = useQuery({
    queryKey: ["search", dq],
    queryFn: () => api<{ total: number; runs: SearchRun[]; query: { text: string; filters: Record<string, string> } }>(`/api/search/runs?q=${encodeURIComponent(dq)}&limit=60`),
    enabled: dq.length > 0,
    placeholderData: keepPreviousData,
  });
  const has = (t: string) => q.split(/\s+/).includes(t);
  const toggle = (t: string) => setQ(has(t) ? q.split(/\s+/).filter((x) => x !== t).join(" ") : `${q.trim()} ${t}`.trim());

  return (
    <ListPageLayout
      icon={<Icon icon={Search01Icon} />}
      title="Search"
      filters={
        <div className="flex w-full flex-col gap-3">
          <div className="relative">
            <Icon icon={Search01Icon} size="sm" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={input}
              aria-label="Search runs"
              placeholder='Search inputs, outputs, errors and tools — e.g. refund "order 1001" project:support kind:tool'
              className="h-10 pl-9 text-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {QUICK.map((f) => (
              <ToggleChip key={f.token} active={has(f.token)} label={f.label} onToggle={() => toggle(f.token)} />
            ))}
            <span className="ml-auto hidden text-xs text-muted-foreground md:inline">
              Filters: project: status: kind: tool: model: check: since:7d · <Kbd>⌘</Kbd> <Kbd>K</Kbd> opens search
            </span>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-6 py-4">
        {!dq ? (
          <EmptyState
            variant="inline"
            icon={Search01Icon}
            title="Search your runs"
            description="Type a word from a prompt, an answer, an error or a tool name, or use a filter. Everything is searched on this machine."
          />
        ) : isFetching && !data ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 w-full" />)
        ) : !data?.runs.length ? (
          <EmptyState
            variant="inline"
            state="no-results"
            title="Nothing matched"
            description="Try fewer words, or remove a filter. Search covers span names, errors, and the first 150,000 and last 50,000 characters of each input and output."
          />
        ) : (
          <>
            <p className="text-xs text-muted-foreground tabular-nums">
              {data.total} run{data.total === 1 ? "" : "s"}
              {data.total > data.runs.length ? `, showing the newest ${data.runs.length}` : ""}
            </p>
            <ul className="flex flex-col gap-2">
              {data.runs.map((r) => (
                <li key={r.trace_id}>
                  <button type="button" onClick={() => go(`runs/${r.trace_id}`)} className="flex w-full cursor-pointer flex-col gap-2 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-surface-subtle">
                    <span className="flex min-w-0 items-center gap-3">
                      <RunStatusIcon status={r.status} />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{runGoal(r) ?? r.root_name ?? "Run"}</span>
                      {r.open_finding_count > 0 && r.top_finding && (
                        <NeatBadge size="sm" variant="amber">
                          {r.top_finding}
                        </NeatBadge>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">{r.project}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {stamp(r.started_ms).time} {stamp(r.started_ms).date}
                      </span>
                      <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground">{dur(r.duration_ms)}</span>
                    </span>
                    {r.hits.length > 0 && (
                      <ul className="flex flex-col gap-1 border-l border-border pl-4">
                        {r.hits.map((h) => (
                          <li
                            key={h.span_id}
                            className="flex min-w-0 items-baseline gap-2 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              go(`runs/${r.trace_id}?view=trace&span=${h.span_id}`);
                            }}
                          >
                            <span className="shrink-0 font-mono text-foreground">{h.name}</span>
                            {h.kind && <span className="shrink-0 text-eyebrow text-2xs text-muted-foreground">{h.kind.toLowerCase()}</span>}
                            <span className="truncate text-muted-foreground">
                              <Snippet text={h.snippet} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </ListPageLayout>
  );
}
