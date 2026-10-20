import { DatabaseImportIcon } from "@hugeicons/core-free-icons";
import { ListPageLayout } from "@/components/list-page/list-page-layout";
import { Icon } from "@/components/ui/icon";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import type { Status } from "@/lib/api";
import { go } from "@/lib/router";
import { CloudTab } from "./cloud-tab";
import { ImportTab } from "./import-tab";
import { SdkTab } from "./sdk-tab";

type Tab = "send" | "import" | "cloud";

/** Every way runs get into neatroots: live from your agent, from trace files, or from Neatlogs Cloud. */
export function AddDataPage({ status, tab: raw }: { status?: Status; tab?: string }) {
  const tab: Tab = raw === "import" || raw === "cloud" ? raw : "send";
  return (
    <ListPageLayout
      icon={<Icon icon={DatabaseImportIcon} />}
      title="Add data"
      tabs={
        <SegmentedTabs
          value={tab}
          onValueChange={(t) => go(t === "send" ? "add-data" : `add-data/${t}`)}
          items={[
            { value: "send", label: "From your agent" },
            { value: "import", label: "Import files" },
            { value: "cloud", label: "Neatlogs Cloud" },
          ]}
        />
      }
    >
      <div className="flex w-full max-w-4xl flex-col gap-4 px-6 pt-1 pb-10">
        {tab === "send" ? <SdkTab port={status?.port ?? 4100} grpcPort={status?.config.grpc_port} examples={status?.install?.examples} /> : tab === "import" ? <ImportTab /> : <CloudTab status={status} />}
      </div>
    </ListPageLayout>
  );
}
