import type * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"textarea">) => (
  <textarea
    className={cn(
      "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex min-h-[60px] w-full rounded-lg border bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-1 focus-visible:outline-hidden focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    ref={ref}
    {...props}
  />
);
Textarea.displayName = "Textarea";

export { Textarea };
