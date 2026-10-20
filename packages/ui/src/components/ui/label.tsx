"use client";

import type * as React from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { cn } from "@/lib/utils";

const labelVariants = tv({
  base: "text-sm leading-none font-normal peer-disabled:cursor-not-allowed peer-disabled:opacity-70 peer-data-disabled:cursor-not-allowed peer-data-disabled:opacity-70",
});

const Label = ({
  className,
  ...props
}: React.ComponentProps<"label"> & VariantProps<typeof labelVariants>) => (
  // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- shared label associates via htmlFor or a nested control at its call site
  <label className={cn(labelVariants(), className)} {...props} />
);
Label.displayName = "Label";

export { Label };
