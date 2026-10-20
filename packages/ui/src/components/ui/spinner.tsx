import { Loading03Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";

import { cn } from "@/lib/utils";

import { Icon } from "./icon";

export interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: "xxs" | "xs" | "sm" | "md" | "lg" | "xl";
}

export function Spinner({ size = "sm", className, ...props }: SpinnerProps) {
  return (
    <div
      aria-label="Loading"
      className={cn(
        "text-muted-foreground flex animate-spin items-center justify-center",
        className
      )}
      data-slot="spinner"
      role="img"
      {...props}
    >
      <Icon icon={Loading03Icon} size={size} />
    </div>
  );
}
