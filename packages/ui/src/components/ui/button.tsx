import { Button as ButtonPrimitive } from "@base-ui/react/button";
import type * as React from "react";
import { tv, type VariantProps } from "tailwind-variants";

import { cn } from "@/lib/utils";

const buttonVariants = tv({
  base: "inline-flex cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-md text-body-medium whitespace-nowrap transition-colors focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  variants: {
    variant: {
      /** Dark gradient pill — main CTA. Tokens: --btn-cta-gradient, --btn-cta-ring */
      default:
        // design-allow: fixed light foreground on the dark CTA gradient pill (text-neutral-100 reads on --btn-cta-gradient)
        "border border-transparent bg-[image:var(--btn-cta-gradient)] [background-clip:padding-box,border-box] bg-origin-border text-neutral-100 shadow-[var(--btn-cta-ring),var(--elevation-button)] hover:opacity-90 dark:border-border dark:bg-inverse-surface dark:bg-none dark:text-inverse-surface-foreground dark:shadow-[var(--elevation-button)] dark:hover:opacity-90",
      /** Solid red — destructive/danger actions */
      destructive:
        "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
      /** Bordered, light bg */
      outline:
        "border border-border bg-background text-foreground hover:bg-surface-subtle active:bg-surface-strong",
      /**
       * The polished workhorse: hairline border + a LAYERED shadow (top inner
       * highlight, tight key, soft ambient) so the control reads pressed from
       * real material, not painted. Type steps to text-xs — a supporting
       * action never out-speaks the content beside it.
       */
      secondary:
        "border border-border/70 bg-background text-xs text-foreground shadow-[var(--elevation-button)] hover:bg-surface-subtle active:bg-surface-strong dark:border-border dark:bg-muted dark:shadow-[var(--elevation-button)] dark:hover:bg-muted/80",
      /** No bg, hover reveals fill */
      ghost:
        "text-foreground hover:bg-surface-subtle active:bg-surface-strong dark:hover:bg-muted",
      /** Same as ghost — explicit Figma name alias */
      tertiary:
        "text-foreground hover:bg-surface-subtle active:bg-surface-strong dark:hover:bg-muted",
      /** Subdued text, hover fill */
      muted:
        "text-muted-foreground hover:bg-surface-subtle active:bg-surface-strong dark:hover:bg-muted",
      /** Inline text link */
      link: "text-info-fg underline-offset-4 hover:underline disabled:opacity-50",
    },
    size: {
      default: "h-8 px-2 py-1.5",
      sm: "h-8 px-2 text-xs",
      lg: "h-10 px-4",
      icon: "size-8 p-0",
    },
  },
  compoundVariants: [
    // Secondary reads as a plaque, not a chip: smaller type needs MORE side
    // padding, or the label crowds its own border. Compound so it outranks the
    // size scale's px in the merge order.
    { variant: "secondary", className: "px-3.5" },
  ],
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export interface ButtonProps
  extends
    Omit<React.ComponentPropsWithRef<typeof ButtonPrimitive>, "className">,
    VariantProps<typeof buttonVariants> {
  className?: string;
  removeFocusRing?: boolean;
}

const Button = ({
  className,
  variant,
  size,
  removeFocusRing = false,
  ref,
  ...props
}: ButtonProps) => (
  <ButtonPrimitive
    className={cn(
      buttonVariants({ variant, size, className }),
      removeFocusRing &&
        "focus:ring-0 focus-visible:ring-0 active:bg-transparent"
    )}
    data-slot="button"
    ref={ref}
    {...props}
  />
);
Button.displayName = "Button";

export { Button, buttonVariants };
