import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post, type Digest, type InsightWindow, type Insights } from "../../../lib/api";

export const homeKeys = {
  insights: (w: InsightWindow) => ["insights", w] as const,
};

export function useInsights(w: InsightWindow) {
  return useQuery({ queryKey: homeKeys.insights(w), queryFn: () => api<Insights>(`/api/insights?window=${w}`), refetchInterval: 30_000 });
}

export function useDismissHomeFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { finding_id: string; check_id: string; project: string }) => post("/api/insights/dismiss", target),
    // Wait for refreshed identities before enabling another click, including after conflicts.
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["insights"] }),
        qc.invalidateQueries({ queryKey: ["runs"] }),
        qc.invalidateQueries({ queryKey: ["checks"] }),
      ]);
    },
  });
}

/** Asks the LLM to read the aggregates for this window. */
export function useWriteDigest(w: InsightWindow) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<Digest>("/api/insights/digest", { window: w }),
    onSettled: () => void qc.invalidateQueries({ queryKey: homeKeys.insights(w) }),
  });
}
