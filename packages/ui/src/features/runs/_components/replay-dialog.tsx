import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Span } from "@/lib/api";
import { go } from "@/lib/router";
import { useSpanDetail } from "../_services/run-queries";
import { useReplay, useReplayOptions } from "../_services/view-queries";

type Msg = { role: string; content: string };

function toMessages(v: unknown): Msg[] {
  if (!Array.isArray(v)) return typeof v === "string" ? [{ role: "user", content: v }] : [];
  return v
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && "role" in m)
    .map((m) => ({ role: String(m.role), content: typeof m.content === "string" ? m.content : m.content == null ? "" : JSON.stringify(m.content) }));
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * Replay a run: the whole agent again with a changed input, model or system prompt, or one LLM
 * call with edited messages. Either way the result is a new run, checked like any other.
 */
export function ReplayDialog({ traceId, spans, initialSpan, onClose }: { traceId: string; spans: Span[]; initialSpan?: string; onClose: () => void }) {
  const { data: opts } = useReplayOptions(traceId, true);
  const replay = useReplay(traceId);
  const llmSpans = useMemo(() => spans.filter((s) => s.span_kind === "LLM").sort((a, b) => a.start_ms - b.start_ms), [spans]);
  const [mode, setMode] = useState<"run" | "llm">(initialSpan ? "llm" : "run");
  const [input, setInput] = useState<string | undefined>();
  const [system, setSystem] = useState<string | undefined>();
  const [model, setModel] = useState("");
  const [spanId, setSpanId] = useState(initialSpan ?? llmSpans.at(-1)?.span_id);
  const { data: span } = useSpanDetail(traceId, mode === "llm" ? spanId : undefined);
  const [messages, setMessages] = useState<Msg[]>([]);
  useEffect(() => {
    setMessages(toMessages(span?.view.input));
  }, [span?.span_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const body =
      mode === "llm"
        ? { span_id: spanId, messages, model: model || undefined }
        : { input: input ?? opts?.default_input, system: system !== undefined && system !== (opts?.system ?? "") ? system : undefined, model: model || undefined };
    replay.mutate(body, {
      onSuccess: (r) => {
        if (r.state === "failed") toast.error(`Replay failed: ${r.error}`);
        else if (r.state === "succeeded" && r.new_trace_id) {
          toast.success("Replayed. Opening the new run.");
          go(`runs/${r.new_trace_id}`);
        } else toast.success("Re-running the agent. The new run appears under Replays when it arrives.");
        onClose();
      },
      onError: (e) => toast.error(`Couldn't replay: ${(e as Error).message}`),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Replay this run</DialogTitle>
          <DialogDescription>The result is a new run linked to this one, and neatroots checks it like any other, so you can see whether a change fixed the problem.</DialogDescription>
        </DialogHeader>
        <SegmentedTabs
          size="compact"
          value={mode}
          onValueChange={setMode}
          items={[
            { value: "run", label: "Re-run the agent" },
            { value: "llm", label: "One LLM call", disabled: !llmSpans.length },
          ]}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-1">
          {mode === "run" ? (
            opts && !opts.run ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-subtle px-4 py-3 text-sm">
                <span className="text-foreground">neatroots doesn't know how to start {opts.project ?? "this agent"} yet.</span>
                <span className="text-muted-foreground">Add the command that runs it once (or an HTTP replay endpoint) in Settings → Projects, or replay a single LLM call instead.</span>
                <div>
                  <Button size="sm" variant="secondary" onClick={() => (onClose(), go("settings/projects"))}>
                    Set up replay
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Field label="User input" hint={opts?.run ? `Runs ${opts.run.command ?? opts.run.url} with NEATROOTS_REPLAY_INPUT set.` : undefined}>
                  <Textarea rows={4} value={input ?? opts?.default_input ?? ""} onChange={(e) => setInput(e.target.value)} />
                </Field>
                <Field label="System prompt (applied by the neatroots-steer hook)">
                  <Textarea rows={3} className="font-mono text-xs" value={system ?? opts?.system ?? ""} onChange={(e) => setSystem(e.target.value)} placeholder="Leave as recorded" />
                </Field>
              </>
            )
          ) : (
            <>
              <Field label="LLM call">
                <Select value={spanId} onValueChange={(v) => setSpanId(String(v))}>
                  <SelectTrigger aria-label="LLM call" className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {llmSpans.map((s, i) => (
                      <SelectItem key={s.span_id} value={s.span_id}>
                        Call {i + 1} · {s.model ?? s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Messages {opts?.llm.available ? `· sent to ${opts.llm.model ?? "your LLM"} (${opts.llm.where === "local" ? "this machine" : opts.llm.where})` : "· no LLM is available; start one in Settings → LLM"}</span>
                {messages.map((m, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <span className="text-eyebrow text-2xs text-muted-foreground">{m.role}</span>
                    <Textarea rows={Math.min(8, Math.max(2, m.content.split("\n").length))} className="text-sm" value={m.content} onChange={(e) => setMessages(messages.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} />
                  </div>
                ))}
              </div>
            </>
          )}
          <Field label="Model (optional)" hint={mode === "llm" ? "Empty uses your configured LLM's model." : "Empty keeps the agent's model; the steering hook applies a change."}>
            <Input className="h-8 font-mono text-xs" placeholder="e.g. gpt-4o-mini, claude-haiku-4-5, qwen3:8b" value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <PendingButton
            pending={replay.isPending}
            pendingLabel={mode === "llm" ? "Replaying…" : "Starting…"}
            disabled={mode === "run" ? !opts?.run : !messages.length || !opts?.llm.available}
            onClick={submit}
          >
            {mode === "llm" ? "Replay LLM call" : "Re-run agent"}
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
