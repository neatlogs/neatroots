"use client";

import { useRender } from "@base-ui/react/use-render";
import { Menu01Icon, PanelLeftIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { SIDEBAR_COOKIE_NAME } from "@/components/ui/sidebar-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = "250px";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_WIDTH_ICON = "62px";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";
const SIDEBAR_RIGHT_INSET_DEFAULT_WIDTH_PX = 423;

interface SidebarContext {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
  setOpen: (open: boolean) => void;
  setOpenMobile: (open: boolean) => void;
  state: "expanded" | "collapsed";
  toggleSidebar: () => void;
}

const SidebarContext = React.createContext<SidebarContext | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

const SidebarProvider = ({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ref,
  ...props
}: (React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);

  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }

      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open]
  );

  const toggleSidebar = React.useCallback(
    () =>
      isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open),
    [isMobile, setOpen]
  );

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  const state = open ? "expanded" : "collapsed";

  const contextValue = React.useMemo<SidebarContext>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, toggleSidebar]
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider>
        <div
          className={cn(
            "group/sidebar-wrapper flex w-full",
            // LOCK WINDOW SCROLL & SET GRAY BACKGROUND
            "has-data-[variant=inset]:h-svh has-data-[variant=inset]:overflow-hidden has-data-[variant=inset]:p-2 md:has-data-[variant=inset]:p-2",
            "has-data-[variant=inset]:bg-surface-subtle dark:has-data-[variant=inset]:bg-background",
            className
          )}
          data-sidebar-wrapper=""
          ref={ref}
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
};
SidebarProvider.displayName = "SidebarProvider";

const Sidebar = ({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  open: openProp,
  onOpenChange,
  className,
  children,
  ref,
  ...props
}: (React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const {
    isMobile,
    openMobile,
    setOpenMobile,
    open: contextOpen,
  } = useSidebar();

  const isControlled = openProp !== undefined;
  const sidebarOpen = isControlled ? openProp : contextOpen;
  const sidebarState = sidebarOpen ? "expanded" : "collapsed";

  if (collapsible === "none") {
    return (
      <div
        className={cn(
          "text-sidebar-foreground flex h-full w-(--sidebar-width) flex-col",
          side === "right" && variant === "inset"
            ? "border-border bg-background overflow-hidden rounded-xl border"
            : "bg-sidebar",
          className
        )}
        data-side={side}
        data-variant={variant}
        ref={ref}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    if (side === "right" && isControlled) {
      if (!sidebarOpen) {
        return null;
      }

      return (
        <Sheet onOpenChange={onOpenChange} open={sidebarOpen} {...props}>
          <SheetContent
            className="w-(--sidebar-width) bg-background p-0 text-sidebar-foreground [&>button]:hidden"
            data-mobile="true"
            data-sidebar="sidebar"
            side={side}
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
          >
            <div className="flex h-full w-full flex-col">{children}</div>
          </SheetContent>
        </Sheet>
      );
    }

    return (
      <Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
        <SheetContent
          className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
          data-mobile="true"
          data-sidebar="sidebar"
          side={side}
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
        >
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className={cn(
        "group peer text-sidebar-foreground hidden md:block",
        side === "right" && sidebarState === "expanded" && "ml-3"
      )}
      data-collapsible={sidebarState === "collapsed" ? collapsible : ""}
      data-side={side}
      data-state={sidebarState}
      data-variant={variant}
      ref={ref}
    >
      {/* Transparent Spacer */}
      <div
        className={cn(
          "relative bg-transparent transition-[width] duration-200 ease-linear",
          "h-svh md:group-data-[variant=inset]:h-[calc(100svh-16px)]",
          "w-(--sidebar-width) group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[collapsible=offcanvas]:w-0"
        )}
      />
      {/* Fixed Visual Sidebar */}
      <div
        className={cn(
          "fixed inset-y-0 z-10 hidden w-(--sidebar-width) transition-[left,right,width,transform] duration-200 ease-linear md:flex",
          side === "left"
            ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] md:group-data-[variant=inset]:left-2"
            : "right-0 group-data-[collapsible=offcanvas]:translate-x-full md:group-data-[variant=inset]:right-2",
          "h-svh md:group-data-[variant=inset]:top-2 md:group-data-[variant=inset]:bottom-2 md:group-data-[variant=inset]:h-[calc(100svh-16px)]",
          variant === "floating" || variant === "inset"
            ? "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "text-sidebar-foreground flex h-full w-full flex-col overflow-hidden",
            side === "right" && variant === "inset"
              ? "border-border bg-background rounded-xl border shadow-sm"
              : "bg-surface-subtle dark:bg-background",
            side === "left" &&
              (variant === "floating"
                ? "group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border"
                : "md:group-data-[variant=inset]:border-border md:group-data-[variant=inset]:rounded-l-xl md:group-data-[variant=inset]:border")
          )}
          data-sidebar="sidebar"
        >
          {children}
        </div>
      </div>
    </div>
  );
};
Sidebar.displayName = "Sidebar";

const SidebarTrigger = ({
  className,
  onClick,
  ref,
  ...props
}: React.ComponentProps<typeof Button> & {
  ref?: React.RefObject<React.ElementRef<typeof Button> | null>;
}) => {
  const { toggleSidebar } = useSidebar();
  const isMobile = useIsMobile();

  return (
    <Button
      className={cn("h-7 w-7", className)}
      data-sidebar="trigger"
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      ref={ref}
      size="icon"
      variant="ghost"
      {...props}
    >
      {isMobile ? (
        <Icon icon={Menu01Icon} size="sm" />
      ) : (
        <Icon icon={PanelLeftIcon} size="sm" />
      )}
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
};
SidebarTrigger.displayName = "SidebarTrigger";

const SidebarRail = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"button"> & {
  ref?: React.RefObject<HTMLButtonElement | null>;
}) => {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      aria-label="Toggle Sidebar"
      className={cn(
        "hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] sm:flex",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className
      )}
      data-sidebar="rail"
      type="button"
      onClick={toggleSidebar}
      ref={ref}
      tabIndex={-1}
      title="Toggle Sidebar"
      {...props}
    />
  );
};
SidebarRail.displayName = "SidebarRail";

const SidebarInset = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"main"> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <main
    className={cn(
      "bg-background relative flex min-w-0 flex-1 flex-col",
      "min-h-svh",
      "md:peer-data-[variant=inset]:h-[calc(100svh-16px)] md:peer-data-[variant=inset]:min-h-0 md:peer-data-[variant=inset]:overflow-y-auto",
      "md:peer-data-[variant=inset]:border-border md:peer-data-[variant=inset]:rounded-r-xl md:peer-data-[variant=inset]:border md:peer-data-[variant=inset]:border-l-0",
      className
    )}
    ref={ref}
    {...props}
  />
);
SidebarInset.displayName = "SidebarInset";

const SidebarInput = ({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof Input> & {
  ref?: React.RefObject<React.ElementRef<typeof Input> | null>;
}) => (
  <Input
    className={cn(
      "bg-background focus-visible:ring-sidebar-ring/50 h-8 w-full shadow-none focus-visible:ring-1 focus-visible:ring-inset",
      className
    )}
    data-sidebar="input"
    ref={ref}
    {...props}
  />
);
SidebarInput.displayName = "SidebarInput";

const SidebarHeader = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"div"> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <div
    className={cn("flex flex-col gap-2", className)}
    data-sidebar="header"
    ref={ref}
    {...props}
  />
);
SidebarHeader.displayName = "SidebarHeader";

const SidebarFooter = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"div"> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <div
    className={cn("flex flex-col gap-2 p-2", className)}
    data-sidebar="footer"
    ref={ref}
    {...props}
  />
);
SidebarFooter.displayName = "SidebarFooter";

const SidebarSeparator = ({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof Separator> & {
  ref?: React.RefObject<React.ElementRef<typeof Separator> | null>;
}) => (
  <Separator
    className={cn("bg-sidebar-border mx-2 w-auto", className)}
    data-sidebar="separator"
    ref={ref}
    {...props}
  />
);
SidebarSeparator.displayName = "SidebarSeparator";

const SidebarContent = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"div"> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <div
    className={cn(
      "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
      className
    )}
    data-sidebar="content"
    ref={ref}
    {...props}
  />
);
SidebarContent.displayName = "SidebarContent";

const SidebarGroup = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"div"> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <div
    className={cn(
      "relative flex w-full min-w-0 flex-col p-2 group-data-[collapsible=icon]:px-0",
      className
    )}
    data-sidebar="group"
    ref={ref}
    {...props}
  />
);
SidebarGroup.displayName = "SidebarGroup";

const SidebarGroupLabel = ({
  className,
  asChild = false,
  children,
  ref,
  ...props
}: (React.ComponentProps<"div"> & { asChild?: boolean }) & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => {
  const labelClassName = cn(
    "text-sidebar-foreground/70 ring-sidebar-ring flex h-8 shrink-0 items-center rounded-lg px-2 text-xs font-medium outline-hidden transition-[margin,opa] duration-200 ease-linear focus-visible:ring-1 focus-visible:ring-inset [&>svg]:size-4 [&>svg]:shrink-0",
    "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
    className
  );
  const rendered = useRender({
    enabled: asChild,
    render: asChild ? (children as React.ReactElement) : undefined,
    ref,
    props: {
      ...props,
      className: labelClassName,
      "data-sidebar": "group-label",
    },
    defaultTagName: "div",
  });

  if (asChild) return rendered;

  return (
    <div
      className={labelClassName}
      data-sidebar="group-label"
      ref={ref}
      {...props}
    >
      {children}
    </div>
  );
};
SidebarGroupLabel.displayName = "SidebarGroupLabel";

const SidebarGroupAction = ({
  className,
  asChild = false,
  children,
  ref,
  ...props
}: (React.ComponentProps<"button"> & { asChild?: boolean }) & {
  ref?: React.RefObject<HTMLButtonElement | null>;
}) => {
  const actionClassName = cn(
    "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-lg p-0 outline-hidden transition-transform focus-visible:ring-1 focus-visible:ring-inset [&>svg]:size-4 [&>svg]:shrink-0",
    "after:absolute after:-inset-2 md:after:hidden",
    "group-data-[collapsible=icon]:hidden",
    className
  );
  const rendered = useRender({
    enabled: asChild,
    render: asChild ? (children as React.ReactElement) : undefined,
    ref,
    props: {
      ...props,
      className: actionClassName,
      "data-sidebar": "group-action",
    },
    defaultTagName: "button",
  });

  if (asChild) return rendered;

  return (
    <button
      className={actionClassName}
      data-sidebar="group-action"
      ref={ref}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
};
SidebarGroupAction.displayName = "SidebarGroupAction";

const SidebarGroupContent = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"div"> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <div
    className={cn("w-full text-sm", className)}
    data-sidebar="group-content"
    ref={ref}
    {...props}
  />
);
SidebarGroupContent.displayName = "SidebarGroupContent";

const SidebarMenu = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"ul"> & {
  ref?: React.RefObject<HTMLUListElement | null>;
}) => (
  <ul
    className={cn("flex w-full min-w-0 flex-col gap-1", className)}
    data-sidebar="menu"
    ref={ref}
    {...props}
  />
);
SidebarMenu.displayName = "SidebarMenu";

const SidebarMenuItem = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"li"> & {
  ref?: React.RefObject<HTMLLIElement | null>;
}) => (
  <li
    className={cn(
      "group/menu-item relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center",
      className
    )}
    data-sidebar="menu-item"
    ref={ref}
    {...props}
  />
);
SidebarMenuItem.displayName = "SidebarMenuItem";

const sidebarMenuButtonVariants = tv({
  // design-allow: variant-prefixed type utilities (data-[active=true]:font-medium vs base text-sm), not a single-element role combo
  base: "peer/menu-button flex w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg p-2 text-left text-sm ring-sidebar-ring outline-hidden transition-[width,height,padding,border-color] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-[36px]! group-data-[collapsible=icon]:border group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:p-2! group-data-[state=expanded]:justify-start hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-inset active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-popup-open:hover:bg-sidebar-accent data-popup-open:hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-foreground group-data-[collapsible=icon]:data-[active=true]:border-sidebar-border [&>span:last-child]:truncate [&>svg]:size-5 [&>svg]:shrink-0 [[data-mobile=true]_&]:justify-start",
  variants: {
    variant: {
      default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      outline:
        // design-allow: 0-0-0-1px ring/outline border-shadow (not depth elevation) — no elevation token applies
        "bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]",
    },
    size: {
      default: "h-8 text-sm",
      sm: "h-7 text-xs",
      lg: "h-12 text-sm group-data-[collapsible=icon]:p-2!",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

const SidebarMenuButton = ({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  children,
  ref,
  ...props
}: (React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) & {
  ref?: React.RefObject<HTMLButtonElement | null>;
}) => {
  const { isMobile, state } = useSidebar();
  const buttonClassName = cn(
    sidebarMenuButtonVariants({ variant, size }),
    className
  );
  const rendered = useRender({
    enabled: asChild,
    render: asChild ? (children as React.ReactElement) : undefined,
    ref,
    props: {
      ...props,
      className: buttonClassName,
      "data-active": isActive,
      "data-sidebar": "menu-button",
      "data-size": size,
    },
    defaultTagName: "button",
  });

  const button = asChild ? (
    rendered
  ) : (
    <button
      className={buttonClassName}
      data-active={isActive}
      data-sidebar="menu-button"
      data-size={size}
      ref={ref}
      type="button"
      {...props}
    >
      {children}
    </button>
  );

  if (!tooltip) {
    return button;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        align="center"
        hidden={state !== "collapsed" || isMobile}
        side="right"
        {...tooltip}
      />
    </Tooltip>
  );
};
SidebarMenuButton.displayName = "SidebarMenuButton";

const SidebarMenuAction = ({
  className,
  asChild = false,
  showOnHover = false,
  children,
  ref,
  ...props
}: (React.ComponentProps<"button"> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) & { ref?: React.RefObject<HTMLButtonElement | null> }) => {
  const actionClassName = cn(
    "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground peer-hover/menu-button:text-sidebar-accent-foreground absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-lg p-0 outline-hidden transition-transform focus-visible:ring-1 focus-visible:ring-inset [&>svg]:size-4 [&>svg]:shrink-0",
    "after:absolute after:-inset-2 md:after:hidden",
    "peer-data-[size=sm]/menu-button:top-1",
    "peer-data-[size=default]/menu-button:top-1.5",
    "peer-data-[size=lg]/menu-button:top-2.5",
    "group-data-[collapsible=icon]:hidden",
    showOnHover &&
      "peer-data-[active=true]/menu-button:text-sidebar-accent-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-popup-open:opacity-100 md:opacity-0",
    className
  );
  const rendered = useRender({
    enabled: asChild,
    render: asChild ? (children as React.ReactElement) : undefined,
    ref,
    props: {
      ...props,
      className: actionClassName,
      "data-sidebar": "menu-action",
    },
    defaultTagName: "button",
  });

  if (asChild) return rendered;

  return (
    <button
      className={actionClassName}
      data-sidebar="menu-action"
      ref={ref}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
};
SidebarMenuAction.displayName = "SidebarMenuAction";

const SidebarMenuBadge = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"div"> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <div
    className={cn(
      "text-sidebar-foreground pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-lg px-1 text-xs font-medium tabular-nums select-none",
      "peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground",
      "peer-data-[size=sm]/menu-button:top-1",
      "peer-data-[size=default]/menu-button:top-1.5",
      "peer-data-[size=lg]/menu-button:top-2.5",
      "group-data-[collapsible=icon]:hidden",
      className
    )}
    data-sidebar="menu-badge"
    ref={ref}
    {...props}
  />
);
SidebarMenuBadge.displayName = "SidebarMenuBadge";

const SidebarMenuSkeleton = ({
  className,
  showIcon = false,
  ref,
  ...props
}: (React.ComponentProps<"div"> & {
  showIcon?: boolean;
}) & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const width = React.useMemo(
    () => `${Math.floor(Math.random() * 40) + 50}%`,
    []
  );

  return (
    <div
      className={cn("flex h-8 items-center gap-2 rounded-lg px-2", className)}
      data-sidebar="menu-skeleton"
      ref={ref}
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-lg"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  );
};
SidebarMenuSkeleton.displayName = "SidebarMenuSkeleton";

const SidebarMenuSub = ({
  className,
  ref,
  ...props
}: React.ComponentProps<"ul"> & {
  ref?: React.RefObject<HTMLUListElement | null>;
}) => (
  <ul
    className={cn(
      "border-sidebar-border mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l px-2.5 py-0.5",
      "group-data-[collapsible=icon]:hidden",
      className
    )}
    data-sidebar="menu-sub"
    ref={ref}
    {...props}
  />
);
SidebarMenuSub.displayName = "SidebarMenuSub";

const SidebarMenuSubItem = ({
  ref,
  ...props
}: React.ComponentProps<"li"> & {
  ref?: React.RefObject<HTMLLIElement | null>;
}) => <li ref={ref} {...props} />;
SidebarMenuSubItem.displayName = "SidebarMenuSubItem";

const SidebarMenuSubButton = ({
  asChild = false,
  size = "md",
  isActive,
  className,
  children,
  ref,
  ...props
}: (React.ComponentProps<"a"> & {
  asChild?: boolean;
  size?: "sm" | "md";
  isActive?: boolean;
}) & { ref?: React.RefObject<HTMLAnchorElement | null> }) => {
  const buttonClassName = cn(
    "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:text-sidebar-accent-foreground flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-lg px-2 outline-hidden focus-visible:ring-1 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-5 [&>svg]:shrink-0",
    "data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
    size === "sm" && "text-xs",
    size === "md" && "text-sm",
    "group-data-[collapsible=icon]:hidden",
    className
  );
  const rendered = useRender({
    enabled: asChild,
    render: asChild ? (children as React.ReactElement) : undefined,
    ref,
    props: {
      ...props,
      className: buttonClassName,
      "data-active": isActive,
      "data-sidebar": "menu-sub-button",
      "data-size": size,
    },
    defaultTagName: "a",
  });

  if (asChild) return rendered;

  return (
    <a
      className={buttonClassName}
      data-active={isActive}
      data-sidebar="menu-sub-button"
      data-size={size}
      ref={ref}
      {...props}
    >
      {children}
    </a>
  );
};
SidebarMenuSubButton.displayName = "SidebarMenuSubButton";

export {
  SIDEBAR_RIGHT_INSET_DEFAULT_WIDTH_PX,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
