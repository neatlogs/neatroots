import { useEffect, useRef, useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { StatusPill } from "@/components/ui/status-pill";
import type { AmbientStatus, ChromaDevice } from "@/lib/api";
import { useSaveSettings } from "../_services/settings-queries";
import { SettingsCard } from "./settings-shell";

const LABEL: Record<AmbientStatus["state"], string> = {
  inactive: "Inactive", idle: "Waiting for a run", live: "Run live", checking: "Checking run", loop: "Loop finding",
  error: "Run failed", interrupted: "Run interrupted", attention: "Open findings", incomplete: "Checks incomplete", success: "Checks settled",
};

const DEVICES: ChromaDevice[] = ["chromalink", "keyboard", "mouse", "mousepad", "headset", "keypad"];
const DEVICE_NAME: Record<ChromaDevice, string> = { chromalink: "ChromaLink", keyboard: "Keyboard", mouse: "Mouse", mousepad: "Mousepad", headset: "Headset", keypad: "Keypad" };
const draft = (status: AmbientStatus) => ({ enabled: status.enabled, logging: status.log_enabled,
  chroma: status.chroma.configured, animation: status.chroma.animation, devices: status.chroma.devices });

export function AmbientSection({ status }: { status: AmbientStatus }) {
  const save = useSaveSettings();
  const editing = useRef(false);
  const [form, setForm] = useState(() => draft(status));
  const saved = JSON.stringify(draft(status));
  useEffect(() => { if (!editing.current) setForm(draft(status)); }, [saved]);
  const change = (patch: Partial<typeof form>) => { editing.current = true; setForm(current => ({ ...current, ...patch })); };
  const dirty = JSON.stringify(form) !== saved;
  const tone = status.state === "success" ? "success" : status.state === "error" ? "danger" : "neutral";
  return <>
    <SettingsCard title="Ambient outputs" description="Follow run state without keeping a run open. Each output is opt-in; turning off ambient outputs stops all of them.">
      <div className="flex h-14 items-center justify-between gap-4 border-b border-border">
        <label htmlFor="ambient-enabled" className="text-sm font-medium">Enable ambient outputs</label>
        <Switch id="ambient-enabled" checked={form.enabled} onCheckedChange={enabled => change({ enabled })} />
      </div>
      <div className="flex h-16 items-center justify-between gap-4">
        <div className="min-w-0"><label htmlFor="ambient-log" className="text-sm font-medium">Log run status</label>
          <p className="text-xs text-muted-foreground">Writes state and active-run count to the local server log.</p></div>
        <Switch id="ambient-log" checked={form.logging} onCheckedChange={logging => change({ logging })} />
      </div>
      <div className="flex h-16 items-center justify-between gap-4 border-t border-border">
        <div><label htmlFor="ambient-chroma" className="text-sm font-medium">Enable Chroma lighting</label>
          <p className="text-xs text-muted-foreground">Connect to the local Chroma service on this server.</p></div>
        <Switch id="ambient-chroma" checked={form.chroma} onCheckedChange={chroma => change({ chroma })} />
      </div>
      <div className="flex h-14 items-center justify-between gap-4 border-t border-border">
        <label htmlFor="ambient-animation" className="text-sm font-medium">Animate run state</label>
        <Switch id="ambient-animation" checked={form.animation} onCheckedChange={animation => change({ animation })} />
      </div>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Lighting devices</legend>
        <div className="grid h-32 grid-cols-2 gap-2 overflow-auto rounded-lg border border-border p-3">
          {DEVICES.map(device => <label key={device} className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.devices.includes(device)} onCheckedChange={checked => change({ devices: checked
              ? DEVICES.filter(d => d === device || form.devices.includes(d)) : form.devices.filter(d => d !== device) })} />
            {DEVICE_NAME[device]}</label>)}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">Each output also needs the global switch. Choose at least one lighting device. Chroma receives only colors; the log receives only state and active-run count.</p>
      <div className="flex flex-wrap gap-2"><PendingButton variant="secondary" pending={save.isPending} disabled={!dirty || !form.devices.length}
        onClick={() => save.mutate({ body: { ambient_enabled: form.enabled, ambient_log_enabled: form.logging,
          ambient_chroma_enabled: form.chroma, ambient_chroma_animation: form.animation, ambient_chroma_devices: form.devices }, message: "Ambient settings saved" },
          { onSuccess: () => { editing.current = false; } })}>Save ambient settings</PendingButton>
        {status.enabled && status.chroma.configured && status.chroma.phase === "unavailable" && <PendingButton variant="secondary" pending={save.isPending}
          onClick={() => save.mutate({ body: { ambient_chroma_retry: true }, message: "Retrying Chroma" })}>Retry Chroma connection</PendingButton>}
      </div>
      <p role="status" className="text-xs text-muted-foreground">Chroma: {status.chroma.phase === "unavailable" ? "Unavailable — local service did not accept the connection or request." : status.chroma.phase === "ready" ? "Connected" : status.chroma.phase === "connecting" ? "Connecting" : "Inactive"}</p>
    </SettingsCard>
    <SettingsCard title="Current signal" description="Active runs take priority over finished history. Among active runs, findings come first. Otherwise, only the newest run is shown. Success clears after 10 seconds; other finished results after 30.">
      <div role="status" className="flex h-10 items-center justify-between gap-3">
        <StatusPill tone={tone} size="sm">{status.output_error ? "Output unavailable" : LABEL[status.state]}</StatusPill>
        <span className="text-xs text-muted-foreground tabular-nums">{status.active_runs} active runs</span>
      </div>
      <div className="h-24 overflow-auto rounded-lg border border-border p-3 text-sm">
        {status.trace_id ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Project</dt><dd className="break-all">{status.project ?? "Unnamed project"}</dd>
          <dt className="text-muted-foreground">Workflow</dt><dd className="break-all">{status.workflow ?? "Unnamed workflow"}</dd>
          <dt className="text-muted-foreground">Run</dt><dd className="break-all font-mono text-xs">{status.trace_id}</dd>
        </dl> : <p className="text-muted-foreground">{status.subscribed ? "No run selected." : "No output is active."}</p>}
      </div>
      <p className="text-xs text-muted-foreground">A finished run is successful only after checks settle without open findings or failed checks. Incomplete checks do not mean the run failed.</p>
    </SettingsCard>
  </>;
}
