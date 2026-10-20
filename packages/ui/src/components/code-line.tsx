import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

/** A command or snippet to copy: mono text in a recessed well, with the app's copy button. */
export function CodeLine({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted py-2 pr-1.5 pl-3", className)}>
      <pre className="min-w-0 flex-1 overflow-x-auto py-0.5 font-mono text-xs leading-5 whitespace-pre text-foreground">{text}</pre>
      <CopyButton content={text} copyMessage="Copied" />
    </div>
  );
}
