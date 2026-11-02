/** Spans a problem points at, by name; each opens the span. Repeated names get a number. */
export function EvidenceChips({ ids, names, onPick, max = 6 }: { ids: string[]; names?: Map<string, string>; onPick: (id: string) => void; max?: number }) {
  if (!ids.length) return null;
  const seen = new Map<string, number>();
  const label = (id: string) => {
    const name = names?.get(id) ?? id.slice(0, 8);
    const total = ids.filter((x) => (names?.get(x) ?? x.slice(0, 8)) === name).length;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return total > 1 ? `${name} #${n}` : name;
  };
  return (
    <div data-testid="evidence-chip-list" className="flex min-w-0 flex-col items-start gap-1.5">
      <span className="text-xs text-muted-foreground">Seen in</span>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
        {ids.slice(0, max).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            title={`Open span ${id}`}
            className="min-w-0 max-w-full cursor-pointer whitespace-normal break-words rounded-md border border-border bg-background px-2 py-0.5 font-mono text-2xs text-foreground transition-colors hover:bg-surface-subtle focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {label(id)}
          </button>
        ))}
      </div>
      {ids.length > max && <span className="text-xs text-muted-foreground">+{ids.length - max} more</span>}
    </div>
  );
}
