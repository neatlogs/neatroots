import type * as React from "react";

import { cn } from "@/lib/utils";

const Input = ({
  className,
  type,
  ref,
  ...props
}: React.ComponentProps<"input">) => (
  <input
    className={cn(
      // design-allow: variant-prefixed type utilities (file:font-medium / file:text-sm), not a single-element role combo
      "border-input text-foreground file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full rounded-lg border bg-transparent px-3 py-1 text-sm font-normal transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-1 focus-visible:outline-hidden focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    ref={ref}
    type={type}
    {...props}
  />
);
Input.displayName = "Input";

export { Input };
