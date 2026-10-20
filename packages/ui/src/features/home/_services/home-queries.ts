import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post, type Digest, type InsightWindow, type Insights } from "../../../lib/api";

export const homeKeys = {
  insights: (w: InsightWindow) => ["insights", w] as const,
};

export function useInsights(w: InsightWindow) {
  return useQuery({ queryKey: homeKeys.insights(w), queryFn: () => api<Insights>(`/api/insights?window=${w}`), refetchInterval: 30_000 });
}

/** Asks the LLM to read the aggregates for this window. */
export function useWriteDigest(w: InsightWindow) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<Digest>("/api/insights/digest", { window: w }),
    onSettled: () => void qc.invalidateQueries({ queryKey: homeKeys.insights(w) }),
  });
}
