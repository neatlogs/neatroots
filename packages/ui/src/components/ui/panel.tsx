"use client";

import type * as React from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { cn } from "@/lib/utils";

const panelVariants = tv({
  base: "data-[slot=panel] flex flex-col border border-border",
  variants: {
    variant: {
      card: "rounded-xl bg-card p-6 shadow-[var(--elevation-card)]",
      flat: "rounded-lg bg-background p-4",
      subtle: "rounded-xl bg-surface-subtle p-5",
    },
  },
  defaultVariants: {
    variant: "card",
  },
});

export interface PanelProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof panelVariants> {}

export function Panel({ variant, className, ...props }: PanelProps) {
  return (
    <div
      className={cn(panelVariants({ variant }), className)}
      data-slot="panel"
      {...props}
    />
  );
}

export function PanelHeader({
  title,
  icon,
  actions,
  className,
  ...props
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-border/60 mb-4 flex items-center justify-between gap-4 border-b pb-3",
        className
      )}
      data-slot="panel-header"
      {...props}
    >
      <div className="flex items-center gap-2">
        {icon && <div className="shrink-0 text-muted-foreground">{icon}</div>}
        <h3 className="text-body-strong leading-tight tracking-tight text-foreground">
          {title}
        </h3>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

export function PanelContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("min-h-0 flex-1", className)}
      data-slot="panel-content"
      {...props}
    />
  );
}

export function PanelFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-border/60 mt-4 flex items-center justify-end gap-2 border-t pt-3",
        className
      )}
      data-slot="panel-footer"
      {...props}
    />
  );
}

Panel.Header = PanelHeader;
Panel.Content = PanelContent;
Panel.Footer = PanelFooter;
