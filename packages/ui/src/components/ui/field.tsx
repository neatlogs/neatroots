"use client";

import type { ComponentProps } from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-7",
        className
      )}
      data-slot="field-group"
      {...props}
    />
  );
}

const fieldVariants = tv({
  base: "group/field flex w-full gap-3 data-[invalid=true]:text-destructive",
  defaultVariants: {
    orientation: "vertical",
  },
  variants: {
    orientation: {
      horizontal: "flex-row items-center",
      responsive:
        "flex-col @md/field-group:flex-row @md/field-group:items-center [&>*]:w-full [&>.sr-only]:w-auto",
      vertical: "flex-col [&>*]:w-full [&>.sr-only]:w-auto",
    },
  },
});

function Field({
  className,
  orientation = "vertical",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      className={cn(fieldVariants({ orientation }), className)}
      data-orientation={orientation}
      data-slot="field"
      role="group"
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return (
    <Label
      className={cn(
        "group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50",
        className
      )}
      data-slot="field-label"
      {...props}
    />
  );
}

export { Field, FieldGroup, FieldLabel };
