import type * as React from "react";

import { cn } from "@/lib/utils";

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {}

export function Kbd({ className, children, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        // design-allow: hairline 1px bottom-edge keycap shadow — no elevation token fits a single-axis hairline
        "border-border bg-muted text-3xs text-muted-foreground pointer-events-none inline-flex h-5 items-center gap-1 rounded border px-1.5 font-mono font-medium shadow-[0_1px_0_rgba(0,0,0,0.06)] select-none",
        className
      )}
      data-slot="kbd"
      {...props}
    >
      {children}
    </kbd>
  );
}
