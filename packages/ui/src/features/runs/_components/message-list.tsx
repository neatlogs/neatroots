import { pretty } from "@/lib/format";
import { cn } from "@/lib/utils";

const GUIDANCE = /(<neatroots-guidance>[\s\S]*?<\/neatroots-guidance>)/g;

function Content({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "null") return null;
  const text = typeof value === "string" ? value : pretty(value);
  return (
    <>
      {text.split(GUIDANCE).map((part, i) =>
        part.startsWith("<neatroots-guidance>") ? (
          <span key={i} className="my-1.5 block rounded-sm border-l-2 border-brand-violet bg-muted px-2.5 py-1.5">
            <span className="mb-1 block text-micro text-brand-violet">Added by neatroots</span>
            {part.replace(/<\/?neatroots-guidance>\n?/g, "").trim()}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** LLM messages as role-labeled blocks; anything else as a JSON well. */
export function MessageList({ value }: { value: unknown }) {
  if (value === undefined) return <p className="text-sm text-muted-foreground">Not captured by the SDK.</p>;
  if (Array.isArray(value) && value.length && value.every((m) => m && typeof m === "object" && "role" in m)) {
    return (
      <div className="flex flex-col gap-2">
        {(value as Record<string, unknown>[]).map((m, i) => {
          const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as Record<string, unknown>[]) : [];
          const empty = (m.content === null || m.content === undefined || m.content === "null") && !calls.length;
          return (
            <div key={i} className="overflow-hidden rounded-md border border-border">
              <div className="border-b border-border bg-surface-subtle px-3 py-1.5 text-micro text-muted-foreground">{String(m.role)}</div>
              <div className="max-h-96 overflow-auto px-3 py-2 text-sm break-words whitespace-pre-wrap text-foreground">
                <Content value={m.content} />
                {calls.map((c, j) => (
                  <div key={j} className="font-mono text-xs text-muted-foreground">
                    → {String(c.name)}({typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments)})
                  </div>
                ))}
                {empty && <span className={cn("text-muted-foreground")}>{m.role === "assistant" ? "Tool call (the SDK did not record its arguments here)" : "Empty"}</span>}
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  if (typeof value === "string") {
    return (
      <div className="max-h-96 overflow-auto rounded-md border border-border bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap text-foreground">
        <Content value={value} />
      </div>
    );
  }
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-foreground">
      <Content value={value} />
    </pre>
  );
}
