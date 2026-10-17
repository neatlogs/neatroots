import { CheckListIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { toast } from "sonner";
import { ListPageLayout } from "@/components/list-page/list-page-layout";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import type { CheckRow } from "@/lib/api";
import { useCheckActions, useChecks } from "../_services/check-queries";
import { CheckEditor } from "./check-editor";
import { CheckSheet } from "./check-sheet";
import { ChecksTable } from "./checks-table";
import { McpCheckApprovals } from "./mcp-check-approvals";

type Group = "all" | "rules" | "yours" | "planner" | "library";

const MATCH: Record<Group, (c: CheckRow) => boolean> = {
  all: () => true,
  rules: (c) => c.kind === "rule",
  yours: (c) => c.kind !== "rule" && (c.source === "user" || c.source === "project" || c.source === "mcp"),
  planner: (c) => c.kind !== "rule" && c.source === "planner",
  library: (c) => c.kind !== "rule" && c.source === "library",
};

/** Everything neatroots watches for, as one table; a check opens in a side sheet. */
export function ChecksPage() {
  const { data, isLoading } = useChecks();
  const a = useCheckActions();
  const [group, setGroup] = useState<Group>("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string>();
  const [editor, setEditor] = useState<{ yaml: string; n: number }>();
  const all = data?.checks ?? [];
  const needle = q.trim().toLowerCase();
  const checks = all.filter((c) => MATCH[group](c) && (!needle || c.title.toLowerCase().includes(needle) || c.id.includes(needle)));
  const count = (g: Group) => all.filter(MATCH[g]).length;

  return (
    <ListPageLayout
      icon={<Icon icon={CheckListIcon} />}
      title="Checks"
      actions={
        <>
          <div className="relative hidden sm:block">
            <Icon icon={Search01Icon} size="xs" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search checks" placeholder="Search checks" className="h-8 w-56 pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Button onClick={() => setEditor({ yaml: "", n: Date.now() })}>New check</Button>
        </>
      }
      filters={
        <div className="flex w-full flex-wrap items-center gap-3">
          <SegmentedTabs
            size="compact"
            value={group}
            onValueChange={setGroup}
            items={[
              { value: "all", label: `All ${count("all")}` },
              { value: "rules", label: `Rules ${count("rules")}` },
              { value: "yours", label: `Yours ${count("yours")}` },
              { value: "planner", label: `Planner ${count("planner")}` },
              { value: "library", label: `Library ${count("library")}` },
            ]}
          />
          <span className="ml-auto hidden text-xs text-muted-foreground lg:block">Rules run in code on every span. The LLM picks the questions that fit each agent.</span>
        </div>
      }
    >
      {!!data?.pending_mcp_checks?.length && <McpCheckApprovals proposals={data.pending_mcp_checks} userDir={data.user_dir} />}
      {!!data?.errors.length && (
        <div role="alert" className="mx-6 mt-3 flex max-h-32 shrink-0 flex-col gap-1 overflow-y-auto rounded-lg border border-danger-border bg-danger-surface px-4 py-3">
          <span className="text-sm font-medium text-danger-fg">Some check files didn't load</span>
          {data.errors.map((e, i) => (
            <span key={i} className="font-mono text-xs text-danger-fg">
              {e.path}
              {e.id ? ` (${e.id})` : ""}: {e.message}
            </span>
          ))}
        </div>
      )}
      {!isLoading && !checks.length ? (
        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <EmptyState
            variant="inline"
            state="no-results"
            title="No checks match"
            description="Try another group or search."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setGroup("all");
                  setQ("");
                }}
              >
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <ChecksTable checks={checks} loading={isLoading} onToggle={(id, enabled) => a.toggle.mutate({ id, enabled })} onOpen={setOpenId} />
      )}
      <CheckSheet
        check={all.find((c) => c.id === openId)}
        onClose={() => setOpenId(undefined)}
        onEdit={(yaml) => {
          setOpenId(undefined);
          setEditor({ yaml, n: Date.now() });
        }}
        onDelete={(id) =>
          a.remove.mutate(id, {
            onSuccess: () => {
              toast.success(`Deleted check ${id}`);
              setOpenId(undefined);
            },
          })
        }
      />
      {editor && <CheckEditor key={editor.n} open initialYaml={editor.yaml} userDir={data?.user_dir} onClose={() => setEditor(undefined)} />}
    </ListPageLayout>
  );
}
