import type * as React from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { Icon, type IconData } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * StatusPill — a semantic-STATE pill (rounded-full) for connection / run /
 * health states like "Connected", "Live", "Failed", "Disconnected".
 *
 * This is intentionally distinct from `NeatBadge` (a business-CATEGORY badge:
 * environments, severities, roles, tags). StatusPill speaks the semantic status
 * vocabulary (success / danger / warning / info), plus `muted` and `neutral`
 * for low-salience or chromeless states, and it can render a leading status
 * `dot` (solid / ping / pulse) or a leading `icon`.
 *
 * Reproduces the hand-rolled pills in connected-status-card (ping dot +
 * border), integration-card (solid dot, no border), and the cursor live
 * thoughts ConnectionPill (pulse dot). For the uppercase ConnectionPill look,
 * pass `className="uppercase"`.
 */
const statusPillVariants = tv({
  base: "inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap transition-colors",
  variants: {
    tone: {
      success: "bg-success-surface text-success-fg",
      danger: "bg-danger-surface text-danger-fg",
      warning: "bg-warning-surface text-warning-fg",
      info: "bg-info-surface text-info-fg",
      muted: "bg-muted text-muted-foreground",
      neutral: "bg-surface-subtle text-foreground",
    },
    size: {
      default: "px-2.5 py-0.5 text-xs",
      sm: "px-2 py-0 text-2xs",
    },
    bordered: {
      true: "border",
      false: "",
    },
  },
  compoundVariants: [
    { bordered: true, tone: "success", class: "border-success-border" },
    { bordered: true, tone: "danger", class: "border-danger-border" },
    { bordered: true, tone: "warning", class: "border-warning-border" },
    { bordered: true, tone: "info", class: "border-info-border" },
    { bordered: true, tone: "muted", class: "border-border" },
    { bordered: true, tone: "neutral", class: "border-border" },
  ],
  defaultVariants: {
    tone: "neutral",
    size: "default",
    bordered: false,
  },
});

/** How the leading status dot animates. `false` = no dot. */
export type StatusPillDot = false | "solid" | "ping" | "pulse";

export interface StatusPillProps
  extends
    Omit<React.HTMLAttributes<HTMLSpanElement>, "color">,
    VariantProps<typeof statusPillVariants> {
  /** Leading status dot. Tinted with the tone's foreground (bg-current). */
  dot?: StatusPillDot;
  /** Leading HugeIcon (rendered via the Icon wrapper at size="xs"). */
  icon?: IconData;
}

function StatusPillDotIndicator({
  dot,
}: {
  dot: Exclude<StatusPillDot, false>;
}) {
  if (dot === "ping") {
    return (
      <span aria-hidden className="relative flex size-1.5 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-current",
        dot === "pulse" && "animate-pulse"
      )}
    />
  );
}

function StatusPill({
  className,
  tone,
  size,
  bordered,
  dot = false,
  icon,
  children,
  ...props
}: StatusPillProps) {
  return (
    <span
      className={statusPillVariants({ tone, size, bordered, className })}
      {...props}
    >
      {dot ? <StatusPillDotIndicator dot={dot} /> : null}
      {icon ? <Icon aria-hidden icon={icon} size="xs" /> : null}
      {children}
    </span>
  );
}
StatusPill.displayName = "StatusPill";

export { StatusPill, statusPillVariants };
