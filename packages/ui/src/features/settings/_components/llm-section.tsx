import { useState } from "react";
import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import { PendingButton } from "@/components/pending-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status-pill";
import { Switch } from "@/components/ui/switch";
import type { LlmInfo, Status } from "@/lib/api";
import { useLlm, useLlmActions, useSaveSettings } from "../_services/settings-queries";
import { KeyInput, OptionSelect, SettingField } from "./form";
import { SettingsCard, SettingsLoading, SettingsToggleCard } from "./settings-shell";

const REDACT = [
  { value: "secrets", label: "Secrets: keys, tokens, private keys" },
  { value: "all", label: "Secrets, emails, phone numbers and your Cloud patterns" },
  { value: "off", label: "Nothing" },
];

/**
 * Where the LLM runs: this machine by default, or a hosted provider the user turns on.
 * The LLM plans checks, explains problems, writes notes and summarizes runs.
 */
export function LlmSection({ status }: { status: Status }) {
  const { data: llm, error } = useLlm();
  const actions = useLlmActions();
  if (!llm) {
    return error ? (
      <EmptyState variant="bordered" state="error" title="Couldn't load the LLM settings" description={(error as Error).message} />
    ) : (
      <SettingsLoading rows={2} />
    );
  }
  const hostedOn = llm.config.enabled;
  const preset = llm.providers.find((p) => p.id === llm.config.provider);
  const canTurnOn = !!preset?.key && !!(llm.config.model || preset?.default_model);
  const active = llm.active === "local" ? `${llm.local.model} on this machine` : llm.active ? `${llm.external?.model} at ${llm.external?.label}` : null;
  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-subtle px-4 py-3 text-sm">
        <StatusPill size="sm" tone={active ? "success" : "warning"} dot={active ? "solid" : false}>
          {active ? "Answering" : "No LLM"}
        </StatusPill>
        <span className="min-w-0 truncate text-muted-foreground">{active ?? "Rules still run. Start a local model or turn on a hosted one for questions and explanations."}</span>
      </div>
      <SettingsCard title="This machine" description="Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, MLX. Nothing leaves your machine.">
        <LocalLlm llm={llm} status={status} />
      </SettingsCard>
      <SettingsToggleCard
        icon={AiBrain01Icon}
        title="Hosted LLM"
        enabled={hostedOn}
        status={
          hostedOn ? (
            <StatusPill size="sm" tone={llm.external?.ok ? "success" : "warning"} dot="solid">
              {llm.external?.label} · {llm.external?.ok ? "on" : "unreachable"}
            </StatusPill>
          ) : undefined
        }
        description="Claude, OpenAI, OpenRouter, Gemini, Groq, Mistral, Together or any OpenAI-compatible URL. Opt-in: the run content each task needs is sent to the provider."
        control={
          <Switch
            aria-label="Use a hosted LLM"
            checked={hostedOn}
            disabled={!hostedOn && !canTurnOn}
            onCheckedChange={(v) => actions.save.mutate({ body: { enabled: v }, message: v ? `${preset?.label ?? "Hosted LLM"} is on` : "The LLM runs on this machine only" })}
          />
        }
      >
        <div className="flex flex-col gap-4 border-t border-border pt-4">
          <HostedLlm llm={llm} />
        </div>
      </SettingsToggleCard>
    </>
  );
}

function LocalLlm({ llm, status }: { llm: LlmInfo; status: Status }) {
  const save = useSaveSettings();
  const actions = useLlmActions();
  const [url, setUrl] = useState(status.config.llm.baseUrl);
  const [model, setModel] = useState(status.config.llm.model);
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <StatusPill size="sm" tone={llm.local.ok ? "success" : "warning"}>{llm.local.ok ? "Running" : "Not found"}</StatusPill>
        <span className="min-w-0 truncate text-muted-foreground">
          {llm.local.ok ? (
            <>
              <span className="font-mono text-foreground">{llm.local.model}</span> at {llm.local.baseUrl}
            </>
          ) : (
            `${llm.local.error ?? "unavailable"}. Start Ollama or LM Studio, or use a hosted provider.`
          )}
        </span>
      </div>
      <Collapsible>
        <CollapsibleTrigger className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Change the local server</CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-4 pt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SettingField label="Server URL" htmlFor="llm-url" hint="Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, MLX.">
              <Input id="llm-url" className="h-8 font-mono text-xs" value={url} onChange={(e) => setUrl(e.target.value)} />
            </SettingField>
            <SettingField label="Model" htmlFor="llm-model" hint={`"auto" picks an installed model for this machine (${status.tier.memoryGb} GB).`}>
              <Input id="llm-model" className="h-8 font-mono text-xs" value={model} onChange={(e) => setModel(e.target.value)} />
            </SettingField>
          </div>
          <div>
            <PendingButton variant="secondary" pending={save.isPending} onClick={() => save.mutate({ body: { llm_base_url: url, llm_model: model }, message: "Local LLM saved" })}>
              Save local server
            </PendingButton>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

function HostedLlm({ llm }: { llm: LlmInfo }) {
  const actions = useLlmActions();
  const cfg = llm.config;
  const [provider, setProvider] = useState(cfg.provider);
  const preset = llm.providers.find((p) => p.id === provider) ?? llm.providers[0];
  const same = provider === cfg.provider;
  const [model, setModel] = useState(same ? cfg.model || preset.default_model : preset.default_model);
  const [baseUrl, setBaseUrl] = useState(same ? cfg.baseUrl : "");
  const [redact, setRedact] = useState(cfg.redact);
  const [fallback, setFallback] = useState(cfg.fallbackToLocal);
  const [models, setModels] = useState<string[]>([]);
  const hasKey = !!preset.key;
  const on = cfg.enabled && same;
  const choose = (id: string) => {
    const p = llm.providers.find((x) => x.id === id);
    setProvider(id);
    setModel(id === cfg.provider ? cfg.model : (p?.default_model ?? ""));
    setBaseUrl(id === cfg.provider ? cfg.baseUrl : "");
    setModels([]);
  };
  const body = { provider, model, base_url: baseUrl, redact, fallback_to_local: fallback };
  const options = [...new Set([...preset.suggested, ...models])];

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SettingField label="Provider" htmlFor="ext-provider">
          <OptionSelect id="ext-provider" className="h-8" value={provider} onValueChange={choose} options={llm.providers.map((p) => ({ value: p.id, label: p.label }))} />
        </SettingField>
        <SettingField label="Model" htmlFor="ext-model" hint={hasKey ? undefined : "Store a key to list this provider's models."}>
          <div className="flex items-center gap-2">
            <Input id="ext-model" list="ext-models" className="h-8 font-mono text-xs" placeholder="model id" value={model} onChange={(e) => setModel(e.target.value)} />
            <datalist id="ext-models">
              {options.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {hasKey && same && (
              <PendingButton size="sm" variant="ghost" pending={actions.models.isPending} onClick={() => actions.models.mutate(undefined, { onSuccess: (r) => setModels(r.models) })}>
                List models
              </PendingButton>
            )}
          </div>
        </SettingField>
      </div>
      {(provider === "custom" || baseUrl) && (
        <SettingField label="Base URL" htmlFor="ext-url" hint="OpenAI-compatible, ending in /v1 for most servers.">
          <Input id="ext-url" className="h-8 font-mono text-xs" placeholder={preset.base_url || "https://…/v1"} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </SettingField>
      )}
      <SettingField
        label={`${preset.label} API key`}
        htmlFor="ext-key"
        hint={
          preset.key?.startsWith("env:") ? (
            `Read from $${preset.key.slice(4)}.`
          ) : preset.key_url && !hasKey ? (
            <>
              Stored in the macOS Keychain.{" "}
              <a className="underline-offset-4 hover:text-foreground hover:underline" href={preset.key_url} target="_blank" rel="noreferrer">
                Get an API key from {preset.label}
              </a>
            </>
          ) : (
            "Stored in the macOS Keychain, never in the neatroots database."
          )
        }
      >
        <KeyInput
          id="ext-key"
          label={`${preset.label} API key`}
          stored={hasKey}
          storing={actions.storeKey.isPending}
          onStore={(k, done) => actions.storeKey.mutate({ provider, key: k }, { onSuccess: done })}
          onRemove={preset.key === "stored" ? () => actions.removeKey.mutate(provider) : undefined}
        />
      </SettingField>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SettingField label="Remove before sending" htmlFor="ext-redact">
          <OptionSelect id="ext-redact" className="h-8" value={redact} onValueChange={(v) => setRedact(v as typeof redact)} options={REDACT} />
        </SettingField>
        <label className="flex h-8 items-center justify-between gap-3 self-end rounded-lg bg-surface-subtle px-3 text-sm text-foreground">
          <span className="truncate">Use the local LLM if {preset.label} fails</span>
          <Switch aria-label="Fall back to the local LLM" checked={fallback} onCheckedChange={setFallback} />
        </label>
      </div>
      <p className="text-xs text-warning-fg">
        When on, the run content each LLM task needs is sent to {preset.label}. Rules, stored runs and this app stay on this machine. Removing personal data can make the
        personal-data check miss leaks.
      </p>
      {llm.external?.enabled && same && !llm.external.ok && llm.external.error && <p className="text-xs text-danger-fg">{llm.external.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {on ? (
          <PendingButton variant="secondary" pending={actions.save.isPending} onClick={() => actions.save.mutate({ body, message: "Hosted LLM saved" })}>
            Save changes
          </PendingButton>
        ) : (
          <PendingButton
            disabled={!hasKey || !model}
            pending={actions.save.isPending}
            onClick={() => actions.save.mutate({ body: { ...body, enabled: true }, message: `${preset.label} is on` })}
          >
            Use {preset.label}
          </PendingButton>
        )}
        {on && (
          <PendingButton variant="ghost" pending={actions.test.isPending} onClick={() => actions.test.mutate()}>
            Test connection
          </PendingButton>
        )}
        {!hasKey && <span className="text-xs text-muted-foreground">Store a key first.</span>}
      </div>
    </>
  );
}
