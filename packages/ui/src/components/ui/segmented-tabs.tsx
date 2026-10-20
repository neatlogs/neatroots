"use client";

import { motion } from "motion/react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface SegmentedTabItem<T extends string = string> {
  badge?: React.ReactNode;
  disabled?: boolean;
  dividerBefore?: boolean;
  label: React.ReactNode;
  value: T;
}

export interface SegmentedTabsProps<T extends string = string> extends Omit<
  React.ComponentProps<"div">,
  "onChange"
> {
  items: SegmentedTabItem<T>[];
  layoutId?: string;
  onValueChange: (value: T) => void;
  size?: "compact" | "default";
  /**
   * "highlight" (default) — the sliding surface-subtle box behind the active tab.
   * "pill" — each tab is a rounded-full bordered pill (the filter-chip look); the
   * active pill takes the info-blue treatment. No sliding indicator.
   */
  variant?: "highlight" | "pill";
  value: T;
}

const TAB_SPRING = { type: "spring" as const, stiffness: 500, damping: 35 };
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

export function SegmentedTabs<T extends string = string>({
  value,
  onValueChange,
  items,
  className,
  size = "default",
  variant = "highlight",
  layoutId,
  ...props
}: SegmentedTabsProps<T>) {
  const isPill = variant === "pill";
  const generatedLayoutId = React.useId();
  const indicatorLayoutId = layoutId ?? `segmented-tabs-${generatedLayoutId}`;
  const listRef = React.useRef<HTMLDivElement>(null);

  // Roving arrow-key navigation over the enabled tabs (automatic activation).
  const enabled = items.filter((item) => !item.disabled);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!NAV_KEYS.has(event.key) || enabled.length === 0) {
      return;
    }
    event.preventDefault();
    const current = Math.max(
      0,
      enabled.findIndex((item) => item.value === value)
    );
    let next = current;
    if (event.key === "ArrowRight") {
      next = (current + 1) % enabled.length;
    } else if (event.key === "ArrowLeft") {
      next = (current - 1 + enabled.length) % enabled.length;
    } else if (event.key === "Home") {
      next = 0;
    } else {
      next = enabled.length - 1;
    }
    const nextValue = enabled[next].value;
    if (nextValue !== value) {
      onValueChange(nextValue);
    }
    const tabs = listRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]:not([disabled])'
    );
    tabs?.[next]?.focus();
  };

  return (
    <div
      {...props}
      aria-orientation="horizontal"
      className={cn(
        "flex items-center",
        isPill ? "gap-1.5" : "gap-1",
        className
      )}
      data-slot="segmented-tabs"
      onKeyDown={onKeyDown}
      ref={listRef}
      role="tablist"
      tabIndex={-1}
    >
      {items.map((item) => {
        const isActive = value === item.value;

        return (
          <div className="flex items-center gap-1" key={item.value}>
            {item.dividerBefore ? (
              <div className="mx-1.5 h-4 w-px shrink-0 bg-border" />
            ) : null}

            <button
              aria-selected={isActive}
              className={cn(
                "relative inline-flex items-center justify-center transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-inset",
                isPill
                  ? cn(
                      // Match the filter-chip pill: rounded-full, bordered, xs.
                      "h-7 rounded-full border px-2.5 text-xs focus-visible:ring-info-fg/60",
                      item.disabled
                        ? "border-border text-foreground-subtle cursor-not-allowed"
                        : isActive
                          ? "border-info-border bg-info-surface text-info-fg font-medium"
                          : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer font-normal"
                    )
                  : cn(
                      "focus-visible:ring-ring rounded focus-visible:ring-1",
                      size === "compact"
                        ? "h-6 px-2 text-xs"
                        : "h-7 px-2.5 text-sm",
                      item.disabled
                        ? "text-foreground-subtle cursor-not-allowed"
                        : isActive
                          ? "text-foreground z-10 font-medium"
                          : "text-muted-foreground hover:text-foreground z-10 cursor-pointer font-normal"
                    )
              )}
              disabled={item.disabled}
              onClick={() => {
                if (!item.disabled && item.value !== value) {
                  onValueChange(item.value);
                }
              }}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              type="button"
            >
              {isActive && !item.disabled && !isPill ? (
                <motion.div
                  className="absolute inset-0 -z-10 rounded border border-border bg-surface-subtle"
                  layoutId={indicatorLayoutId}
                  transition={TAB_SPRING}
                />
              ) : null}

              <span className="relative inline-flex items-center">
                {item.label}
                {item.badge}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
