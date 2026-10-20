import type { Explanation } from "@/lib/api";
import { EvidenceChips } from "./evidence-chips";

/** A cause, the suggested fix, and the spans that show it. */
export function ExplanationBlock({ exp, names, onPick }: { exp: Explanation; names?: Map<string, string>; onPick: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-foreground">{exp.cause}</p>
      {exp.fix && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Suggested fix</span>
          <p className="text-sm text-foreground">{exp.fix}</p>
        </div>
      )}
      <EvidenceChips ids={exp.evidence_span_ids} names={names} onPick={onPick} />
    </div>
  );
}
