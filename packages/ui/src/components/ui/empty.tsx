import { tv, type VariantProps } from "tailwind-variants";

import { cn } from "@/lib/utils";

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-lg border-dashed p-6 text-center text-balance md:p-12",
        className
      )}
      data-slot="empty"
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex max-w-sm flex-col items-center gap-2 text-center",
        className
      )}
      data-slot="empty-header"
      {...props}
    />
  );
}

const emptyMediaVariants = tv({
  base: "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  variants: {
    variant: {
      default: "bg-transparent",
      icon: "group/empty-media relative isolate h-14 w-20 overflow-visible text-foreground [&_svg:not([class*='size-'])]:size-5",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function EmptyMedia({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  if (variant === "icon") {
    return (
      <div
        className={cn(emptyMediaVariants({ variant, className }))}
        data-slot="empty-icon"
        data-variant={variant}
        {...props}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 z-0 m-auto size-11 -translate-x-3 -rotate-6 rounded-lg border border-border bg-muted opacity-90 transition-transform duration-300 ease-in-out group-hover/empty-media:-translate-x-4 group-hover/empty-media:-rotate-12 motion-reduce:transition-none"
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 z-0 m-auto size-11 translate-x-3 rotate-6 rounded-lg border border-border bg-card opacity-90 transition-transform duration-300 ease-in-out group-hover/empty-media:translate-x-4 group-hover/empty-media:rotate-12 motion-reduce:transition-none"
        />
        <span className="relative z-10 m-auto flex size-12 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-[transform,box-shadow] duration-300 ease-in-out group-hover/empty-media:shadow-[var(--elevation-overlay)] motion-reduce:transition-none">
          {children}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(emptyMediaVariants({ variant, className }))}
      data-slot="empty-icon"
      data-variant={variant}
      {...props}
    >
      {children}
    </div>
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-base font-medium tracking-tight", className)}
      data-slot="empty-title"
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      className={cn(
        "text-muted-foreground [&>a:hover]:text-primary text-sm/relaxed [&>a]:underline [&>a]:underline-offset-4",
        className
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance",
        className
      )}
      data-slot="empty-content"
      {...props}
    />
  );
}

export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
};
