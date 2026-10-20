
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { tv } from "tailwind-variants";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * `ToggleChip` is a rounded-full toggle pill button. When `active`, it shows a
 * leading checkmark glyph and the info-surface treatment; when inactive it is a
 * plain bordered pill. It is a real `<button type="button">` with
 * `aria-pressed`, so it is keyboard operable. Styled entirely through semantic
 * design tokens so it adapts to light and dark automatically.
 *
 * Use for on/off expression chips, filter pills, and similar multi-select
 * toggles (e.g. triage's `Needs action` / `Has traces`, pii-redaction toggles).
 */
const toggleChipVariants = tv({
  base: "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors select-none focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50",
  variants: {
    active: {
      true: "border-info-border bg-info-surface text-info-fg hover:bg-info-surface/80",
      false: "border-border bg-background text-foreground hover:bg-muted",
    },
  },
  defaultVariants: {
    active: false,
  },
});

export interface ToggleChipProps {
  /** Whether the chip is in the on/selected state. */
  active: boolean;
  className?: string;
  disabled?: boolean;
  /** Chip content (usually a short string). */
  label: React.ReactNode;
  /** Fired when the chip is clicked or activated via keyboard. */
  onToggle: () => void;
  /**
   * When true, the inactive state renders a faint hollow circle in place of the
   * checkmark, so the chip width stays stable across the toggle (no layout
   * shift). Defaults to false (inactive renders no leading glyph).
   */
  showInactivePlaceholder?: boolean;
}

export function ToggleChip({
  active,
  onToggle,
  label,
  className,
  disabled,
  showInactivePlaceholder = false,
  ref,
}: ToggleChipProps & { ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      aria-pressed={active}
      className={cn(toggleChipVariants({ active }), className)}
      disabled={disabled}
      onClick={onToggle}
      ref={ref}
      type="button"
    >
      {active && (
        <Icon
          aria-hidden
          className="shrink-0"
          icon={CheckmarkCircle02Icon}
          size="xxs"
        />
      )}
      {!active && showInactivePlaceholder && (
        <span
          aria-hidden
          className="size-3.5 shrink-0 rounded-full border border-current opacity-30"
        />
      )}
      <span>{label}</span>
    </button>
  );
}
ToggleChip.displayName = "ToggleChip";

export { toggleChipVariants };
