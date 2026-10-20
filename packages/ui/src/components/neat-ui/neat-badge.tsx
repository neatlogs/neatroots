import type * as React from "react";
import { tv, type VariantProps } from "tailwind-variants";

type SuggestionSeverity = "critical" | "high" | "medium" | "low" | "none";
type UICategory = "automated" | "regression" | "user";

/**
 * NeatBadge — the standard small pill badge used across the platform.
 *
 * Specs (size="default"): rounded-full, text-xs, px-2.5, py-0.5, leading-5, no border by default.
 * size="sm": rounded-full, text-3xs, px-1.5, py-0, leading-4 — for low-salience repeated tags (e.g. nav "beta").
 * size="xs": rounded-md, text-2xs, px-1.5, py-0.5, leading-4 — for quiet metadata micro-tags (squared corners).
 * Axes are orthogonal: `variant` controls color, `size` controls geometry (including corner shape).
 * Use this for tags, labels, statuses, and other small contextual badges.
 *
 * The base shadcn `Badge` from `@/components/ui/badge` remains unchanged
 * for use inside component libraries and existing wrappers (e.g. DetectionBadge).
 */
const neatBadgeVariants = tv({
  base: "inline-flex items-center border-none font-medium whitespace-nowrap transition-colors",
  variants: {
    variant: {
      default: "bg-secondary text-secondary-foreground",
      muted: "bg-muted text-muted-foreground",
      outline: "border border-border bg-transparent text-foreground",
      green: "bg-badge-green-bg text-badge-green-text",
      red: "bg-badge-red-bg text-badge-red-text",
      amber: "bg-badge-amber-bg text-badge-amber-text",
      orange: "bg-badge-orange-bg text-badge-orange-text",
      yellow: "bg-badge-yellow-bg text-badge-yellow-text",
      blue: "bg-badge-blue-bg text-badge-blue-text",
      purple: "bg-badge-purple-bg text-badge-purple-text",
      "coming-soon": "bg-badge-coming-soon-bg text-badge-coming-soon-text",
      tag: "bg-badge-tag-bg text-badge-tag-text",
      production: "bg-badge-production-bg text-badge-production-text",
      staging: "bg-badge-staging-bg text-badge-staging-text",
      dev: "bg-badge-dev-bg text-badge-dev-text",
      archived: "bg-badge-archived-bg text-badge-archived-text",
      "prompt-custom":
        "bg-badge-prompt-custom-bg text-badge-prompt-custom-text",
      "env-var":
        "border border-badge-purple-text/20 bg-badge-purple-bg font-mono text-badge-purple-text",
      "role-admin": "bg-badge-amber-bg text-badge-amber-text",
      "role-editor": "bg-badge-blue-bg text-badge-blue-text",
      "role-viewer": "bg-badge-archived-bg text-badge-archived-text",
    },
    size: {
      default: "rounded-full px-2.5 py-0.5 text-xs leading-5",
      sm: "rounded-full px-1.5 py-0 text-3xs leading-4",
      xs: "rounded-md px-1.5 py-0.5 text-2xs leading-4",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type NeatBadgeVariant = NonNullable<
  VariantProps<typeof neatBadgeVariants>["variant"]
>;

/** Task list / kanban status → badge variant. */
export function taskStatusToVariant(status: string): NeatBadgeVariant {
  switch (status) {
    case "Not Started":
      return "muted";
    case "In Progress":
      return "blue";
    case "Under Review":
      return "purple";
    case "Completed":
      return "green";
    default:
      return "muted";
  }
}

/** Maps detection group (positive / negative / neutral) to badge colors. */
export function detectionGroupToVariant(group: string): NeatBadgeVariant {
  const g = group.toLowerCase();
  if (g === "positive") {
    return "green";
  }
  if (g === "negative") {
    return "red";
  }
  if (g === "neutral") {
    return "amber";
  }
  return "muted";
}

/** Derived UI category (Automated / Regression / User) → NeatBadge variant. */
export function suggestionUiCategoryToVariant(c: UICategory): NeatBadgeVariant {
  switch (c) {
    case "automated":
      return "blue";
    case "regression":
      return "amber";
    case "user":
      return "purple";
    default:
      return "muted";
  }
}

/** Suggestion severity → NeatBadge variant. */
export function suggestionSeverityToVariant(
  s: SuggestionSeverity
): NeatBadgeVariant {
  switch (s) {
    case "critical":
      return "red";
    case "high":
      return "orange";
    case "medium":
      return "yellow";
    default:
      return "muted";
  }
}

/** Maps prompt version / environment label text to a NeatBadge variant. */
export function promptLabelToVariant(label: string): NeatBadgeVariant {
  switch (label.toLowerCase()) {
    case "production":
    case "prod":
      return "production";
    case "staging":
    case "latest":
      return "staging";
    case "development":
    case "dev":
      return "dev";
    case "archived":
      return "archived";
    default:
      return "prompt-custom";
  }
}

export interface NeatBadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof neatBadgeVariants> {}

function NeatBadge({ className, variant, size, ...props }: NeatBadgeProps) {
  return (
    <span
      className={neatBadgeVariants({ variant, size, className })}
      {...props}
    />
  );
}

export { NeatBadge, neatBadgeVariants };
