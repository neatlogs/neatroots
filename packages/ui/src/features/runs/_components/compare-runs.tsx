import { useQuery } from "@tanstack/react-query";
import { BarChartHorizontalIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { ListPageLayout } from "@/components/list-page/list-page-layout";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusPill } from "@/components/ui/status-pill";
import { api, type Run } from "@/lib/api";
import { go } from "@/lib/router";
import { RUN_STATE } from "../_libs/labels";
import { useRunDetail, useRuns } from "../_services/run-queries";

interface ComparedRun {
  summary: Run;
  tools: string[];
  full_output: string | null;
  output_is_preview: boolean;
  reported_tokens: number | null;
  problems: string[];
}
interface Comparison {
  a: ComparedRun;
  b: ComparedRun;
  fixed: string[];
  new_problems: string[];
  persistent: string[];
  same_tool_sequence: boolean;
}

function RunPicker({ label, value, onChange, selected }: { label: string; value: string; onChange: (id: string) => void; selected?: Run }) {
  const [search, setSearch] = useState("");
  const { data, error, isLoading, hasMore, loadMore, loadingMore } = useRuns({ q: search, status: "", hasFinding: false, project: "" });
  const runs = [...(selected ? [selected] : []), ...(data?.runs ?? []).filter((r) => r.trace_id !== selected?.trace_id)];
  return <div className="flex min-w-0 flex-col gap-2">
    <label className="text-sm font-medium" htmlFor={`search-${label}`}>{label}</label>
    <Input id={`search-${label}`} aria-label={`Search ${label.toLowerCase()} runs`} placeholder="Search runs by name or content" value={search} onChange={(e) => setSearch(e.target.value)} />
    <Select value={value || null} onValueChange={onChange}>
      <SelectTrigger aria-label={`${label} run`} className="w-full min-w-0"><SelectValue placeholder={value ? `Run ${value.slice(0, 8)}` : "Select a run"} /></SelectTrigger>
      <SelectContent>{runs.map((r) => <SelectItem key={r.trace_id} value={r.trace_id}>{r.root_name ?? r.workflow ?? "Run"} · {r.trace_id.slice(0, 8)}</SelectItem>)}</SelectContent>
    </Select>
    <p role="status" className="min-h-4 text-xs text-muted-foreground">{error ? data?.runs.length ? "Couldn't load more runs. Try loading more again." : "Couldn't load runs. Try searching again." : isLoading || loadingMore ? "Loading runs…" : `${runs.length} shown. Search to find runs by name or content.`}</p>
    {hasMore && <PendingButton variant="secondary" size="sm" className="self-start" aria-label={`Load more ${label.toLowerCase()} runs`} pending={loadingMore} onClick={loadMore}>Load more runs</PendingButton>}
  </div>;
}

function Metric({ label, a, b, unit = "" }: { label: string; a: number | null; b: number | null; unit?: string }) {
  // Durations come from fractional span timestamps; show whole numbers.
  const format = (n: number | null) => n === null ? "Not recorded" : `${Math.round(n).toLocaleString()}${unit}`;
  const delta = a === null || b === null ? null : Math.round(b) - Math.round(a);
  return <Panel data-testid={`metric-${label.toLowerCase().replaceAll(" ", "-")}`}>
    <PanelHeader title={label} />
    <div className="grid grid-cols-2 gap-3 text-sm tabular-nums">
      <div><p className="text-xs text-muted-foreground">Original</p><p className="mt-1 font-medium">{format(a)}</p></div>
      <div><p className="text-xs text-muted-foreground">Replay / comparison</p><p className="mt-1 font-medium">{format(b)}</p></div>
    </div>
    <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">Change: {delta === null ? "Not available" : `${delta > 0 ? "+" : ""}${format(delta)}`}</p>
  </Panel>;
}

function Problems({ title, problems, tone }: { title: string; problems: string[]; tone: "success" | "danger" | "neutral" }) {
  return <Panel>
    <PanelHeader title={title} actions={<StatusPill tone={tone} size="sm">{problems.length}</StatusPill>} />
    <ul className="h-32 overflow-y-auto text-sm" aria-label={title}>
      {problems.length ? problems.map((p, i) => <li key={`${p}-${i}`} className="border-b border-border/60 py-2 break-words last:border-0">{p}</li>) : <li className="text-muted-foreground">None</li>}
    </ul>
  </Panel>;
}

export function CompareRuns({ query }: { query: URLSearchParams }) {
  const a = query.get("a") ?? "";
  const b = query.get("b") ?? "";
  const select = (original: string, replay: string) => go(`compare?${new URLSearchParams({ a: original, b: replay })}`);
  const original = useRunDetail(a || undefined);
  const replay = useRunDetail(b || undefined);
  const comparison = useQuery({
    queryKey: ["compare-runs", a, b],
    queryFn: () => api<Comparison>(`/api/compare?${new URLSearchParams({ a, b })}`),
    enabled: !!a && !!b && a !== b,
    refetchInterval: (q) => {
      if (q.state.status === "error") return false;
      const result = q.state.data;
      return result && (result.a.summary.status === "running" || result.b.summary.status === "running") ? 3000 : false;
    },
    retry: false,
  });
  const d = comparison.data;
  const linked = original.data?.replays.filter((r) => r.new_trace_id) ?? [];
  return <ListPageLayout title="Compare runs" icon={<Icon icon={BarChartHorizontalIcon} />} actions={<Button variant="secondary" onClick={() => go("runs")}>View runs</Button>}>
    <div className="flex min-w-0 flex-col gap-6 p-4 md:p-6">
      <p className="text-sm text-muted-foreground">Compare an original with its replay, or any two recorded runs. Changes are comparison minus original.</p>
      <Panel>
        <div className="grid gap-4 md:grid-cols-2">
          <RunPicker label="Original" value={a} onChange={(id) => select(id, b)} selected={original.data?.run} />
          <RunPicker label="Comparison" value={b} onChange={(id) => select(a, id)} selected={replay.data?.run} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={!a || !b} onClick={() => select(b, a)}>Swap runs</Button>
          {linked.length > 0 && <Select value={linked.some((r) => r.new_trace_id === b) ? b : null} onValueChange={(id) => select(a, id)}>
            <SelectTrigger aria-label="Linked replay" className="w-full sm:w-72"><SelectValue placeholder="Select a linked replay" /></SelectTrigger>
            <SelectContent>{linked.map((r) => <SelectItem key={r.id} value={r.new_trace_id!}>{r.kind === "llm" ? "One LLM call" : "Whole agent"} · {r.new_trace_id!.slice(0, 8)}</SelectItem>)}</SelectContent>
          </Select>}
        </div>
      </Panel>
      {!a || !b ? <EmptyState variant="inline" title="Select two runs" description="Choose an original and a replay or another run to see what changed." />
        : a === b ? <EmptyState variant="inline" title="Choose a different run" description="The original and comparison currently refer to the same run." />
        : comparison.error ? <EmptyState variant="inline" state="error" title="Couldn't compare these runs" description={`${comparison.error.message}. A run may have been removed by retention.`} />
        : !d ? <EmptyState variant="inline" state="loading" title="Comparing runs" />
        : <>
          <div className="grid gap-4 md:grid-cols-2">{([d.a, d.b] as const).map((r, i) => <Panel key={i}>
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{i === 0 ? "Original" : "Replay / comparison"}</span><StatusPill tone={RUN_STATE[r.summary.status].tone} size="sm">{RUN_STATE[r.summary.status].label}</StatusPill></div>
            <a className="mt-2 block truncate text-sm font-medium underline-offset-4 hover:underline" href={`#/runs/${r.summary.trace_id}`}>{r.summary.root_name ?? "Run"} · {r.summary.trace_id.slice(0, 8)}</a>
          </Panel>)}</div>
          {replay.data?.replay_of?.kind === "llm" && <p className="text-sm text-muted-foreground">This replay contains one LLM call; its totals cover less work than the original agent run.</p>}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Open findings" a={d.a.problems.length} b={d.b.problems.length} />
            <Metric label="LLM calls" a={d.a.summary.llm_calls} b={d.b.summary.llm_calls} />
            <Metric label="Tokens" a={d.a.reported_tokens} b={d.b.reported_tokens} />
            <Metric label="Duration" a={d.a.summary.duration_ms} b={d.b.summary.duration_ms} unit=" ms" />
          </div>
          <div><p className="mb-3 text-xs text-muted-foreground">Open findings matched by title, as in MCP compare_runs. Missing titles do not prove a fix; check coverage may differ.</p>
            <div className="grid gap-4 lg:grid-cols-3"><Problems title="No longer present" problems={d.fixed} tone="success" /><Problems title="New problems" problems={d.new_problems} tone="danger" /><Problems title="Still present" problems={d.persistent} tone="neutral" /></div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">{[d.a, d.b].map((r, i) => <Panel key={i}>
            <PanelHeader title={`${i === 0 ? "Original" : "Comparison"} ${r.output_is_preview ? "output preview" : "output"}`} />
            <pre data-testid={`output-${i}`} className="h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{r.full_output ?? "No output recorded"}</pre>
            {r.output_is_preview && <p className="mt-2 text-xs text-muted-foreground">Only the stored preview is available; the full root output was not recorded.</p>}
          </Panel>)}</div>
          <div><p className="mb-3 text-sm text-muted-foreground">Tool sequence: {d.same_tool_sequence ? "unchanged" : "changed"}. Calls are ordered by recorded start time.</p>
            <div className="grid gap-4 md:grid-cols-2">{[d.a, d.b].map((r, i) => <Panel key={i}><PanelHeader title={`${i === 0 ? "Original" : "Comparison"} tools · ${r.tools.length}`} /><ol aria-label={`${i === 0 ? "Original" : "Comparison"} tool sequence`} className="h-48 overflow-y-auto text-sm">{r.tools.length ? r.tools.map((tool, n) => <li key={n} className="flex h-9 items-center gap-3 border-b border-border/60"><span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">{n + 1}</span><span className="truncate" title={tool}>{tool}</span></li>) : <li className="text-muted-foreground">No tool calls</li>}</ol></Panel>)}</div>
          </div>
        </>}
    </div>
  </ListPageLayout>;
}
