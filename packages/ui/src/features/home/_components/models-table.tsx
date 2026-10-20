import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Insights } from "@/lib/api";
import { costValue, costDetail } from "@/lib/cost";
import { dur, num } from "@/lib/format";

export function ModelsTable({ data }: { data: Insights }) {
  if (!data.models.length) return null;
  return <Panel className="p-0">
    <PanelHeader className="mb-0 px-5 pt-4" title="Models" />
    <PanelContent className="h-80 flex-none overflow-auto">
      <Table className="min-w-[42rem] table-fixed">
        <TableHeader className="sticky top-0 bg-surface-subtle"><TableRow>
          {["Model", "Calls", "Errors", "Tokens", "Median", "Estimated cost"].map((s) => <TableHead key={s} className="px-3">{s}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>{data.models.map((m) => <TableRow key={m.name} className="h-11">
          <TableCell className="truncate px-3 font-mono text-xs" title={m.name}>{m.name}</TableCell>
          <TableCell className="px-3">{num(m.calls)}</TableCell><TableCell className="px-3">{num(m.errors)}</TableCell>
          <TableCell className="px-3">{num(m.tokens)}</TableCell><TableCell className="px-3">{dur(m.p50_ms)}</TableCell>
          <TableCell className="px-3 py-1 text-xs leading-4 tabular-nums" title={costDetail(m)}>{costValue(m)}<span className="block truncate text-muted-foreground">{m.unpriced_calls} calls unpriced{m.fallback_calls ? " · cache fallback" : ""}</span></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </PanelContent>
  </Panel>;
}
