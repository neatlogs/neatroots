
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Tick02Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type CheckboxProps = Omit<
  CheckboxPrimitive.Root.Props,
  "checked" | "indeterminate"
> & {
  checked?: boolean | "indeterminate";
  indeterminate?: boolean;
};

const Checkbox = ({
  className,
  checked,
  indeterminate,
  ref,
  ...props
}: CheckboxProps) => (
  <CheckboxPrimitive.Root
    checked={checked === "indeterminate" ? false : checked}
    className={cn(
      "peer border-primary focus-visible:ring-ring/50 data-checked:bg-primary data-checked:text-primary-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50 relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border shadow-sm focus-visible:ring-1 focus-visible:outline-hidden focus-visible:ring-inset",
      className
    )}
    indeterminate={indeterminate || checked === "indeterminate"}
    ref={ref}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("flex items-center justify-center text-current")}
    >
      <Icon icon={Tick02Icon} size="xxs" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
