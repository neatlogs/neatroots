"use client";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@/lib/utils";

type SeparatorProps = SeparatorPrimitive.Props & {
  decorative?: boolean;
};

const Separator = ({
  className,
  decorative = true,
  orientation = "horizontal",
  ref,
  ...props
}: SeparatorProps) => (
  <SeparatorPrimitive
    className={cn(
      "bg-border shrink-0",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className
    )}
    orientation={orientation}
    ref={ref}
    {...props}
    {...(decorative
      ? { "aria-orientation": undefined, role: "none" as const }
      : {})}
  />
);
Separator.displayName = "Separator";

export type { SeparatorProps };
export { Separator };
