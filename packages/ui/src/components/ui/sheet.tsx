"use client";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { cn } from "@/lib/utils";

interface LegacySheetEvent {
  preventDefault: () => void;
  target?: EventTarget | null;
}

const SheetContext = React.createContext<{
  setInteractOutside: (
    handler: ((event: LegacySheetEvent) => void) | undefined
  ) => void;
} | null>(null);

const Sheet = ({
  onOpenChange,
  children,
  ...props
}: Omit<SheetPrimitive.Root.Props, "onOpenChange"> & {
  onOpenChange?: (open: boolean) => void;
}) => {
  const interactOutsideRef = React.useRef<
    ((event: LegacySheetEvent) => void) | undefined
  >(undefined);
  const contextValue = React.useMemo(
    () => ({
      setInteractOutside: (
        handler: ((event: LegacySheetEvent) => void) | undefined
      ) => {
        interactOutsideRef.current = handler;
      },
    }),
    []
  );

  return (
    <SheetContext.Provider value={contextValue}>
      <SheetPrimitive.Root
        {...props}
        onOpenChange={(open, details) => {
          if (!open && details.reason === "outside-press") {
            let prevented = false;
            interactOutsideRef.current?.({
              target: details.event.target,
              preventDefault: () => {
                prevented = true;
                details.cancel();
              },
            });
            if (prevented) return;
          }
          onOpenChange?.(open);
        }}
      >
        {children}
      </SheetPrimitive.Root>
    </SheetContext.Provider>
  );
};

const SheetTrigger = ({
  asChild = false,
  children,
  ...props
}: Omit<SheetPrimitive.Trigger.Props, "render"> & { asChild?: boolean }) => (
  <SheetPrimitive.Trigger
    render={asChild ? (children as React.ReactElement) : undefined}
    {...props}
  >
    {asChild ? null : children}
  </SheetPrimitive.Trigger>
);

const SheetClose = ({
  asChild = false,
  children,
  ...props
}: Omit<SheetPrimitive.Close.Props, "render"> & { asChild?: boolean }) => (
  <SheetPrimitive.Close
    render={asChild ? (children as React.ReactElement) : undefined}
    {...props}
  >
    {asChild ? null : children}
  </SheetPrimitive.Close>
);

const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = ({
  className,
  ref,
  ...props
}: SheetPrimitive.Backdrop.Props & { ref?: React.Ref<HTMLDivElement> }) => (
  <SheetPrimitive.Backdrop
    className={cn(
      "data-[ending-style]:fade-out-0 data-[open]:fade-in-0 data-[ending-style]:animate-out data-[open]:animate-in data-[ending-style]:duration-300 fixed inset-0 z-[var(--z-modal-backdrop)] bg-black/80",
      className
    )}
    {...props}
    ref={ref}
  />
);
SheetOverlay.displayName = "SheetOverlay";

const sheetVariants = tv({
  base: "fixed z-[var(--z-modal)] gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[ending-style]:duration-300 data-[ending-style]:animate-out data-[open]:duration-500 data-[open]:animate-in",
  variants: {
    side: {
      top: "inset-x-0 top-0 border-b data-[ending-style]:slide-out-to-top data-[open]:slide-in-from-top",
      bottom:
        "inset-x-0 bottom-0 border-t data-[ending-style]:slide-out-to-bottom data-[open]:slide-in-from-bottom",
      left: "inset-y-0 left-0 h-full w-3/4 border-r data-[ending-style]:slide-out-to-left data-[open]:slide-in-from-left sm:max-w-sm",
      right:
        "inset-y-0 right-0 h-full w-3/4 border-l data-[ending-style]:slide-out-to-right data-[open]:slide-in-from-right sm:max-w-sm",
    },
  },
  defaultVariants: {
    side: "right",
  },
});

interface SheetContentProps
  extends
    Omit<SheetPrimitive.Popup.Props, "className" | "children">,
    VariantProps<typeof sheetVariants> {
  children?: React.ReactNode;
  className?: string;
  /** When true, omit the default top-right close control (use an in-flow header close instead). */
  hideClose?: boolean;
  onInteractOutside?: (event: LegacySheetEvent) => void;
  overlayClassName?: string;
}

const SheetContent = ({
  side = "right",
  className,
  children,
  hideClose = false,
  onInteractOutside,
  overlayClassName,
  ref,
  ...props
}: SheetContentProps & {
  ref?: React.Ref<HTMLDivElement>;
}) => {
  const sheetContext = React.useContext(SheetContext);
  sheetContext?.setInteractOutside(onInteractOutside);

  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Popup
        className={cn(sheetVariants({ side }), className)}
        ref={ref}
        {...props}
      >
        {hideClose ? null : (
          <SheetPrimitive.Close className="absolute top-4 right-4 cursor-pointer rounded-lg border border-border bg-secondary p-1 opacity-70 transition-opacity hover:bg-accent hover:opacity-100 focus:ring-0 focus:outline-hidden disabled:pointer-events-none">
            <HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
        {children}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
};
SheetContent.displayName = "SheetContent";

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = ({
  className,
  ref,
  ...props
}: SheetPrimitive.Title.Props & { ref?: React.Ref<HTMLHeadingElement> }) => (
  <SheetPrimitive.Title
    className={cn("text-foreground text-base font-semibold", className)}
    ref={ref}
    {...props}
  />
);
SheetTitle.displayName = "SheetTitle";

const SheetDescription = ({
  className,
  ref,
  ...props
}: SheetPrimitive.Description.Props & {
  ref?: React.Ref<HTMLParagraphElement>;
}) => (
  <SheetPrimitive.Description
    className={cn("text-muted-foreground text-sm", className)}
    ref={ref}
    {...props}
  />
);
SheetDescription.displayName = "SheetDescription";

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
