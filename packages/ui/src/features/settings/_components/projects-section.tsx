import { useState } from "react";
import { CodeLine } from "@/components/code-line";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProjectRow } from "@/lib/api";
import { ago } from "@/lib/format";
import { useProjects, useRerunTarget, useSaveSettings } from "../_services/settings-queries";
import { OptionSelect, SettingField } from "./form";
import { SettingsCard, SettingsLoading } from "./settings-shell";

const MODES: { value: string; label: string; help: string }[] = [
  { value: "off", label: "Off", help: "Nothing is sent to the agent." },
  { value: "advisory", label: "Advisory", help: "Notes go into the agent's next LLM call." },
  { value: "gate", label: "Gate", help: "LLM calls wait up to 300 ms for checks." },
  { value: "self-check", label: "Self-check", help: "The agent gets a check_my_work tool." },
];

const HEAD = "h-9 px-3 text-eyebrow font-normal text-muted-foreground";

/** How neatroots re-runs a project's agent for replays: a command, or an HTTP endpoint the agent serves. */
function ReplayDialog({ project, onClose }: { project: ProjectRow; onClose: () => void }) {
  const cur = project.rerun;
  const [command, setCommand] = useState(cur?.command ?? "");
  const [cwd, setCwd] = useState(cur?.cwd ?? "");
  const [url, setUrl] = useState(cur?.url ?? "");
  const save = useRerunTarget();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Replay {project.project}</DialogTitle>
          <DialogDescription>
            To re-run the whole agent (with a different input, model or system prompt), tell neatroots how to start it once. Use a command, or an HTTP endpoint your agent serves on this machine.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <SettingField label="Command" htmlFor="rr-cmd" hint="Runs with NEATROOTS_REPLAY_INPUT, _MODEL and _SYSTEM_PROMPT set. neatroots_steer.replay_input() reads the input; wrap() applies the rest.">
            <Input id="rr-cmd" className="h-8 font-mono text-xs" placeholder="python agent.py" value={command} onChange={(e) => setCommand(e.target.value)} />
          </SettingField>
          <SettingField label="Working folder" htmlFor="rr-cwd">
            <Input id="rr-cwd" className="h-8 font-mono text-xs" placeholder="/path/to/your/agent" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </SettingField>
          <SettingField label="Or an HTTP replay endpoint" htmlFor="rr-url" hint="neatroots POSTs {replay_id, replay_of, input, model, system_prompt}; the agent runs and sends its trace.">
            <Input id="rr-url" className="h-8 font-mono text-xs" placeholder="http://localhost:8000/replay" value={url} onChange={(e) => setUrl(e.target.value)} />
          </SettingField>
        </div>
        <DialogFooter className="gap-2">
          {cur && (
            <Button variant="ghost" className="mr-auto text-danger-fg" onClick={() => save.mutate({ project: project.project, command: "", url: "" }, { onSuccess: onClose })}>
              Remove replay
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <PendingButton disabled={!command.trim() && !url.trim()} pending={save.isPending} onClick={() => save.mutate({ project: project.project, command, cwd, url }, { onSuccess: onClose })}>
            Save replay
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsSection({ steerPython, steerTs }: { steerPython?: string | null; steerTs?: string | null }) {
  const { data, isLoading } = useProjects();
  const save = useSaveSettings();
  const [replayFor, setReplayFor] = useState<ProjectRow>();
  if (isLoading) return <SettingsLoading rows={1} />;
  const projects = data?.projects ?? [];
  return (
    <>
      <SettingsCard title="Projects" description="A project is the SDK's workflow_name (service.name). Steering and forwarding stay off until you turn them on." contentClassName="p-0">
        {projects.length === 0 ? (
          <p className="border-t border-border px-6 py-4 text-sm text-muted-foreground">Projects appear here after their first run reaches neatroots.</p>
        ) : (
          <div className="max-h-[30rem] overflow-auto border-t border-border">
            <Table className="min-w-[48rem] table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-surface-subtle">
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className={`${HEAD} pl-6`}>Project</TableHead>
                  <TableHead className={`${HEAD} w-24 text-right`}>Runs</TableHead>
                  <TableHead className={`${HEAD} w-56`}>Steering</TableHead>
                  <TableHead className={`${HEAD} w-28`}>Forward</TableHead>
                  <TableHead className={`${HEAD} w-32 pr-6`}>Replay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((p) => (
                  <TableRow key={p.project} className="h-16 hover:bg-transparent">
                    <TableCell className="px-3 pl-6">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-foreground">{p.project}</span>
                        <span className="text-xs text-muted-foreground">{p.last_ms ? `last run ${ago(p.last_ms)}` : "no runs yet"}</span>
                      </span>
                    </TableCell>
                    <TableCell className="px-3 text-right text-sm tabular-nums">
                      <span className="flex flex-col">
                        {p.runs}
                        <span className="text-xs text-muted-foreground">{p.with_findings} with findings</span>
                      </span>
                    </TableCell>
                    <TableCell className="px-3">
                      <span className="flex flex-col gap-1">
                        <OptionSelect
                          label={`Steering for ${p.project}`}
                          className="h-8 w-36"
                          value={p.settings.steering}
                          onValueChange={(v) => save.mutate({ body: { project: p.project, steering: v }, message: `Steering for ${p.project}: ${v}` })}
                          options={MODES}
                        />
                        <span className="truncate text-xs text-muted-foreground">{MODES.find((m) => m.value === p.settings.steering)?.help}</span>
                      </span>
                    </TableCell>
                    <TableCell className="px-3">
                      <Switch
                        aria-label={`Forward ${p.project} runs to Neatlogs Cloud`}
                        checked={p.settings.forward}
                        onCheckedChange={(v) =>
                          save.mutate({ body: { project: p.project, forward: v }, message: v ? `Finished ${p.project} runs will be sent to Neatlogs Cloud` : `Forwarding for ${p.project} is off` })
                        }
                      />
                    </TableCell>
                    <TableCell className="px-3 pr-6">
                      <Button size="sm" variant={p.rerun ? "ghost" : "secondary"} onClick={() => setReplayFor(p)}>
                        {p.rerun ? (p.rerun.url ? "Endpoint" : "Command") : "Set up"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsCard>
      <SettingsCard title="Steering hook" description="Steering and replay overrides need a small hook in your agent. Wrap the LLM client you already use.">
        <SettingField label="Python">
          <CodeLine text={`pip install ${steerPython ?? "~/.neatroots/app/steer/python/neatroots-steer"}\n\nimport neatroots_steer\nclient = neatroots_steer.wrap(OpenAI())`} />
        </SettingField>
        <SettingField label="TypeScript">
          <CodeLine text={`npm install ${steerTs ?? "~/.neatroots/app/steer/ts"}\n\nimport { wrapOpenAI } from "@neatlogs/neatroots-steer";\nconst client = wrapOpenAI(new OpenAI());`} />
        </SettingField>
      </SettingsCard>
      {replayFor && <ReplayDialog project={replayFor} onClose={() => setReplayFor(undefined)} />}
    </>
  );
}
