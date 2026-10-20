
import { Menu as DropdownMenuPrimitive } from "@base-ui/react/menu";
import {
  ArrowRight01Icon,
  Tick02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import * as React from "react";

import { Icon } from "@/components/ui/icon";
import { DropdownMenuScrollViewport } from "@/components/ui/internal/dropdown-menu-scroll-viewport";
import { cn } from "@/lib/utils";

function normalizeMenuClassName(className?: string) {
  return className
    ?.replaceAll("data-[state=open]", "data-[open]")
    .replaceAll("data-[state=closed]", "data-[ending-style]")
    .replaceAll("data-[state=checked]", "data-[checked]")
    .replaceAll(
      "--radix-dropdown-menu-content-available-height",
      "--available-height"
    )
    .replaceAll(
      "--radix-dropdown-menu-content-available-width",
      "--available-width"
    )
    .replaceAll("--radix-dropdown-menu-trigger-width", "--anchor-width");
}

function normalizeMenuTriggerClassName(className?: string) {
  return className?.replaceAll("data-[state=open]", "data-[popup-open]");
}

type DropdownMenuClickHandler = DropdownMenuPrimitive.Item.Props["onClick"];
type DropdownMenuClickEvent = Parameters<
  NonNullable<DropdownMenuClickHandler>
>[0];

function handleDropdownMenuClick(
  event: DropdownMenuClickEvent,
  onSelect?: DropdownMenuClickHandler,
  onClick?: DropdownMenuClickHandler,
  translateDefaultPrevention = true
) {
  (onSelect ?? onClick)?.(event);
  if (translateDefaultPrevention && event.defaultPrevented) {
    event.preventBaseUIHandler();
  }
}

type DropdownMenuProps<Payload = unknown> = Omit<
  DropdownMenuPrimitive.Root.Props<Payload>,
  "onOpenChange"
> & {
  onOpenChange?: (open: boolean) => void;
};

function DropdownMenu<Payload = unknown>({
  onOpenChange,
  ...props
}: DropdownMenuProps<Payload>) {
  return (
    <DropdownMenuPrimitive.Root
      onOpenChange={(open) => onOpenChange?.(open)}
      {...props}
    />
  );
}

const DropdownMenuTrigger = ({
  className,
  asChild,
  children,
  ...props
}: Omit<DropdownMenuPrimitive.Trigger.Props, "render" | "className"> & {
  asChild?: boolean;
  className?: string;
  children?: React.ReactNode;
}) => {
  const triggerProps = {
    className: cn("cursor-pointer", normalizeMenuTriggerClassName(className)),
    ...props,
  };

  if (asChild) {
    const trigger = React.isValidElement<{ className?: string }>(children)
      ? React.cloneElement(children, {
          className: normalizeMenuTriggerClassName(children.props.className),
        })
      : (children as React.ReactElement);

    return <DropdownMenuPrimitive.Trigger {...triggerProps} render={trigger} />;
  }

  return (
    <DropdownMenuPrimitive.Trigger {...triggerProps}>
      {children}
    </DropdownMenuPrimitive.Trigger>
  );
};

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.SubmenuRoot;

type DropdownMenuRadioGroupProps = Omit<
  DropdownMenuPrimitive.RadioGroup.Props,
  "onValueChange"
> & {
  onValueChange?: (value: string) => void;
};

function DropdownMenuRadioGroup({
  onValueChange,
  ...props
}: DropdownMenuRadioGroupProps) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      onValueChange={(value) => onValueChange?.(value)}
      {...props}
    />
  );
}

const DropdownMenuSubTrigger = ({
  className,
  inset,
  children,
  asChild,
  ...props
}: Omit<DropdownMenuPrimitive.SubmenuTrigger.Props, "render" | "className"> & {
  inset?: boolean;
  asChild?: boolean;
  className?: string;
  children?: React.ReactNode;
}) => (
  <DropdownMenuPrimitive.SubmenuTrigger
    className={cn(
      "focus:bg-accent data-popup-open:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      inset && "pl-8",
      normalizeMenuTriggerClassName(className)
    )}
    render={asChild ? (children as React.ReactElement) : undefined}
    {...props}
  >
    {asChild ? null : children}
    {asChild ? null : (
      <Icon className="ml-auto" icon={ArrowRight01Icon} size="sm" />
    )}
  </DropdownMenuPrimitive.SubmenuTrigger>
);

type DropdownMenuPositionProps = Pick<
  DropdownMenuPrimitive.Positioner.Props,
  "align" | "alignOffset" | "side" | "sideOffset" | "collisionPadding"
>;

type DropdownMenuContentProps = Omit<
  DropdownMenuPrimitive.Popup.Props,
  "className" | "children"
> &
  DropdownMenuPositionProps & {
    className?: string;
    children?: React.ReactNode;
    onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
    onEscapeKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  };

const DropdownMenuContent = ({
  className,
  align,
  alignOffset,
  side,
  sideOffset = 4,
  collisionPadding = 8,
  children,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onKeyDown,
  ...popupProps
}: DropdownMenuContentProps) => {
  const finalFocus = onCloseAutoFocus
    ? () => {
        let prevented = false;
        onCloseAutoFocus({
          preventDefault: () => {
            prevented = true;
          },
        });
        return !prevented;
      }
    : undefined;

  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    onKeyDown?.(event);
    if (event.key === "Escape") {
      onEscapeKeyDown?.(event);
    }
  };

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="z-[var(--z-popover)]"
        collisionPadding={collisionPadding}
        side={side}
        sideOffset={sideOffset}
      >
        <DropdownMenuPrimitive.Popup
          className={cn(
            "bg-popover text-popover-foreground z-[var(--z-popover)] max-h-[min(20rem,var(--available-height))] min-w-32 overflow-hidden rounded-lg border p-0 shadow-md",
            "data-[ending-style]:fade-out-0 data-[open]:fade-in-0 data-[ending-style]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[ending-style]:animate-out data-[open]:animate-in",
            normalizeMenuClassName(className)
          )}
          finalFocus={finalFocus}
          onKeyDown={handleKeyDown}
          {...popupProps}
        >
          <DropdownMenuScrollViewport>{children}</DropdownMenuScrollViewport>
        </DropdownMenuPrimitive.Popup>
      </DropdownMenuPrimitive.Positioner>
    </DropdownMenuPrimitive.Portal>
  );
};

const DropdownMenuSubContent = ({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: DropdownMenuContentProps) => (
  <DropdownMenuContent
    align={align}
    alignOffset={alignOffset}
    className={className}
    side={side}
    sideOffset={sideOffset}
    {...props}
  />
);

const DropdownMenuItem = ({
  className,
  inset,
  asChild,
  children,
  onSelect,
  onClick,
  ...props
}: Omit<
  DropdownMenuPrimitive.Item.Props,
  "render" | "onClick" | "className"
> & {
  inset?: boolean;
  asChild?: boolean;
  className?: string;
  onSelect?: DropdownMenuPrimitive.Item.Props["onClick"];
  onClick?: DropdownMenuPrimitive.Item.Props["onClick"];
  children?: React.ReactNode;
}) => (
  <DropdownMenuPrimitive.Item
    className={cn(
      "focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden transition-colors select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
      inset && "pl-8",
      normalizeMenuClassName(className)
    )}
    onClick={(event) => handleDropdownMenuClick(event, onSelect, onClick)}
    render={asChild ? (children as React.ReactElement) : undefined}
    {...props}
  >
    {asChild ? null : children}
  </DropdownMenuPrimitive.Item>
);

const DropdownMenuCheckboxItem = ({
  className,
  children,
  checked,
  onSelect,
  onClick,
  onCheckedChange,
  ...props
}: Omit<
  DropdownMenuPrimitive.CheckboxItem.Props,
  "render" | "onClick" | "onCheckedChange" | "className"
> & {
  className?: string;
  onCheckedChange?: (checked: boolean) => void;
  onSelect?: DropdownMenuPrimitive.CheckboxItem.Props["onClick"];
  onClick?: DropdownMenuPrimitive.CheckboxItem.Props["onClick"];
  children?: React.ReactNode;
}) => (
  <DropdownMenuPrimitive.CheckboxItem
    checked={checked}
    className={cn(
      "focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center rounded-lg py-1.5 pr-2 pl-8 text-sm outline-hidden transition-colors select-none data-disabled:pointer-events-none data-disabled:opacity-50",
      normalizeMenuClassName(className)
    )}
    onCheckedChange={(nextChecked) => onCheckedChange?.(nextChecked)}
    onClick={(event) =>
      handleDropdownMenuClick(event, onSelect, onClick, false)
    }
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.CheckboxItemIndicator>
        <Icon icon={Tick02Icon} size="sm" />
      </DropdownMenuPrimitive.CheckboxItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
);
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName;

/** Checkbox with indicator on the right (label flush left). */
const DropdownMenuCheckboxItemEnd = ({
  className,
  children,
  checked,
  onSelect,
  onClick,
  onCheckedChange,
  ...props
}: Omit<
  DropdownMenuPrimitive.CheckboxItem.Props,
  "render" | "onClick" | "onCheckedChange" | "className"
> & {
  className?: string;
  onCheckedChange?: (checked: boolean) => void;
  onSelect?: DropdownMenuPrimitive.CheckboxItem.Props["onClick"];
  onClick?: DropdownMenuPrimitive.CheckboxItem.Props["onClick"];
  children?: React.ReactNode;
}) => (
  <DropdownMenuPrimitive.CheckboxItem
    checked={checked}
    className={cn(
      "focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden transition-colors select-none data-disabled:pointer-events-none data-disabled:opacity-50",
      normalizeMenuClassName(className)
    )}
    onCheckedChange={(nextChecked) => onCheckedChange?.(nextChecked)}
    onClick={(event) =>
      handleDropdownMenuClick(event, onSelect, onClick, false)
    }
    {...props}
  >
    {children}
    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.CheckboxItemIndicator>
        <Icon icon={Tick02Icon} size="sm" />
      </DropdownMenuPrimitive.CheckboxItemIndicator>
    </span>
  </DropdownMenuPrimitive.CheckboxItem>
);
DropdownMenuCheckboxItemEnd.displayName = "DropdownMenuCheckboxItemEnd";

const DropdownMenuEyeItem = ({
  className,
  children,
  checked,
  onSelect,
  onClick,
  onCheckedChange,
  ...props
}: Omit<
  DropdownMenuPrimitive.CheckboxItem.Props,
  "render" | "onClick" | "onCheckedChange" | "className"
> & {
  className?: string;
  onCheckedChange?: (checked: boolean) => void;
  onSelect?: DropdownMenuPrimitive.CheckboxItem.Props["onClick"];
  onClick?: DropdownMenuPrimitive.CheckboxItem.Props["onClick"];
  children?: React.ReactNode;
}) => (
  <DropdownMenuPrimitive.CheckboxItem
    checked={checked}
    className={cn(
      "focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden transition-colors select-none data-disabled:pointer-events-none data-disabled:opacity-50",
      normalizeMenuClassName(className)
    )}
    onCheckedChange={(nextChecked) => onCheckedChange?.(nextChecked)}
    onClick={(event) => handleDropdownMenuClick(event, onSelect, onClick)}
    {...props}
  >
    {children}
    <span className="absolute right-2 flex items-center justify-center">
      <Icon
        className={cn(
          "size-5 transition-colors",
          checked
            ? "text-foreground"
            : "text-muted-foreground/35 dark:text-muted-foreground/30"
        )}
        icon={ViewIcon}
        size="sm"
      />
    </span>
  </DropdownMenuPrimitive.CheckboxItem>
);
DropdownMenuEyeItem.displayName = "DropdownMenuEyeItem";

const DropdownMenuRadioItem = ({
  className,
  children,
  onSelect,
  onClick,
  ...props
}: Omit<
  DropdownMenuPrimitive.RadioItem.Props,
  "render" | "onClick" | "className"
> & {
  className?: string;
  onSelect?: DropdownMenuPrimitive.RadioItem.Props["onClick"];
  onClick?: DropdownMenuPrimitive.RadioItem.Props["onClick"];
  children?: React.ReactNode;
}) => (
  <DropdownMenuPrimitive.RadioItem
    className={cn(
      "focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden transition-colors select-none data-disabled:pointer-events-none data-disabled:opacity-50",
      normalizeMenuClassName(className)
    )}
    onClick={(event) => handleDropdownMenuClick(event, onSelect, onClick)}
    {...props}
  >
    {children}
    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.RadioItemIndicator>
        <Icon icon={Tick02Icon} size="sm" />
      </DropdownMenuPrimitive.RadioItemIndicator>
    </span>
  </DropdownMenuPrimitive.RadioItem>
);

const DropdownMenuLabel = ({
  className,
  inset,
  ...props
}: Omit<DropdownMenuPrimitive.GroupLabel.Props, "className"> & {
  className?: string;
  inset?: boolean;
}) => (
  <DropdownMenuPrimitive.GroupLabel
    className={cn("text-body-strong px-2 py-1.5", inset && "pl-8", className)}
    {...props}
  />
);

const DropdownMenuSeparator = ({
  className,
  ...props
}: Omit<DropdownMenuPrimitive.Separator.Props, "className"> & {
  className?: string;
}) => (
  <DropdownMenuPrimitive.Separator
    className={cn(
      "bg-muted -mx-1 my-1 h-px",
      normalizeMenuClassName(className)
    )}
    {...props}
  />
);

const DropdownMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn("ml-auto text-xs tracking-widest opacity-60", className)}
    {...props}
  />
);
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuCheckboxItemEnd,
  DropdownMenuContent,
  DropdownMenuEyeItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
