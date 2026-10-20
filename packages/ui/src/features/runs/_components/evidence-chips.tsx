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
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Seen in</span>
      {ids.slice(0, max).map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onPick(id)}
          title={`Open span ${id}`}
          className="max-w-56 cursor-pointer truncate rounded-md border border-border bg-background px-2 py-0.5 font-mono text-2xs text-foreground transition-colors hover:bg-surface-subtle focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {label(id)}
        </button>
      ))}
      {ids.length > max && <span className="text-xs text-muted-foreground">+{ids.length - max} more</span>}
    </div>
  );
}
