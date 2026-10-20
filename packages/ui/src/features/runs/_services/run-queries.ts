import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post, type ForwardPreview, type Run, type RunDetail, type SpanDetail } from "../../../lib/api";
import { appKeys, runKeys, type RunListParams } from "./run-keys";

const RUNS_PAGE = 150;

/** Runs, newest first, a page at a time: `loadMore` reaches older runs. */
export function useRuns(p: RunListParams) {
  const query = useInfiniteQuery({
    queryKey: runKeys.list(p),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(RUNS_PAGE), offset: String(pageParam) });
      if (p.q) q.set("q", p.q);
      if (p.status) q.set("status", p.status);
      if (p.hasFinding) q.set("has_finding", "1");
      if (p.project) q.set("project", p.project);
      if (p.check) q.set("check", p.check);
      return api<{ runs: Run[]; total: number; matching?: number }>(`/api/runs?${q}`);
    },
    getNextPageParam: (last, pages) => (last.runs.length < RUNS_PAGE ? undefined : pages.length * RUNS_PAGE),
    placeholderData: keepPreviousData,
  });
  const pages = query.data?.pages;
  return {
    data: pages ? { runs: pages.flatMap((pg) => pg.runs), total: pages[0]?.total ?? 0, matching: pages[0]?.matching } : undefined,
    isLoading: query.isLoading,
    hasMore: !!query.hasNextPage,
    loadMore: () => void query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
  };
}

export function useRunDetail(traceId: string | undefined) {
  return useQuery({
    queryKey: runKeys.detail(traceId ?? ""),
    queryFn: () => api<RunDetail>(`/api/runs/${traceId}`),
    enabled: !!traceId,
    // While its checks are still queued or running, keep the counts current.
    refetchInterval: (q) => (q.state.data?.coverage?.state === "checking" ? 3000 : false),
  });
}

export function useSpanDetail(traceId: string, spanId: string | undefined) {
  return useQuery({
    queryKey: runKeys.span(traceId, spanId ?? ""),
    queryFn: () => api<SpanDetail>(`/api/runs/${traceId}/spans/${spanId}`),
    enabled: !!spanId,
  });
}

/** Mutations on one run; each refreshes the run afterwards. */
export function useRunActions(traceId: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: runKeys.detail(traceId) });
    void qc.invalidateQueries({ queryKey: runKeys.lists() });
  };
  return {
    explain: useMutation({ mutationFn: () => post(`/api/runs/${traceId}/explain`), onSettled: refresh }),
    recheck: useMutation({ mutationFn: () => post(`/api/runs/${traceId}/recheck`), onSettled: refresh }),
    pin: useMutation({ mutationFn: (pinned: boolean) => post(`/api/runs/${traceId}/pin`, { pinned }), onSettled: refresh }),
    previewForward: useMutation({ mutationFn: () => post<ForwardPreview>("/api/cloud/preview", { trace_ids: [traceId] }) }),
    forward: useMutation({
      mutationFn: () => post<{ status: string; span_count: number; error: string | null }>("/api/cloud/forward", { trace_ids: [traceId] }),
      onSettled: () => {
        refresh();
        void qc.invalidateQueries({ queryKey: appKeys.forwards });
      },
    }),
    setFinding: useMutation({ mutationFn: (v: { id: string; status: string }) => post(`/api/findings/${v.id}`, { status: v.status }), onSettled: refresh }),
    investigate: useMutation({ mutationFn: (id: string) => post(`/api/findings/${id}/investigate`), onSettled: refresh }),
    annotate: useMutation({
      mutationFn: (v: { span_id: string | null; label: string; text?: string | null }) => post("/api/annotations", { trace_id: traceId, ...v }),
      onSettled: refresh,
    }),
  };
}
