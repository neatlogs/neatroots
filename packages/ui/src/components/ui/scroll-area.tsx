
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type * as React from "react";

import { cn } from "@/lib/utils";

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  /** Merged onto the viewport; use for `max-h-*` caps (root `max-h` often fails with Radix). */
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  type?: "auto" | "always" | "scroll";
};

const ScrollArea = ({
  className,
  viewportClassName,
  viewportRef,
  children,
  ref,
  type: _type,
  ...props
}: ScrollAreaProps & { ref?: React.Ref<HTMLDivElement> }) => (
  <ScrollAreaPrimitive.Root
    className={cn("relative overflow-hidden", className)}
    ref={ref}
    {...props}
  >
    <ScrollAreaViewport
      className={cn(
        "w-full rounded-[inherit] [&>div]:block!",
        viewportClassName ?? "h-full"
      )}
      ref={viewportRef}
    >
      <ScrollAreaContent>{children}</ScrollAreaContent>
    </ScrollAreaViewport>
    <ScrollBar orientation="vertical" />
    <ScrollBar orientation="horizontal" />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
);
ScrollArea.displayName = "ScrollArea";

const ScrollBar = ({
  className,
  orientation = "vertical",
  ref,
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props & {
  ref?: React.Ref<HTMLDivElement>;
}) => (
  <ScrollAreaPrimitive.Scrollbar
    className={cn(
      "flex touch-none transition-colors select-none",
      orientation === "vertical" &&
        "h-full w-2 border-l border-l-transparent p-px",
      orientation === "horizontal" &&
        "h-2 flex-col border-t border-t-transparent p-px",
      className
    )}
    orientation={orientation}
    ref={ref}
    {...props}
  >
    <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-[var(--scrollbar-thumb)] transition-colors hover:bg-[var(--scrollbar-thumb-hover)]" />
  </ScrollAreaPrimitive.Scrollbar>
);
ScrollBar.displayName = "ScrollBar";

const ScrollAreaRoot = ScrollAreaPrimitive.Root;

const ScrollAreaViewport = ({
  ref,
  ...props
}: ScrollAreaPrimitive.Viewport.Props) => (
  <ScrollAreaPrimitive.Viewport
    {...props}
    data-slot="scroll-area-viewport"
    ref={ref}
  />
);

const ScrollAreaContent = ({
  ref,
  ...props
}: ScrollAreaPrimitive.Content.Props) => (
  <ScrollAreaPrimitive.Content
    {...props}
    data-slot="scroll-area-content"
    ref={ref}
  />
);
const ScrollAreaScrollbar = ScrollAreaPrimitive.Scrollbar;
const ScrollAreaThumb = ScrollAreaPrimitive.Thumb;
const ScrollAreaCorner = ScrollAreaPrimitive.Corner;

export {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
  ScrollBar,
};
