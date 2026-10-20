"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import * as React from "react";

import { cn } from "@/lib/utils";

const DEFAULT_TOOLTIP_DELAY_MS = 500;

/** Box-shadow biased toward the trigger so the caret reads lifted without flooding the panel interior. */
const TOOLTIP_ARROW_EXTERNAL_SHADOW =
  // design-allow: directional single-sided caret shadows (offset toward trigger per side) — not a uniform elevation depth
  "group-data-[side=bottom]:shadow-[0_-4px_10px_-3px_rgba(0,0,0,0.12)] group-data-[side=top]:shadow-[0_4px_10px_-3px_rgba(0,0,0,0.12)] group-data-[side=left]:shadow-[4px_0_10px_-3px_rgba(0,0,0,0.12)] group-data-[side=right]:shadow-[-4px_0_10px_-3px_rgba(0,0,0,0.12)]";

const TooltipProviderDelayContext =
  React.createContext<TooltipPrimitive.Provider.Props["delay"]>(undefined);

function TooltipProvider({
  delay,
  delayDuration,
  ...props
}: TooltipPrimitive.Provider.Props & {
  delayDuration?: number;
}) {
  const providerDelay = delayDuration ?? delay ?? DEFAULT_TOOLTIP_DELAY_MS;

  return (
    <TooltipProviderDelayContext value={providerDelay}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delay={providerDelay}
        {...props}
      />
    </TooltipProviderDelayContext>
  );
}

const TooltipDelayContext =
  React.createContext<TooltipPrimitive.Trigger.Props["delay"]>(undefined);

function Tooltip({
  delayDuration,
  ...props
}: TooltipPrimitive.Root.Props & {
  delayDuration?: number;
}) {
  return (
    <TooltipDelayContext value={delayDuration}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipDelayContext>
  );
}

/** Use inside an existing `TooltipProvider` — avoids nested providers on dense UIs. */
function TooltipRoot({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  asChild = false,
  children,
  delay,
  ...props
}: Omit<TooltipPrimitive.Trigger.Props, "render"> & {
  asChild?: boolean;
}) {
  const rootDelay = React.useContext(TooltipDelayContext);
  const providerDelay = React.useContext(TooltipProviderDelayContext);

  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      delay={
        delay ??
        rootDelay ??
        (providerDelay === undefined ? DEFAULT_TOOLTIP_DELAY_MS : undefined)
      }
      render={asChild ? (children as React.ReactElement) : undefined}
      {...props}
    >
      {asChild ? null : children}
    </TooltipPrimitive.Trigger>
  );
}

type TooltipContentProps = Omit<
  TooltipPrimitive.Popup.Props,
  "className" | "children"
> &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  > & {
    arrowClassName?: string;
    children?: React.ReactNode;
    className?: string;
    externalArrowShadow?: boolean;
    portalContainer?: TooltipPrimitive.Portal.Props["container"];
    showArrow?: boolean;
  };

function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  children,
  arrowClassName,
  externalArrowShadow = false,
  showArrow = true,
  portalContainer,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal container={portalContainer}>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="isolate z-[var(--z-tooltip)]"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "group fade-in-0 zoom-in-95 data-[ending-style]:fade-out-0 data-[ending-style]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 animate-in bg-foreground text-background data-[ending-style]:animate-out z-[var(--z-tooltip)] w-max max-w-[min(20rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-lg px-3 py-1.5 text-left text-xs leading-snug text-pretty",
            className
          )}
          data-slot="tooltip-content"
          {...props}
          role="tooltip"
        >
          {children}
          {showArrow && (
            <TooltipPrimitive.Arrow
              className={cn(
                "z-[var(--z-tooltip)] size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-xs data-[side=bottom]:top-1 data-[side=inline-end]:-left-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:-right-1 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-translate-y-1/2 data-[side=left]:-right-1 data-[side=left]:top-1/2! data-[side=left]:-translate-y-1/2 data-[side=right]:-left-1 data-[side=right]:top-1/2! data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5",
                externalArrowShadow && TOOLTIP_ARROW_EXTERNAL_SHADOW,
                arrowClassName ?? "bg-foreground fill-foreground"
              )}
            />
          )}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export {
  DEFAULT_TOOLTIP_DELAY_MS,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
};
