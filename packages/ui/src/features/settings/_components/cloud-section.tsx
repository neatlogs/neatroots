import { CloudIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { StatusPill } from "@/components/ui/status-pill";
import { Textarea } from "@/components/ui/textarea";
import type { Status } from "@/lib/api";
import { ago } from "@/lib/format";
import { useCloudImportAuth, useCloudProjects, useForwards, useKeyActions, useSaveSettings } from "../_services/settings-queries";
import { KeyInput, OptionSelect, SettingField } from "./form";
import { SettingsCard, SettingsToggleCard } from "./settings-shell";

const REGIONS = [
  { value: "https://ingest.neatlogs.com", label: "US · ingest.neatlogs.com" },
  { value: "https://eu.ingest.neatlogs.com", label: "EU · eu.ingest.neatlogs.com" },
];

export function CloudSection({ status }: { status: Status }) {
  const save = useSaveSettings();
  const keys = useKeyActions("/api/cloud/key", "Neatlogs Cloud");
  const { data } = useForwards();
  const [endpoint, setEndpoint] = useState(status.cloud.endpoint);
  const [patterns, setPatterns] = useState((status.cloud.redact_patterns ?? []).join("\n"));
  const regions = REGIONS.some((r) => r.value === endpoint) ? REGIONS : [...REGIONS, { value: endpoint, label: endpoint }];
  const connected = status.cloud.has_key;
  return (
    <>
      <SettingsToggleCard
        icon={CloudIcon}
        title="Neatlogs Cloud"
        enabled={connected}
        status={
          <StatusPill size="sm" tone={connected ? "success" : "muted"} dot={connected ? "solid" : false}>
            {connected ? "API key stored" : "Not connected"}
          </StatusPill>
        }
        description="Send runs you want to keep or share. Runs are redacted before they leave; nothing is sent unless you send it."
        control={null}
      >
        <SettingField label="Project API key from app.neatlogs.com" htmlFor="nl-key" hint="Sends runs, like the SDK does. Stored in the macOS Keychain, never in the neatroots database.">
          <KeyInput
            id="nl-key"
            label="Neatlogs Cloud API key"
            stored={connected}
            storing={keys.store.isPending}
            onStore={(k, done) => keys.store.mutate(k, { onSuccess: done })}
            onRemove={() => keys.remove.mutate()}
          />
        </SettingField>
      </SettingsToggleCard>
      <ImportAuthCard status={status} />
      <SettingsCard title="Region and redaction" description="Emails, phone numbers and keys are always redacted before a send.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingField label="Ingest region" htmlFor="nl-endpoint">
            <OptionSelect id="nl-endpoint" className="h-8" value={endpoint} onValueChange={setEndpoint} options={regions} />
          </SettingField>
          <SettingField label="Extra redaction patterns" htmlFor="nl-patterns" hint="One regex per line.">
            <Textarea id="nl-patterns" rows={2} className="resize-none font-mono text-xs" placeholder="cust_[0-9]+" value={patterns} onChange={(e) => setPatterns(e.target.value)} />
          </SettingField>
        </div>
        <div>
          <PendingButton
            variant="secondary"
            pending={save.isPending}
            onClick={() =>
              save.mutate({
                body: {
                  cloud_endpoint: endpoint,
                  redact_patterns: patterns.split("\n").map((x) => x.trim()).filter(Boolean),
                },
                message: "Cloud settings saved",
              })
            }
          >
            Save cloud settings
          </PendingButton>
        </div>
      </SettingsCard>
      <SettingsCard title="Recent sends" description={data?.forwards.length ? undefined : "Runs you send to Neatlogs Cloud are logged here."} contentClassName="p-0">
        {!!data?.forwards.length && (
          <ul className="flex max-h-72 flex-col overflow-y-auto border-t border-border">
            {data.forwards.map((f) => (
              <li key={f.id} className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 px-6 text-xs text-muted-foreground tabular-nums last:border-0" title={f.error ?? undefined}>
                <StatusPill size="sm" tone={f.status === "ok" ? "success" : "danger"}>
                  {f.status === "ok" ? "Sent" : "Failed"}
                </StatusPill>
                <span className="min-w-0 flex-1 truncate font-mono">{f.trace_ids.map((t) => t.slice(0, 8)).join(", ")}</span>
                <span className="shrink-0">{f.span_count} spans</span>
                <span className="hidden shrink-0 sm:inline">{f.redactions} redacted</span>
                <span className="w-20 shrink-0 text-right">{ago(f.created_ms)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}

/** Reading traces back from Neatlogs Cloud: a service-account token and the project to read. */
function ImportAuthCard({ status }: { status: Status }) {
  const auth = useCloudImportAuth();
  const hasToken = !!status.cloud.has_token;
  const projects = useCloudProjects(hasToken);
  const list = projects.data?.projects ?? [];
  const current = status.cloud.project_id ?? "";
  return (
    <SettingsCard
      title="Import from Neatlogs Cloud"
      description="Bring production traces here to explain, check and replay them. Reading needs a service-account token (nlsa_…); the project API key above can only send."
    >
      <SettingField
        label="Service-account token"
        htmlFor="nl-token"
        hint={
          <>
            Create one in Neatlogs (see the{" "}
            <a href="https://docs.neatlogs.com/api-reference" target="_blank" rel="noreferrer" className="text-foreground underline-offset-4 hover:underline">
              public API docs
            </a>
            ). Stored in the macOS Keychain.
          </>
        }
      >
        <KeyInput
          id="nl-token"
          label="Neatlogs service-account token"
          noun="token"
          placeholder="nlsa_…"
          stored={hasToken}
          storing={auth.storeToken.isPending}
          onStore={(t, done) => auth.storeToken.mutate(t, { onSuccess: done })}
          onRemove={() => auth.remove.mutate()}
        />
      </SettingField>
      {hasToken && (
        <SettingField label="Project to import from" htmlFor="nl-project" hint={projects.error ? (projects.error as Error).message : list.length ? undefined : projects.isLoading ? "Loading the token's projects…" : "The token can't read any project."}>
          <OptionSelect
            id="nl-project"
            className="h-8 sm:max-w-sm"
            label="Project to import from"
            value={current || "none"}
            onValueChange={(v) => v !== "none" && v !== current && auth.setProject.mutate(v)}
            options={[...(current ? [] : [{ value: "none", label: list.length ? "Choose a project" : "No project" }]), ...list.map((p) => ({ value: p.id, label: `${p.name}${p.isDefault ? " (default)" : ""}` }))]}
          />
        </SettingField>
      )}
      {hasToken && (
        <a href="#/add-data/cloud" className="text-sm text-foreground underline-offset-4 hover:underline">
          Import traces from Neatlogs Cloud
        </a>
      )}
    </SettingsCard>
  );
}
