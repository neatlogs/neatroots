"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Loading03Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import type { VariantProps } from "tailwind-variants";

import { buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({
  asChild = false,
  children,
  ...props
}: Omit<AlertDialogPrimitive.Trigger.Props, "render"> & { asChild?: boolean }) {
  return (
    <AlertDialogPrimitive.Trigger
      data-slot="alert-dialog-trigger"
      render={asChild ? (children as React.ReactElement) : undefined}
      {...props}
    >
      {asChild ? null : children}
    </AlertDialogPrimitive.Trigger>
  );
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  );
}

function AlertDialogOverlay({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      className={cn(
        "data-[ending-style]:fade-out-0 data-[open]:fade-in-0 data-[ending-style]:animate-out data-[open]:animate-in fixed inset-0 z-[var(--z-modal-backdrop)] bg-black/50",
        className
      )}
      data-slot="alert-dialog-overlay"
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  children,
  forceMount,
  ...props
}: Omit<AlertDialogPrimitive.Popup.Props, "className" | "children"> & {
  className?: string;
  children?: React.ReactNode;
  forceMount?: boolean;
}) {
  return (
    <AlertDialogPortal keepMounted={forceMount}>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        className={cn(
          "data-[ending-style]:fade-out-0 data-[open]:fade-in-0 data-[ending-style]:zoom-out-95 data-[open]:zoom-in-95 bg-background data-[ending-style]:animate-out data-[open]:animate-in fixed top-[50%] left-[50%] z-[var(--z-modal)] grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
          className
        )}
        data-slot="alert-dialog-content"
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("text-base font-semibold", className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant = "default",
  isPending = false,
  disabled,
  children,
  onClick,
  ...props
}: Omit<AlertDialogPrimitive.Close.Props, "render"> &
  Pick<VariantProps<typeof buttonVariants>, "variant"> & {
    /** When true, prepend an animated spinner + disable (mirrors SubmitButton). */
    isPending?: boolean;
  }) {
  return (
    <AlertDialogPrimitive.Close
      className={cn(
        buttonVariants({ variant }),
        variant === "destructive" &&
          "text-white hover:text-white focus-visible:text-white",
        "gap-1.5",
        className
      )}
      disabled={disabled || isPending}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) {
          event.preventBaseUIHandler();
        }
      }}
      {...props}
    >
      {isPending ? (
        <Icon className="animate-spin" icon={Loading03Icon} size="sm" />
      ) : null}
      {children}
    </AlertDialogPrimitive.Close>
  );
}

function AlertDialogCancel({
  className,
  ...props
}: Omit<AlertDialogPrimitive.Close.Props, "render">) {
  return (
    <AlertDialogPrimitive.Close
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
