import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";

import { cn } from "@/lib/utils";

/**
 * The data shape of a hugeicons icon (`@hugeicons/core-free-icons` export).
 * Re-exported so feature code can type stored/passed icons via the design-system
 * entry point instead of importing from `@hugeicons/react` directly (which the
 * icon gate bans outside primitives). Use as: `icon: IconData`.
 */
export type IconData = HugeiconsIconProps["icon"];

const ICON_SIZE = {
  xxs: "size-3.5",
  xs: "size-3",
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
  xl: "size-8",
} as const;

export type IconSize = keyof typeof ICON_SIZE;

export function Icon({
  size = "sm",
  className,
  ...props
}: HugeiconsIconProps & { size?: IconSize }) {
  return (
    <HugeiconsIcon
      className={cn(ICON_SIZE[size], className)}
      data-slot="icon"
      {...props}
    />
  );
}
