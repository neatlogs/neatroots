import { useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Status } from "@/lib/api";
import type { AuditStatus, CaptureCoverage } from "@/lib/audit-types";
import { bytes } from "@/lib/format";
import { useAuditStatus, useSaveSettings } from "../_services/settings-queries";
import { OptionSelect, SettingField } from "./form";
import { SettingsCard, SettingsLoading } from "./settings-shell";

function Stat({ label, value }: { label: string; value: number | string }) {
  return <div className="min-w-0 rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-pixel text-lg tabular-nums">{value}</p></div>;
}

function Protection({ config, data }: { config: NonNullable<Status["config"]["audit"]>; data: AuditStatus }) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [directory, setDirectory] = useState(config.directory);
  const save = useSaveSettings();
  return <SettingsCard title="Archive protection" description="Archive original local records before releasing covered runs. This does not enable telemetry capture.">
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Covered live runs" value={data.covered_runs} /><Stat label="Held live runs" value={data.held_runs} />
      <Stat label="Observed live snapshots" value={data.archived_live_runs} /><Stat label="Last observed archive size" value={data.archive_totals_known ? bytes(data.archive_bytes) : "Unknown"} />
    </div>
    <p className="text-sm" role="status">Archive observation: {data.observation_state === "current" ? "Current local metadata" : data.observation_state === "stale" ? "Stale" : data.observation_state === "error" ? "Failed" : "Unknown"}.
      {data.observed_ms ? ` Last observed ${new Date(data.observed_ms).toLocaleString()}.` : " No archive observation this session."}</p>
    <p className="text-xs text-muted-foreground">Status does not reverify archive files. Counts compare local changes with last observed snapshots; byte totals may be estimates. Deletion always verifies the archive again.</p>
    <div className="flex items-center justify-between gap-4"><label htmlFor="audit-default" className="text-sm">Default protection for projects</label>
      <Switch id="audit-default" checked={enabled} disabled={save.isPending} onCheckedChange={setEnabled} /></div>
    <SettingField label="Archive directory" htmlFor="audit-directory" hint="Leave empty for the server's default local audit folder.">
      <Input id="audit-directory" value={directory} disabled={save.isPending} onChange={e => setDirectory(e.target.value)} placeholder="Default local audit folder" />
    </SettingField>
    <p className="text-xs text-muted-foreground">Archives are plaintext and grow outside the live-store cap. Held runs can keep live storage above its cap. No-project runs and doctor probes are exempt.</p>
    {Object.entries(data.hold_reasons).length > 0 && <div className="h-28 overflow-auto text-sm" aria-label="Audit hold reasons">
      {Object.entries(data.hold_reasons).map(([reason, count]) => <p key={reason}>{count} held: {reason}</p>)}
    </div>}
    {(data.failures.length > 0 || data.verification_errors.length > 0) && <p role="alert" className="text-sm text-danger-fg">Archive write or verification failed. Covered runs stay held. Check the archive directory and run audit verify.</p>}
    {save.isError && <p role="alert" className="text-sm text-danger-fg">Could not save protection. Your edits are preserved.</p>}
    <div><PendingButton pending={save.isPending} onClick={() => save.mutate({ body: { audit_enabled: enabled, audit_directory: directory }, message: "Audit protection saved" })}>Save protection</PendingButton></div>
  </SettingsCard>;
}

type Project = CaptureCoverage["projects"][number];
function ProjectRow({ project: p }: { project: Project }) {
  const initial = p.audit_override === null ? "inherit" : p.audit_override ? "on" : "off";
  const [choice, setChoice] = useState(initial);
  const save = useSaveSettings();
  return <TableRow className="h-20 hover:bg-transparent">
    <TableCell className="max-w-48 truncate px-4 text-sm">{p.project ?? "No project"}</TableCell>
    <TableCell className="px-4 text-xs tabular-nums">{p.traced} received · {p.imported} imported · {p.unclassified} unknown</TableCell>
    <TableCell className="px-4"><div className="flex items-center gap-2">
      {p.project === null ? <span className="text-xs text-muted-foreground">Exempt</span> : <>
        <OptionSelect label={`Protection for ${p.project}`} value={choice} onValueChange={setChoice} className="h-8 w-28" options={[{ value: "inherit", label: "Inherit" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} />
        <PendingButton size="sm" variant="secondary" pending={save.isPending} onClick={() => save.mutate({ body: { project: p.project, audit: choice === "inherit" ? null : choice === "on" }, message: `Audit protection saved for ${p.project}` })}>Save protection</PendingButton>
      </>}
    </div><p className="mt-1 text-xs text-muted-foreground">Effective protection: {p.audit_enabled ? "on" : "off"}</p>
    <p role={save.isError ? "alert" : undefined} className="h-4 truncate text-xs text-danger-fg">{save.isError ? "Save failed; selection kept." : ""}</p></TableCell>
  </TableRow>;
}

export function AuditSection({ status }: { status: Status }) {
  const query = useAuditStatus();
  if (query.isLoading) return <SettingsLoading rows={3} />;
  const data = query.data;
  return <>
    {query.isError && <SettingsCard title="Audit status unavailable" description={data ? "Showing the last loaded counts. Your edits are preserved." : "The server could not provide audit coverage. It may need an update."}>
      <Button variant="secondary" onClick={() => void query.refetch()}>Retry audit status</Button>
    </SettingsCard>}
    {data && <>
      <SettingsCard title="Capture evidence" description="Retained non-doctor runs only. Receiving telemetry and protecting its retention are separate.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Observed runs" value={data.coverage.observed_runs} /><Stat label="Received telemetry" value={data.coverage.traced_runs} /><Stat label="Imported runs" value={data.coverage.imported_runs} /><Stat label="Unknown source" value={data.coverage.unclassified_runs} /></div>
        {data.coverage.observed_runs === 0 && <p className="text-sm text-muted-foreground">No retained run evidence yet. Instrument an agent or import traces to see coverage.</p>}
        <p className="text-sm">Guidance delivered: {data.coverage.guidance_delivered_runs} runs. This overlaps the categories above and does not prove the guidance was followed.</p>
        <p className="text-xs text-muted-foreground">Receipt does not authenticate the producer or prove complete capture. Closed, web and unknown agents without telemetry cannot be enumerated.</p>
      </SettingsCard>
      {status.config.audit && <Protection config={status.config.audit} data={data} />}
      <SettingsCard title="Projects" description="Capture counts come from retained runs. Protection follows the global default unless overridden." contentClassName="p-0">
        <div className="h-64 overflow-auto border-t border-border"><Table className="min-w-[42rem] table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-surface-subtle"><TableRow><TableHead className="w-44 px-4">Project</TableHead><TableHead className="px-4">Capture evidence</TableHead><TableHead className="w-72 px-4">Archive protection</TableHead></TableRow></TableHeader>
          <TableBody>{data.coverage.projects.map(p => <ProjectRow key={p.project === null ? "absent-project" : `project:${p.project}`} project={p} />)}</TableBody>
        </Table>{data.coverage.projects.length === 0 && <p className="p-4 text-sm text-muted-foreground">No projects in the retained store or audit configuration.</p>}</div>
      </SettingsCard>
      <SettingsCard title="MCP connections" description="Connection inventory is separate from stored-run evidence. Independently instrumented runs may exist.">
        <p className="text-sm">An MCP connection {data.coverage.connection_notice}.</p>
        {data.coverage.connections.state === "unavailable" ? <p role="status" className="text-sm">Connection inventory unavailable. Stored-run counts remain available.</p> : <div className="h-64 overflow-auto">
          {data.coverage.connections.clients.map(c => <div key={c.id} className="flex h-28 items-center gap-3 border-b border-border sm:h-20">
            <div className="min-w-0 flex-1"><p className="text-sm">{c.label}</p><p className="mt-1 text-xs text-muted-foreground">{c.connected ? `This MCP connection ${data.coverage.connection_notice}.` : "Connection does not establish whether this client's runs are captured."}</p></div>
            <StatusPill size="sm" tone={c.connected ? "neutral" : "muted"}>{c.connected ? "Connected" : c.detected ? "Detected" : "Not detected"}</StatusPill>
          </div>)}
        </div>}
      </SettingsCard>
    </>}
  </>;
}
