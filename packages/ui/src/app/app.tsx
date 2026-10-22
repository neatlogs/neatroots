import { CompareRuns } from "@/features/runs/_components/compare-runs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Toaster } from "sonner";
import { PageErrorBoundary } from "@/components/page-error-boundary";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChecksPage } from "@/features/checks/_components/checks-page";
import { HomePage } from "@/features/home/_components/home-page";
import { RunDetail } from "@/features/runs/_components/run-detail";
import { RunsPage } from "@/features/runs/_components/runs-page";
import { appKeys } from "@/features/runs/_services/run-keys";
import { SettingsPage } from "@/features/settings/_components/settings-page";
import { SearchPage } from "@/features/search/_components/search-page";
import { AgentsPage } from "@/features/agents/_components/agents-page";
import { AddDataPage } from "@/features/ingest/_components/add-data-page";
import { api, type Status } from "@/lib/api";
import { useLiveEvents } from "@/lib/live-events";
import { go, useLocation } from "@/lib/router";
import { useTheme } from "@/lib/theme";
import { AppSidebar } from "./app-sidebar";
import { PushBanner } from "./push-banner";

/** The app frame, as in the Neatlogs app: an inset rounded panel beside the sidebar. */
export function App() {
  const { parts: route, query } = useLocation();
  const page = route[0] ?? "home";
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const { connected } = useLiveEvents();
  const { data: status } = useQuery({ queryKey: appKeys.status, queryFn: () => api<Status>("/api/status"), refetchInterval: 10_000 });
  const runId = page === "runs" ? route[1] : undefined;

  // ⌘K / Ctrl+K anywhere opens search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        go("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar
          page={page}
          status={status}
          connected={connected}
          theme={theme}
          setTheme={setTheme}
          onSettingsChanged={() => void qc.invalidateQueries({ queryKey: appKeys.status })}
        />
        <SidebarInset className="md:peer-data-[variant=inset]:overflow-hidden">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3 md:hidden">
            <SidebarTrigger aria-label="Open navigation" />
            <span className="text-sm text-foreground">neatroots</span>
          </div>
          <PushBanner />
          <div className="min-h-0 flex-1">
          <PageErrorBoundary key={route.join("/")}>
          {page === "compare" ? (
            <CompareRuns query={query} />
          ) : page === "checks" ? (
            <ChecksPage />
          ) : page === "search" ? (
            <SearchPage query={query} />
          ) : page === "agents" ? (
            <AgentsPage sessionId={route[1]} query={query} />
          ) : page === "add-data" ? (
            <AddDataPage status={status} tab={route[1]} />
          ) : page === "settings" ? (
            <SettingsPage status={status} tab={route[1]} />
          ) : page === "runs" && runId ? (
            <RunDetail key={runId} traceId={runId} query={query} />
          ) : page === "runs" ? (
            <RunsPage status={status} query={query} />
          ) : (
            <HomePage status={status} />
          )}
          </PageErrorBoundary>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster theme={theme} position="bottom-right" toastOptions={{ className: "font-sans" }} />
    </TooltipProvider>
  );
}
