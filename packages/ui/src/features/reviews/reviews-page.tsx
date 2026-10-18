import { SearchAreaIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ListPageLayout, ListPageTable } from "@/components/list-page/list-page-layout";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusPill } from "@/components/ui/status-pill";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { go } from "@/lib/router";
import { ReviewSheet } from "./review-sheet";
import { REVIEW_LABELS, type ReviewQueue } from "./types";

const FILTERS = { due: "Needs review", all: "All findings", ...REVIEW_LABELS };

/** Lists findings for review with URL filters, cursor paging and save-and-next. */
export function ReviewsPage({ query }: { query: URLSearchParams }) {
  const project = query.get("project") ?? "";
  const check = query.get("check") ?? "";
  const [filters, setFilters] = useState({ project, check });
  useEffect(() => { setFilters({ project, check }); }, [project, check]);
  useEffect(() => {
    if (filters.project === project && filters.check === check) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(query);
      next.set("project", filters.project);
      next.set("check", filters.check);
      if (!filters.project) next.delete("project");
      if (!filters.check) next.delete("check");
      next.delete("cursor"); next.delete("item");
      go(`reviews?${next}`, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [filters, project, check, query]);
  const params = new URLSearchParams(query);
  params.delete("item");
  const qs = params.toString();
  const { data: queue = { items: [], total: 0, next_cursor: null }, error, isLoading, refetch } = useQuery({ queryKey: ["reviews", qs], queryFn: () => api<ReviewQueue>(`/api/reviews?${qs}`) });
  const selected = query.get("item");
  const change = (key: string, value: string, filter = false) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value); else next.delete(key);
    if (filter) { next.delete("cursor"); next.delete("item"); }
    go(`reviews?${next}`);
  };
  const saved = async (id: string) => {
    const index = queue.items.findIndex((i) => i.finding.id === id);
    const next = queue.items[index + 1];
    await refetch();
    if (next) return change("item", next.finding.id);
    if (!queue.next_cursor) return change("item", "");
    const p = new URLSearchParams(params);
    p.set("cursor", queue.next_cursor);
    const page = await api<ReviewQueue>(`/api/reviews?${p}`);
    if (page.items[0]) p.set("item", page.items[0].finding.id);
    go(`reviews?${p}`);
  };

  return (
    <>
      <ListPageLayout title="Finding reviews" icon={<Icon icon={SearchAreaIcon} />} filters={
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Select value={query.get("state") || "due"} onValueChange={(v) => change("state", String(v), true)}>
            <SelectTrigger aria-label="Review status" className="h-8 w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(FILTERS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <Input aria-label="Filter project" placeholder="Project name" className="h-8 w-40" value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })} />
          <Input aria-label="Filter check" placeholder="Check ID" className="h-8 w-40" value={filters.check} onChange={(e) => setFilters({ ...filters, check: e.target.value })} />
          <span className="ml-auto text-xs text-muted-foreground tabular-nums" role="status">{isLoading ? "Loading findings…" : `${queue.total} matching findings`}</span>
        </div>
      }>
        <p className="px-6 py-3 text-xs text-muted-foreground">Was the check correct on this evidence? Reviews stay local and do not dismiss or resolve findings.</p>
        {error ? <p role="alert" className="px-6 text-sm text-danger-fg">Could not load reviews: {error.message}</p> : isLoading ? <p className="px-6 text-sm text-muted-foreground">Loading queue…</p> : !queue.items.length ? (
          <div className="px-6 py-12"><EmptyState variant="inline" title="No findings to review" description="Change the filters, or send another run to neatroots." /></div>
        ) : (
          <ListPageTable className="table-fixed">
            <TableHeader className="sticky top-[var(--list-dock-top,0px)] z-[var(--z-sticky)] bg-surface-subtle">
              <TableRow><TableHead className="pl-6">Finding</TableHead><TableHead className="hidden w-44 sm:table-cell">Project</TableHead><TableHead className="w-40 pr-6">Review</TableHead></TableRow>
            </TableHeader>
            <TableBody>{queue.items.map((item) => (
              <TableRow key={item.finding.id} className="h-14">
                <TableCell className="overflow-hidden pl-6">
                  <button className="focus-ring block w-full cursor-pointer truncate rounded-sm text-left text-sm text-foreground hover:underline" title={item.finding.title} onClick={() => change("item", item.finding.id)}>{item.finding.title}</button>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{item.finding.check_id}</span>
                </TableCell>
                <TableCell className="hidden truncate text-xs sm:table-cell">{item.project ?? "No project"}</TableCell>
                <TableCell className="pr-6"><StatusPill size="sm" tone={item.state === "stale" ? "warning" : item.state === "unreviewed" ? "muted" : "info"}>{REVIEW_LABELS[item.state]}</StatusPill></TableCell>
              </TableRow>
            ))}</TableBody>
          </ListPageTable>
        )}
        <div className="sticky bottom-0 left-0 mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background px-6 py-3">
          {query.has("cursor") && <Button variant="outline" size="sm" onClick={() => change("cursor", "", true)}>Restart queue</Button>}
          <Button variant="outline" size="sm" disabled={!queue.next_cursor} onClick={() => { const p = new URLSearchParams(params); p.set("cursor", queue.next_cursor!); go(`reviews?${p}`); }}>Next page</Button>
        </div>
      </ListPageLayout>
      {selected && <ReviewSheet key={selected} id={selected} onClose={() => change("item", "")} onSaved={saved} />}
    </>
  );
}
