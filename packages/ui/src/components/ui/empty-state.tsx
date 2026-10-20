"use client";

import {
  AlertCircleIcon,
  Clock01Icon,
  InboxIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode, Ref } from "react";
import { tv } from "tailwind-variants";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Icon, type IconData, type IconSize } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Which non-happy-path surface to render. no-results is the searched/filtered dead-end (distinct copy from first-run empty). */
export type EmptyStateState = "empty" | "error" | "loading" | "no-results";

/** Chrome: card = dashed placeholder tile, bordered = solid card surface, inline = borderless centered block. */
export type EmptyStateVariant = "bordered" | "card" | "inline";

/** Vertical footprint. block = the analytics min-h-[200px] centered region. */
export type EmptyStateSize = "block" | "compact" | "default";

/** Status accent for the icon. Defaults: error to danger, everything else neutral. Pass warning for the timeout case. */
export type EmptyStateTone = "danger" | "info" | "neutral" | "warning";

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  /** Primary CTA region (rendered in EmptyContent), before any retry button. */
  action?: ReactNode;
  /** Extra content rendered below the action, inside EmptyContent. */
  children?: ReactNode;
  className?: string;
  /** Body copy. Falls back to a per-state default (interpolating query for no-results). */
  description?: ReactNode;
  /** Icon override. Defaults per state: empty to Inbox, no-results to Search01, error to AlertCircle. */
  icon?: IconData;
  /** Icon size token for the media slot. */
  iconSize?: IconSize;
  /** Skeleton card count when state=loading and no loadingSlot is given. */
  loadingRows?: number;
  /** Custom loading skeleton (e.g. a chart skeleton) replacing the default row skeleton. */
  loadingSlot?: ReactNode;
  /** Custom media node replacing the default icon media (illustration, avatar, etc.). */
  media?: ReactNode;
  /** Shows a retry button; rendered after action. */
  onRetry?: () => void;
  /** Search term interpolated into the default no-results description when description is omitted. */
  query?: string;
  /** React 19 ref-as-prop for the root element. */
  ref?: Ref<HTMLDivElement>;
  size?: EmptyStateSize;
  state?: EmptyStateState;
  /** Heading copy. Falls back to a per-state default. */
  title?: ReactNode;
  /** Status accent override; defaults derived from state. */
  tone?: EmptyStateTone;
  variant?: EmptyStateVariant;
}

/** Container chrome — merged onto the Empty family root. */
export const emptyStateVariants = tv({
  base: "",
  defaultVariants: { size: "default", variant: "card" },
  variants: {
    size: {
      block: "min-h-[200px] gap-3 py-8",
      compact: "gap-3 p-4",
      default: "p-6 md:p-12",
    },
    variant: {
      bordered: "border border-border bg-card",
      card: "border border-dashed border-border bg-transparent",
      inline: "!flex-none border-none bg-transparent",
    },
  },
});

/** Icon accent per tone (semantic status tokens). neutral inherits the media card foreground. */
export const emptyStateToneVariants = tv({
  base: "",
  defaultVariants: { tone: "neutral" },
  variants: {
    tone: {
      danger: "text-danger-fg",
      info: "text-info-fg",
      neutral: "text-foreground",
      warning: "text-warning-fg",
    },
  },
});

/** Per-state defaults resolved when props are omitted. */
export const EMPTY_STATE_DEFAULTS: Record<
  EmptyStateState,
  { icon: IconData; tone: EmptyStateTone }
> = {
  empty: { icon: InboxIcon, tone: "neutral" },
  error: { icon: AlertCircleIcon, tone: "danger" },
  loading: { icon: InboxIcon, tone: "neutral" },
  "no-results": { icon: Search01Icon, tone: "neutral" },
};

/** Timeout preset — spread into <EmptyState state="error" {...EMPTY_STATE_TIMEOUT} />. */
export const EMPTY_STATE_TIMEOUT = {
  icon: Clock01Icon,
  tone: "warning" as const,
};

const DEFAULT_TITLE: Record<EmptyStateState, string> = {
  empty: "Nothing here yet",
  error: "Something went wrong",
  loading: "",
  "no-results": "No results",
};

/** Resolve the description: explicit prop wins, then per-state (query-aware) fallback. */
function defaultDescription(
  state: EmptyStateState,
  query: string | undefined,
  description: ReactNode
): ReactNode {
  if (description !== undefined) {
    return description;
  }
  if (state === "no-results") {
    return query
      ? `No results for “${query}”.`
      : "Try adjusting your search or filters.";
  }
  if (state === "error") {
    return "Please try again.";
  }
  return null;
}

/**
 * The one non-happy-path surface for lists, tables, and cards: empty / no-results
 * / error / loading. A thin state-router over the Empty family (promotes the
 * settings SettingsEmpty/Loading/Error tree to a generic primitive) — it owns
 * state defaults, tone, and chrome; the Empty family owns the visual layer.
 */
export function EmptyState({
  action,
  children,
  className,
  description,
  icon,
  iconSize = "md",
  loadingRows = 3,
  loadingSlot,
  media,
  onRetry,
  query,
  ref,
  size,
  state = "empty",
  title,
  tone,
  variant,
  ...props
}: EmptyStateProps) {
  if (state === "loading") {
    return (
      <div
        {...props}
        aria-live="polite"
        className={cn("flex flex-col gap-4", className)}
        data-slot="empty-state"
        data-state={state}
        ref={ref}
        role="status"
      >
        {loadingSlot ??
          Array.from({ length: loadingRows }).map((_, index) => (
            <div
              className="rounded-xl border bg-card p-5 shadow"
              key={`empty-state-skeleton-${index.toString()}`}
            >
              <div className="space-y-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-9 w-full" />
              </div>
            </div>
          ))}
      </div>
    );
  }

  const resolved = EMPTY_STATE_DEFAULTS[state];
  const resolvedIcon = icon ?? resolved.icon;
  const resolvedTone = tone ?? resolved.tone;
  const resolvedTitle = title ?? DEFAULT_TITLE[state];
  const resolvedDescription = defaultDescription(state, query, description);
  const hasContent = Boolean(action || onRetry || children);

  return (
    <Empty
      {...props}
      className={cn(emptyStateVariants({ size, variant }), className)}
      data-slot="empty-state"
      data-state={state}
      ref={ref}
      role={state === "error" ? "alert" : undefined}
    >
      <EmptyHeader>
        {media ? (
          <EmptyMedia>{media}</EmptyMedia>
        ) : (
          <EmptyMedia variant="icon">
            <Icon
              className={emptyStateToneVariants({ tone: resolvedTone })}
              icon={resolvedIcon}
              size={iconSize}
            />
          </EmptyMedia>
        )}
        <EmptyTitle>{resolvedTitle}</EmptyTitle>
        {resolvedDescription ? (
          <EmptyDescription>{resolvedDescription}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {hasContent ? (
        <EmptyContent>
          {action}
          {onRetry ? (
            <Button onClick={onRetry} variant="outline">
              Try again
            </Button>
          ) : null}
          {children}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
