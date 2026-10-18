import { BarChartHorizontalIcon, Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { CodeLine } from "@/components/code-line";
import { ListPageLayout } from "@/components/list-page/list-page-layout";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Status } from "@/lib/api";
import type { RunListParams } from "../_services/run-keys";
import { useRuns } from "../_services/run-queries";
import { useProjects } from "../../settings/_services/settings-queries";
import { RunsTable } from "./runs-table";

const ALL_PROJECTS = "__all__";

/** Filters a link can set: #/runs?project=…, or ?check=…&label=… for runs with one problem. */
function fromQuery(q: URLSearchParams): Partial<RunListParams> {
  return { project: q.get("project") ?? "", check: q.get("check") ?? undefined, label: q.get("label") ?? undefined };
}

/** "3 of 120 runs"; with filters, "12 matching of 120 runs" (and how many are shown, when not all). */
function footerCount(shown: number, matching: number | null, total: number): string {
  if (matching === null) return `${shown} of ${total} runs`;
  return `${matching} matching of ${total} runs${shown < matching ? `, newest ${shown} shown` : ""}`;
}

/** Every run neatroots recorded, as a full-bleed table like the Neatlogs traces page. */
export function RunsPage({ status, query }: { status?: Status; query: URLSearchParams }) {
  const [params, setParams] = useState<RunListParams>(() => ({ q: "", status: "", hasFinding: false, project: "", ...fromQuery(query) }));
  const qs = query.toString();
  useEffect(() => {
    const q = new URLSearchParams(qs);
    if (q.has("project") || q.has("check")) setParams((p) => ({ ...p, ...fromQuery(q) }));
  }, [qs]);
  const { data, isLoading, hasMore, loadMore, loadingMore } = useRuns(params);
  const { data: known } = useProjects();
  const runs = data?.runs ?? [];
  const projects = [...new Set([...(known?.projects ?? []).map((p) => p.project), params.project].filter(Boolean))] as string[];
  const filtered = !!(params.q || params.status || params.hasFinding || params.project || params.check);
  const clear = () => setParams({ q: "", status: "", hasFinding: false, project: "" });

  if (data && data.total === 0) {
    return (
      <ListPageLayout icon={<Icon icon={BarChartHorizontalIcon} />} title="Runs">
        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <EmptyState
            variant="inline"
            icon={BarChartHorizontalIcon}
            title="No runs yet"
            description="Point the Neatlogs SDK at neatroots and run your agent. Its runs appear here as they happen."
          >
            <div className="mt-4 flex w-full max-w-lg flex-col gap-2 text-left">
              <CodeLine text={`export NEATLOGS_ENDPOINT=http://localhost:${status?.port ?? 4100}\nexport NEATLOGS_API_KEY=neatroots-local`} />
              <CodeLine text={`neatlogs.init(workflow_name="my-agent", flush_interval=0.5)`} />
            </div>
          </EmptyState>
        </div>
      </ListPageLayout>
    );
  }

  return (
    <ListPageLayout
      icon={<Icon icon={BarChartHorizontalIcon} />}
      title="Runs"
      actions={
        <div className="relative w-64">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground">
            <Icon icon={Search01Icon} size="xxs" />
          </span>
          <Input aria-label="Search runs" className="h-8 pl-8" placeholder="Search requests, tools, outputs" value={params.q} onChange={(e) => setParams({ ...params, q: e.target.value })} />
        </div>
      }
      filters={
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs
            variant="pill"
            value={params.hasFinding ? "problems" : params.status || "all"}
            onValueChange={(v) => setParams({ ...params, status: v === "running" || v === "error" ? v : "", hasFinding: v === "problems" })}
            items={[
              { value: "all", label: "All" },
              { value: "problems", label: "With problems" },
              { value: "error", label: "Failed" },
              { value: "running", label: "Running" },
            ]}
          />
          {projects.length > 1 && (
            <Select value={params.project || ALL_PROJECTS} onValueChange={(v) => setParams({ ...params, project: v === ALL_PROJECTS || !v ? "" : String(v) })}>
              <SelectTrigger aria-label="Project" className="h-7 w-auto gap-1.5 rounded-full px-3 text-xs">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {params.check && (
            <span className="inline-flex h-7 max-w-80 items-center gap-1 rounded-full border border-info-border bg-info-surface pr-1 pl-2.5 text-xs text-info-fg">
              <span className="truncate" title={params.label ?? params.check}>
                Problem: {params.label ?? params.check}
              </span>
              <button type="button" aria-label="Clear the problem filter" onClick={() => setParams({ ...params, check: undefined, label: undefined })} className="flex size-5 cursor-pointer items-center justify-center rounded-full hover:bg-info-fg/10">
                <Icon icon={Cancel01Icon} size="xs" />
              </button>
            </span>
          )}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{data ? footerCount(runs.length, filtered ? (data.matching ?? runs.length) : null, data.total) : ""}</span>
        </div>
      }
    >
      {!isLoading && !runs.length && filtered ? (
        <div className="px-6 py-12">
          <EmptyState state="no-results" variant="inline" title="No runs match these filters" description="Clear the filters to see every run neatroots has recorded." action={<Button variant="outline" onClick={clear}>Clear filters</Button>} />
        </div>
      ) : (
        <>
          <RunsTable runs={runs} loading={isLoading} />
          {hasMore && (
            <div className="flex justify-center border-t border-border py-3">
              <PendingButton variant="ghost" size="sm" pending={loadingMore} onClick={loadMore}>
                Load more runs
              </PendingButton>
            </div>
          )}
        </>
      )}
    </ListPageLayout>
  );
}
