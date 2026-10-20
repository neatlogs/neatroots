"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import * as React from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type SelectProps<Value extends string> = Omit<
  SelectPrimitive.Root.Props<Value>,
  "onValueChange"
> & {
  onValueChange?: (value: Value) => void;
};

interface InlineSelectItemProps<Value extends string> {
  children?: React.ReactNode;
  label?: string;
  textValue?: string;
  value?: Value;
}

function getInlineSelectItems<Value extends string>(
  children: React.ReactNode
): Array<{ label: React.ReactNode; value: Value }> | undefined {
  const items: Array<{ label: React.ReactNode; value: Value }> = [];

  function visit(node: React.ReactNode) {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;

      const childProps = child.props as { children?: React.ReactNode };
      if (child.type === SelectItem) {
        const itemProps = child.props as InlineSelectItemProps<Value>;
        if (typeof itemProps.value === "string") {
          items.push({
            label:
              itemProps.children ??
              itemProps.label ??
              itemProps.textValue ??
              itemProps.value,
            value: itemProps.value,
          });
        }
        return;
      }

      visit(childProps.children);
    });
  }

  visit(children);
  return items.length > 0 ? items : undefined;
}

function Select<Value extends string = string>({
  children,
  items,
  onValueChange,
  ...props
}: SelectProps<Value>) {
  const resolvedItems = items ?? getInlineSelectItems<Value>(children);

  return (
    <SelectPrimitive.Root<Value>
      data-slot="select"
      items={resolvedItems}
      onValueChange={(value) => {
        if (value !== null) {
          onValueChange?.(value);
        }
      }}
      {...props}
    >
      {children}
    </SelectPrimitive.Root>
  );
}

function SelectGroup({ ...props }: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  variant = "default",
  children,
  ...props
}: Omit<SelectPrimitive.Trigger.Props, "children"> & {
  size?: "sm" | "default";
  /**
   * `default` is a form field: a bordered, shadowed box that says "you may
   * type or choose here". `ghost` is a VIEW control — it changes how the page
   * is read, not what the data is. Those do not want field chrome: a border
   * implies an editable value, and a row of boxes competes with the content
   * it is meant to be a control for. Ghost keeps the chevron (the affordance)
   * and the focus ring (the accessibility), and drops the rest until hover.
   */
  variant?: "default" | "ghost";
  children?: React.ReactNode;
}) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "focus-visible:ring-ring/50 data-placeholder:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-pointer items-center justify-between gap-1.5 whitespace-nowrap transition-[color,background-color,box-shadow] outline-none focus-visible:ring-1 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variant === "default" &&
          "border-input focus-visible:border-ring aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:hover:bg-input/50 w-full rounded-lg border bg-transparent px-3 py-2 text-sm shadow-xs data-[size=default]:h-9 data-[size=sm]:h-8",
        variant === "ghost" &&
          "text-body-medium hover:bg-surface-subtle -mx-1.5 rounded-md px-1.5 py-0.5 data-[size=sm]:text-xs",
        className
      )}
      data-size={size}
      data-slot="select-trigger"
      data-variant={variant}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <Icon className="opacity-50" icon={ArrowDown01Icon} size="sm" />
        }
      />
    </SelectPrimitive.Trigger>
  );
}

type SelectContentPositionerProps = Pick<
  SelectPrimitive.Positioner.Props,
  | "align"
  | "alignItemWithTrigger"
  | "alignOffset"
  | "anchor"
  | "arrowPadding"
  | "collisionAvoidance"
  | "collisionBoundary"
  | "collisionPadding"
  | "disableAnchorTracking"
  | "positionMethod"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type SelectContentProps = Omit<
  SelectPrimitive.Popup.Props,
  "children" | "className"
> &
  SelectContentPositionerProps & {
    children?: React.ReactNode;
    className?: string;
    position?: "item-aligned" | "popper";
  };

function SelectContent({
  align = "center",
  alignItemWithTrigger,
  alignOffset,
  anchor,
  arrowPadding,
  className,
  children,
  collisionAvoidance,
  collisionBoundary,
  collisionPadding,
  disableAnchorTracking,
  position = "popper",
  positionMethod,
  side,
  sideOffset = 4,
  sticky,
  ...popupProps
}: SelectContentProps) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={
          alignItemWithTrigger ?? position === "item-aligned"
        }
        alignOffset={alignOffset}
        anchor={anchor}
        arrowPadding={arrowPadding}
        className="z-[var(--z-popover)]"
        collisionAvoidance={collisionAvoidance}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        disableAnchorTracking={disableAnchorTracking}
        positionMethod={positionMethod}
        side={side}
        sideOffset={sideOffset}
        sticky={sticky}
      >
        <SelectPrimitive.Popup
          className={cn(
            "data-[ending-style]:fade-out-0 data-[open]:fade-in-0 data-[ending-style]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 bg-popover text-popover-foreground data-[ending-style]:animate-out data-[open]:animate-in relative z-[var(--z-popover)] max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border shadow-md",
            position === "popper" &&
              "w-full min-w-(--anchor-width) scroll-my-1",
            className
          )}
          data-slot="select-content"
          {...popupProps}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="z-[var(--z-popover)] p-1">
            {children}
          </SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)}
      data-slot="select-label"
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  label,
  textValue,
  ...props
}: Omit<SelectPrimitive.Item.Props, "label"> & {
  className?: string;
  label?: string;
  textValue?: string;
}) {
  const resolvedLabel =
    textValue ?? label ?? (typeof children === "string" ? children : undefined);

  return (
    <SelectPrimitive.Item
      className={cn(
        "focus:bg-accent focus:text-accent-foreground dark:focus:bg-accent [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      data-slot="select-item"
      label={resolvedLabel}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Icon icon={Tick02Icon} size="sm" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      data-slot="select-separator"
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: SelectPrimitive.ScrollUpArrow.Props) {
  return (
    <SelectPrimitive.ScrollUpArrow
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      data-slot="select-scroll-up-button"
      {...props}
      render={<Icon icon={ArrowUp01Icon} size="sm" />}
    />
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: SelectPrimitive.ScrollDownArrow.Props) {
  return (
    <SelectPrimitive.ScrollDownArrow
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      data-slot="select-scroll-down-button"
      {...props}
      render={<Icon icon={ArrowDown01Icon} size="sm" />}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
