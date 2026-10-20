"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface LegacyDialogEvent {
  defaultPrevented?: boolean;
  key?: string;
  preventDefault: () => void;
  target?: EventTarget | null;
}

interface DialogHandlers {
  onEscapeKeyDown?: (event: LegacyDialogEvent) => void;
  onInteractOutside?: (event: LegacyDialogEvent) => void;
  onOpenAutoFocus?: (event: LegacyDialogEvent) => void;
  onPointerDownOutside?: (event: LegacyDialogEvent) => void;
}

const DialogContext = React.createContext<{
  setHandlers: (handlers: DialogHandlers) => void;
} | null>(null);

type DialogProps = Omit<DialogPrimitive.Root.Props, "onOpenChange"> & {
  onOpenChange?: (open: boolean) => void;
};

const Dialog = ({ onOpenChange, children, ...props }: DialogProps) => {
  const handlersRef = React.useRef<DialogHandlers>({});
  const contextValue = React.useMemo(
    () => ({
      setHandlers: (handlers: DialogHandlers) => {
        handlersRef.current = handlers;
      },
    }),
    []
  );

  return (
    <DialogContext.Provider value={contextValue}>
      <DialogPrimitive.Root
        {...props}
        onOpenChange={(open, details) => {
          const event = {
            defaultPrevented: false,
            key: details.reason === "escape-key" ? "Escape" : undefined,
            target: details.event.target,
            preventDefault: () => {
              event.defaultPrevented = true;
              details.cancel();
            },
          };
          if (details.reason === "escape-key") {
            handlersRef.current.onEscapeKeyDown?.(event);
          }
          if (details.reason === "outside-press") {
            handlersRef.current.onPointerDownOutside?.(event);
            handlersRef.current.onInteractOutside?.(event);
          }
          if (!open && event.defaultPrevented) {
            return;
          }
          onOpenChange?.(open);
        }}
      >
        {children}
      </DialogPrimitive.Root>
    </DialogContext.Provider>
  );
};

const DialogTrigger = ({
  asChild = false,
  children,
  ...props
}: Omit<DialogPrimitive.Trigger.Props, "render"> & { asChild?: boolean }) => (
  <DialogPrimitive.Trigger
    render={asChild ? (children as React.ReactElement) : undefined}
    {...props}
  >
    {asChild ? null : children}
  </DialogPrimitive.Trigger>
);

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = ({
  asChild = false,
  children,
  ...props
}: Omit<DialogPrimitive.Close.Props, "render"> & { asChild?: boolean }) => (
  <DialogPrimitive.Close
    render={asChild ? (children as React.ReactElement) : undefined}
    {...props}
  >
    {asChild ? null : children}
  </DialogPrimitive.Close>
);

const DialogOverlay = ({
  className,
  ref,
  ...props
}: DialogPrimitive.Backdrop.Props & { ref?: React.Ref<HTMLDivElement> }) => (
  <DialogPrimitive.Backdrop
    className={cn(
      "data-[ending-style]:fade-out-0 data-[open]:fade-in-0 data-[ending-style]:animate-out data-[open]:animate-in fixed inset-0 z-[var(--z-modal-backdrop)] bg-black/80",
      className
    )}
    ref={ref}
    {...props}
  />
);
DialogOverlay.displayName = "DialogOverlay";

const DialogContent = ({
  className,
  children,
  closeDisabled,
  forceMount,
  hideClose,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onInteractOutside,
  onOpenAutoFocus,
  onPointerDownOutside,
  overlayClassName,
  ref,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "className" | "children" | "render"> & {
  /** Disable the built-in close affordance while a controlled action is pending. */
  closeDisabled?: boolean;
  /** Hide the built-in top-right close X (use when the dialog renders its own close affordance). */
  hideClose?: boolean;
  forceMount?: boolean;
  overlayClassName?: string;
  onCloseAutoFocus?: (event: LegacyDialogEvent) => void;
  onEscapeKeyDown?: (event: LegacyDialogEvent) => void;
  onInteractOutside?: (event: LegacyDialogEvent) => void;
  onOpenAutoFocus?: (event: LegacyDialogEvent) => void;
  onPointerDownOutside?: (event: LegacyDialogEvent) => void;
  children?: React.ReactNode;
  className?: string;
  ref?: React.Ref<HTMLDivElement>;
}) => {
  const dialogContext = React.useContext(DialogContext);
  dialogContext?.setHandlers({
    onEscapeKeyDown,
    onInteractOutside,
    onOpenAutoFocus,
    onPointerDownOutside,
  });

  const initialFocus = onOpenAutoFocus
    ? () => {
        let prevented = false;
        onOpenAutoFocus({
          defaultPrevented: false,
          preventDefault: () => (prevented = true),
        });
        return !prevented;
      }
    : undefined;
  const finalFocus = onCloseAutoFocus
    ? () => {
        let prevented = false;
        onCloseAutoFocus({
          defaultPrevented: false,
          preventDefault: () => (prevented = true),
        });
        return !prevented;
      }
    : undefined;

  return (
    <DialogPortal keepMounted={forceMount}>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        className={cn(
          "data-[ending-style]:fade-out-0 data-[open]:fade-in-0 data-[ending-style]:zoom-out-95 data-[open]:zoom-in-95 bg-background data-[ending-style]:animate-out data-[open]:animate-in fixed top-[50%] left-[50%] z-[var(--z-modal)] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border p-6 shadow-lg duration-200 sm:rounded-xl",
          className
        )}
        finalFocus={finalFocus}
        initialFocus={initialFocus}
        ref={ref}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute top-4 right-4 cursor-pointer rounded-md text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-hidden focus-visible:ring-inset disabled:pointer-events-none"
            disabled={closeDisabled}
          >
            <Icon icon={Cancel01Icon} size="sm" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
};
DialogContent.displayName = "DialogContent";

/**
 * Dialog content for an in-place surface that must stay mounted. Unlike
 * DialogContent, this does not portal or render the standard overlay.
 */
const DialogInlineContent = ({
  asChild = false,
  children,
  forceMount = false,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onInteractOutside,
  onOpenAutoFocus,
  onPointerDownOutside,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "render"> & {
  asChild?: boolean;
  forceMount?: boolean;
  onCloseAutoFocus?: (event: LegacyDialogEvent) => void;
  onEscapeKeyDown?: (event: LegacyDialogEvent) => void;
  onInteractOutside?: (event: LegacyDialogEvent) => void;
  onOpenAutoFocus?: (event: LegacyDialogEvent) => void;
  onPointerDownOutside?: (event: LegacyDialogEvent) => void;
}) => {
  const dialogContext = React.useContext(DialogContext);
  dialogContext?.setHandlers({
    onEscapeKeyDown,
    onInteractOutside,
    onOpenAutoFocus,
    onPointerDownOutside,
  });

  const initialFocus = onOpenAutoFocus
    ? () => {
        let prevented = false;
        onOpenAutoFocus({
          defaultPrevented: false,
          preventDefault: () => (prevented = true),
        });
        return !prevented;
      }
    : undefined;
  const finalFocus = onCloseAutoFocus
    ? () => {
        let prevented = false;
        onCloseAutoFocus({
          defaultPrevented: false,
          preventDefault: () => (prevented = true),
        });
        return !prevented;
      }
    : undefined;

  const [container, setContainer] = React.useState<HTMLDivElement | null>(null);

  return (
    <div ref={setContainer} style={{ display: "contents" }}>
      {container ? (
        <DialogPortal container={container} keepMounted={forceMount}>
          <DialogPrimitive.Popup
            finalFocus={finalFocus}
            hidden={forceMount ? false : undefined}
            initialFocus={initialFocus}
            render={asChild ? (children as React.ReactElement) : undefined}
            {...props}
          >
            {asChild ? null : children}
          </DialogPrimitive.Popup>
        </DialogPortal>
      ) : null}
    </div>
  );
};
DialogInlineContent.displayName = "DialogInlineContent";

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
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
DialogFooter.displayName = "DialogFooter";

const DialogTitle = ({
  className,
  ref,
  ...props
}: DialogPrimitive.Title.Props & { ref?: React.Ref<HTMLHeadingElement> }) => (
  <DialogPrimitive.Title
    className={cn(
      "text-base leading-none font-semibold tracking-tight",
      className
    )}
    ref={ref}
    {...props}
  />
);
DialogTitle.displayName = "DialogTitle";

const DialogDescription = ({
  className,
  ref,
  ...props
}: DialogPrimitive.Description.Props & {
  ref?: React.Ref<HTMLParagraphElement>;
}) => (
  <DialogPrimitive.Description
    className={cn("text-muted-foreground text-sm", className)}
    ref={ref}
    {...props}
  />
);
DialogDescription.displayName = "DialogDescription";

const DialogHeaderRow = ({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)}
    data-slot="dialog-header-row"
    {...props}
  >
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-2">
        {icon && (
          <div
            className="shrink-0 text-foreground"
            data-slot="dialog-header-icon"
          >
            {icon}
          </div>
        )}
        <DialogTitle>{title}</DialogTitle>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
    {description && <DialogDescription>{description}</DialogDescription>}
  </div>
);
DialogHeaderRow.displayName = "DialogHeaderRow";

const DialogActionRow = ({
  primary,
  secondary,
  tertiary,
  className,
  ...props
}: {
  primary?: React.ReactNode;
  secondary?: React.ReactNode;
  tertiary?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className
    )}
    data-slot="dialog-action-row"
    {...props}
  >
    {tertiary && <div className="sm:mr-auto">{tertiary}</div>}
    <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
      {secondary}
      {primary}
    </div>
  </div>
);
DialogActionRow.displayName = "DialogActionRow";

export {
  Dialog,
  DialogActionRow,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeaderRow,
  DialogInlineContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
