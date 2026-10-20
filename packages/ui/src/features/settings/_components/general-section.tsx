import { useState } from "react";
import { CodeLine } from "@/components/code-line";
import { PendingButton } from "@/components/pending-button";
import { Input } from "@/components/ui/input";
import type { Status } from "@/lib/api";
import { bytes } from "@/lib/format";
import { useSaveSettings } from "../_services/settings-queries";
import { SettingField } from "./form";
import { SettingsCard } from "./settings-shell";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-pixel text-lg text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/** Where neatroots listens, where it keeps data, and for how long. */
export function GeneralSection({ status }: { status: Status }) {
  const save = useSaveSettings();
  const [days, setDays] = useState(String(status.config.retention.days));
  const [gb, setGb] = useState(String(status.config.retention.maxGb));
  const grpc = status.config.grpc_port;
  return (
    <>
      <SettingsCard title="Endpoints" description="Point agents, exporters and coding agents here. Everything listens on this machine only.">
        <SettingField label="App, OTLP/HTTP (/v1/traces) and the Neatlogs HTTP API (/v1/trace)">
          <CodeLine text={`http://localhost:${status.port}`} />
        </SettingField>
        <SettingField label="OTLP over gRPC" hint={grpc ? undefined : "Off. Start with --grpc-port 4317 to turn it on."}>
          <CodeLine text={grpc ? `localhost:${grpc}` : "off"} />
        </SettingField>
        <SettingField label="MCP for coding agents">
          <CodeLine text={`http://localhost:${status.port}/mcp`} />
        </SettingField>
        <a href="#/add-data" className="text-sm text-foreground underline-offset-4 hover:underline">
          Every way to send runs to neatroots
        </a>
      </SettingsCard>
      <SettingsCard title="Storage" description="Runs are kept until they're older than the limit or the store passes its size cap, oldest first. Pinned runs are kept.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Runs" value={status.stats.runs.toLocaleString()} />
          <Stat label="Spans" value={status.stats.spans.toLocaleString()} />
          <Stat label="Findings" value={status.stats.findings.toLocaleString()} />
          <Stat label="On disk" value={bytes(status.stats.bytes)} />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingField label="Keep runs for (days)" htmlFor="ret-days">
            <Input id="ret-days" type="number" min={1} className="h-8" value={days} onChange={(e) => setDays(e.target.value)} />
          </SettingField>
          <SettingField label="Size cap (GB)" htmlFor="ret-gb">
            <Input id="ret-gb" type="number" min={0.1} step={0.5} className="h-8" value={gb} onChange={(e) => setGb(e.target.value)} />
          </SettingField>
        </div>
        <div>
          <PendingButton
            variant="secondary"
            pending={save.isPending}
            onClick={() => save.mutate({ body: { retention_days: Number(days), retention_max_gb: Number(gb) }, message: "Retention saved" })}
          >
            Save retention
          </PendingButton>
        </div>
        <SettingField label="Data folder">
          <CodeLine text={status.home} />
        </SettingField>
      </SettingsCard>
      <SettingsCard title="This install" description={`neatroots ${status.version}${status.install?.mode === "bundle" ? ", installed from a release" : status.install?.mode === "source" ? ", built from source" : ""}.`}>
        <SettingField label="Update to the latest release">
          <CodeLine text="neatroots update" />
        </SettingField>
      </SettingsCard>
    </>
  );
}
