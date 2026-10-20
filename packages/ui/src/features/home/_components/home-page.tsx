import { Calendar03Icon, Home01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { ListPageLayout } from "@/components/list-page/list-page-layout";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import type { InsightWindow, Status } from "@/lib/api";
import { useAgents, useProjects } from "../../settings/_services/settings-queries";
import { useInsights } from "../_services/home-queries";
import { DigestCard } from "./digest-card";
import { Health } from "./health";
import { Activity, Kpis, PERIOD } from "./overview";
import { ProjectsTable } from "./projects-table";
import { SetupGuide } from "./setup-guide";

const KEY = "neatroots-home-window";

function savedWindow(): InsightWindow {
  try {
    const v = localStorage.getItem(KEY);
    return v === "24h" || v === "7d" || v === "30d" ? v : "7d";
  } catch {
    return "7d";
  }
}

/** Home: how to use neatroots, and how the agents have been doing over a period. */
export function HomePage({ status }: { status?: Status }) {
  const [win, setWin] = useState<InsightWindow>(savedWindow);
  const { data, error } = useInsights(win);
  const { data: projects } = useProjects();
  const { data: agents } = useAgents();
  const choose = (w: InsightWindow) => {
    setWin(w);
    try {
      localStorage.setItem(KEY, w);
    } catch {
      /* the choice just isn't remembered */
    }
  };
  const everReceived = (status?.stats.runs ?? 0) > 0;
  const hasRuns = !!data && data.totals.runs > 0;

  return (
    <ListPageLayout
      icon={<Icon icon={Home01Icon} />}
      title="Home"
      actions={
        everReceived && (
          <SegmentedTabs
            size="compact"
            value={win}
            onValueChange={choose}
            items={[
              { value: "24h", label: "24 hours" },
              { value: "7d", label: "7 days" },
              { value: "30d", label: "30 days" },
            ]}
          />
        )
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-1 pb-10">
        {status && <SetupGuide status={status} projects={projects?.projects ?? []} agents={agents?.agents ?? []} />}
        {error && <EmptyState variant="bordered" state="error" title="Couldn't load insights" description={(error as Error).message} />}
        {everReceived && data && !hasRuns && (
          <EmptyState
            variant="bordered"
            icon={Calendar03Icon}
            title={`No runs in the last ${PERIOD[win]}`}
            description="Insights cover runs that started in this period. Older runs are still on the Runs page."
            action={
              win !== "30d" ? (
                <Button variant="secondary" size="sm" onClick={() => choose("30d")}>
                  Show last 30 days
                </Button>
              ) : undefined
            }
          />
        )}
        {everReceived && (!data || hasRuns) && <Kpis data={data} />}
        {data && hasRuns && (
          <>
            <DigestCard data={data} llmOk={status ? !!status.engine?.llm.ok : undefined} />
            <Health data={data} />
            <Activity data={data} />
            <ProjectsTable data={data} />
          </>
        )}
      </div>
    </ListPageLayout>
  );
}
