"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import type * as React from "react";

const Collapsible = CollapsiblePrimitive.Root;

type CollapsibleTriggerProps = Omit<
  CollapsiblePrimitive.Trigger.Props,
  "render"
> & {
  asChild?: boolean;
};

const CollapsibleTrigger = ({
  asChild,
  children,
  ...props
}: CollapsibleTriggerProps) => (
  <CollapsiblePrimitive.Trigger
    {...props}
    render={asChild ? (children as React.ReactElement) : undefined}
  >
    {asChild ? null : children}
  </CollapsiblePrimitive.Trigger>
);

type CollapsibleContentProps = Omit<
  CollapsiblePrimitive.Panel.Props,
  "keepMounted"
> & {
  forceMount?: boolean;
};

const CollapsibleContent = ({
  forceMount,
  ...props
}: CollapsibleContentProps) => (
  <CollapsiblePrimitive.Panel keepMounted={forceMount} {...props} />
);

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
