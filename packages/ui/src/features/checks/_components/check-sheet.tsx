import { useState } from "react";
import { NeatBadge } from "@/components/neat-ui/neat-badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { CheckRow } from "@/lib/api";
import { pct } from "@/lib/format";
import { CHECK_SOURCE } from "../../runs/_libs/labels";

/** One check in a side sheet: its YAML and what you can do with it. */
export function CheckSheet({ check, onClose, onEdit, onDelete }: { check: CheckRow | undefined; onClose: () => void; onEdit: (yaml: string) => void; onDelete: (id: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const src = check ? (CHECK_SOURCE[check.source] ?? CHECK_SOURCE.library) : null;
  return (
    <>
      <Sheet open={!!check} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          {check && src && (
            <>
              <SheetHeader className="gap-2 border-b border-border px-6 py-4 pr-12">
                <SheetTitle className="text-base font-normal">{check.title}</SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-2 text-xs">
                  <NeatBadge size="sm" variant={src.variant}>
                    {src.label}
                  </NeatBadge>
                  <span className="font-mono">{check.id}</span>
                  {check.precision.hits > 0 && (
                    <span className="tabular-nums">
                      · {check.precision.hits} counted findings, {check.precision.dismissed} dismissed
                      {check.precision.precision !== null ? ` (${pct(check.precision.precision)} kept)` : ""}
                    </span>
                  )}
                </SheetDescription>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
                <p className="text-xs text-muted-foreground">
                  Each finding counts once after it is raised or made active. Failed checks and findings recorded while quiet count only if later raised or made active. Dismissals lower the kept percentage. Older totals are preserved.
                </p>
                <pre className="rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{check.yaml}</pre>
                {check.path && <span className="font-mono text-2xs text-muted-foreground">{check.path}</span>}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
                {check.source !== "library" && (
                  <Button variant="ghost" className="text-danger-fg" onClick={() => setConfirm(true)}>
                    Delete check
                  </Button>
                )}
                <Button variant="secondary" onClick={() => onEdit(check.yaml)}>
                  Edit a copy
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${check?.id}?`}
        description="The check is removed from its file and stops running on new runs. Findings it already raised stay. You can't undo this."
        confirmLabel="Delete check"
        destructive
        onConfirm={() => {
          if (check) onDelete(check.id);
          setConfirm(false);
        }}
      />
    </>
  );
}
