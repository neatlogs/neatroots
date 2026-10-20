import { Upload01Icon } from "@hugeicons/core-free-icons";
import { useRef, useState } from "react";
import { CodeLine } from "@/components/code-line";
import { PendingButton } from "@/components/pending-button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useImportActions } from "../_services/ingest-queries";

/** Trace files: drop them here, or `neatroots import` from a terminal. */
export function ImportTab() {
  const { file } = useImportActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const read = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) file.mutate({ name: f.name, content: await f.text() });
  };
  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void read(e.dataTransfer.files);
        }}
        className={cn("flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center transition-colors", over ? "border-foreground/40 bg-surface-subtle" : "border-border")}
      >
        <Icon icon={Upload01Icon} size="md" className="text-muted-foreground" />
        <span className="text-sm text-foreground">Drop trace files here</span>
        <span className="max-w-md text-xs text-muted-foreground">OTLP JSON (an exporter's file output or a collector dump), Neatlogs Cloud trace exports, or Neatlogs HTTP traces. One per file, or one per line in .jsonl.</span>
        <input ref={inputRef} type="file" accept=".json,.jsonl,.ndjson,application/json" multiple className="hidden" onChange={(e) => void read(e.target.files)} />
        <PendingButton size="sm" variant="secondary" pending={file.isPending} onClick={() => inputRef.current?.click()}>
          Choose files
        </PendingButton>
      </div>
      <CodeLine text={`neatroots import traces.json export.jsonl   # the same from a terminal`} />
    </div>
  );
}
