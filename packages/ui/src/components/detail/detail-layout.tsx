"use client";

import { ArrowLeft02Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { Icon, type IconData } from "@/components/ui/icon";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMinLgMedia } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/** Doc-style tab body — scrolls inside the main column. */
export const DETAIL_SCROLL_TAB_CLASS =
  "flex min-h-0 flex-1 flex-col overflow-y-auto";

/** Table-style tab body — fills remaining height; inner table scrolls. */
export const DETAIL_FILL_TAB_CLASS =
  "flex min-h-0 flex-1 flex-col overflow-hidden";

/** Title / tabs / prose column — same inset as the utility bar breadcrumb. */
export const DETAIL_READING_CHROME_CLASS = "w-full max-w-5xl px-5 md:px-8";

const DETAIL_SPLIT_MIN_WIDTH = 720;

/**
 * DetailLayout — the single, app-wide "entity detail page" shell.
 *
 * Shape (per docs/unified-detail-page-layout.md, derived from Linear/Jira/etc):
 *   ┌ thin utility bar: ‹breadcrumb›  ······························· ┐
 *   ├ main column (scroll) ──────────────────┬ right rail (pluggable) ┤
 *   │  <DetailTitle/> then body              │  <DetailRailGroup/>…    │
 *   └────────────────────────────────────────┴────────────────────────┘
 *
 * Clean flexbox: a column shell (bar over body); the body is a row on `lg`+ and
 * stacks below it. `<main>` flexes to fill and scrolls; `<aside>` is a fixed
 * rail. Each scroll parent owns its own gap + padding — children never carry
 * outer margins. The TITLE lives in the main column (<DetailTitle/>), not the
 * bar; the rail is a flat Linear-style property stack.
 */
export function DetailLayout({
  breadcrumb,
  headerActions,
  hideHeader = false,
  responsiveToContainer = false,
  rail,
  railClassName,
  overlay,
  children,
  contentClassName,
  contentMaxWidthClass = "max-w-4xl",
  mainClassName,
}: {
  breadcrumb: ReactNode;
  /** Actions rendered in the utility bar's right side (always visible, no scroll). */
  headerActions?: ReactNode;
  /** Omit the utility bar when this detail body is embedded in another pane. */
  hideHeader?: boolean;
  /** Use this detail pane's width, rather than the viewport, for rail stacking. */
  responsiveToContainer?: boolean;
  rail: ReactNode;
  /** Extra classes for the rail `<aside>` — e.g. a subtle grey surface that
   *  sets the property panel apart from the white main column. */
  railClassName?: string;
  /**
   * A panel that floats OVER the body region — main column and rail both —
   * rather than displacing either. Rendered last inside a positioned wrapper
   * spanning everything below the utility bar, so an `absolute inset-y-0
   * right-0` child covers the rail and stops at the window's edge.
   *
   * WHY THE LAYOUT OWNS THIS. Nothing inside `main` can escape it: its
   * `overflow-y-auto` makes overflow-x compute to `auto`, so a breakout is
   * clipped — the constraint that put the Issue timeline's comment rail inside
   * the reading column in the first place, at a cost of a third of its width.
   * A page-level region is the layout's to provide.
   *
   * Non-modal by contract: this slot draws no backdrop and traps no focus. A
   * panel that must block the page is a Dialog, not this.
   */
  overlay?: ReactNode;
  children: ReactNode;
  /** Extra classes on the padded main content wrapper. */
  contentClassName?: string;
  /**
   * Width cap for the main content column. Defaults to the reading width
   * (max-w-4xl). A page that renders its own margin content — e.g. the Issue
   * timeline's Google-Docs comment rail — widens this so the margin fits INSIDE
   * `main` (which clips: its overflow-y-auto makes overflow-x compute to auto),
   * while still capping its own text column to the reading width.
   */
  contentMaxWidthClass?: string;
  /** Extra classes on `<main>` (e.g. overflow-hidden for page-scroll tables). */
  mainClassName?: string;
}) {
  const isDesktopViewport = useMinLgMedia();
  const rootRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!responsiveToContainer) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [responsiveToContainer]);

  const isDesktop =
    isDesktopViewport &&
    (!responsiveToContainer ||
      (containerWidth !== null && containerWidth >= DETAIL_SPLIT_MIN_WIDTH));

  // min-h-full + flex-col: scrollport-tall floor so flex-1 tab bodies (and
  // fill charts that absolute-inset inside them) get a real height. Content
  // taller than the pane still grows and main scrolls — min, not max.
  const mainContent = (
    <div
      className={cn(
        "mx-auto flex min-h-full w-full flex-col px-6 pt-6 pb-8 md:px-12 lg:px-16",
        contentMaxWidthClass,
        contentClassName
      )}
    >
      {children}
    </div>
  );

  const mainChromeClass = cn("h-full overflow-y-auto", mainClassName);

  const sidebarContent = <div className="flex flex-col gap-6">{rail}</div>;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-layout={isDesktop ? "split" : "stacked"}
      ref={rootRef}
    >
      {hideHeader ? null : (
        <header className="flex min-h-12 shrink-0 flex-col items-stretch gap-2 border-b border-border/60 px-5 py-2 md:h-12 md:flex-row md:items-center md:justify-between md:gap-4 md:px-8 md:py-0">
          <div className="min-w-0">{breadcrumb}</div>
          {headerActions ? (
            <div className="flex shrink-0 items-center gap-2 self-end md:self-auto">
              {headerActions}
            </div>
          ) : null}
        </header>
      )}
      {/* The body region — the positioning context the `overlay` slot floats
          in. `relative` here and nowhere else, so an overlay spans main + rail
          and nothing narrower. */}
      <div className="relative min-h-0 flex-1">
        {isDesktop ? (
          <ResizablePanelGroup className="h-full" direction="horizontal">
            <ResizablePanel defaultSize={70} minSize={50}>
              <main className={mainChromeClass}>{mainContent}</main>
            </ResizablePanel>
            <ResizableHandle className="w-px bg-border/60 hover:bg-border data-[resize-handle-active]:bg-border" />
            <ResizablePanel
              collapsedSize={0}
              collapsible
              defaultSize={30}
              minSize={15}
            >
              <aside
                className={cn(
                  // No `border-border/60` here: it set a colour with no width, so
                  // it drew nothing. The divider on desktop is the
                  // ResizableHandle above. The mobile branch below is the one
                  // that needs a rule of its own, and it has `border-t`.
                  // px-6, matching the page header's gutter. At px-4 the rail's
                  // content sat 8px inboard of every other column on the page,
                  // which is the same misalignment the empty state had. Shared by
                  // 13 detail surfaces, so this moves all of them onto one gutter.
                  "flex h-full min-h-0 flex-col overflow-y-auto px-6 pt-6 pb-10",
                  railClassName
                )}
              >
                {sidebarContent}
              </aside>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="h-full overflow-y-auto">
            <main>{mainContent}</main>
            <aside
              className={cn(
                "border-border/60 border-t px-6 pt-6 pb-10",
                railClassName
              )}
            >
              {sidebarContent}
            </aside>
          </div>
        )}
        {overlay}
      </div>
    </div>
  );
}

export interface Crumb {
  href?: string;
  /**
   * ReactNode, not string, so the LAST crumb can be the page's own editable
   * title. The title belongs here — repeating it as an h1 in the main column
   * is the same name twice on one screen, and the second copy pushes the
   * content the reader came for below the fold.
   *
   * A node crumb still needs `key`, so pass `keyHint` when the label is not a
   * plain string.
   */
  keyHint?: string;
  label: ReactNode;
}

export type DetailBreadcrumbBack = { href: string } | { onClick: () => void };

/**
 * DetailBreadcrumb — chronological Back and deterministic hierarchy links.
 */
export function DetailBreadcrumb({
  back,
  backLabel = "Back",
  items,
  emphasizeLast = false,
  leadingIcon,
}: {
  back?: DetailBreadcrumbBack;
  backLabel?: string;
  items: Crumb[];
  /**
   * A section glyph before the first crumb — anchors the trail when there is
   * no back arrow, and identifies the entity type (the eval/detection/etc.
   * the page is about). Use the same icon the section's nav item uses.
   */
  leadingIcon?: IconData;
  /**
   * Render the final crumb as the page title (semibold, full ink) rather than
   * a dimmed breadcrumb tail. For pages that carry the title in the utility
   * bar instead of a separate H1 block (Notion-style). Off by default so every
   * existing detail page is untouched.
   */
  emphasizeLast?: boolean;
}) {
  const CRUMB_BASE = "whitespace-nowrap font-sans";
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      {back && "href" in back ? (
        <a
          aria-label={backLabel}
          className="-ml-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          href={back.href}
         
        >
          <Icon icon={ArrowLeft02Icon} size="xxs" />
        </a>
      ) : back ? (
        <button
          aria-label={backLabel}
          className="-ml-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          onClick={back.onClick}
          type="button"
        >
          <Icon icon={ArrowLeft02Icon} size="xxs" />
        </button>
      ) : null}
      {leadingIcon ? (
        <Icon
          aria-hidden
          className="shrink-0 text-muted-foreground"
          icon={leadingIcon}
          size="sm"
        />
      ) : null}
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span
            className="flex min-w-0 items-center gap-1.5"
            key={item.keyHint ?? `${String(item.label)}-${i}`}
          >
            {i > 0 ? (
              <Icon
                aria-hidden
                className="shrink-0 text-muted-foreground/50"
                icon={ArrowRight01Icon}
                size="xs"
              />
            ) : null}
            {item.href && !isLast ? (
              <a
                className={cn(
                  CRUMB_BASE,
                  "text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                )}
                href={item.href}
               
              >
                {item.label}
              </a>
            ) : (
              <span
                className={cn(
                  CRUMB_BASE,
                  isLast && emphasizeLast
                    ? "text-foreground min-w-0 truncate font-semibold"
                    : isLast
                      ? "min-w-0 truncate text-foreground/70"
                      : "text-muted-foreground"
                )}
              >
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * DetailTitle — the H1 block at the top of the main column: title (+ optional
 * subtitle / provenance line) on the left, primary actions on the right.
 */
export function DetailTitle({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="min-w-0 font-sans text-xl leading-tight font-normal tracking-tight text-foreground md:text-2xl">
          {title}
        </h1>
        {subtitle ? (
          <div className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/**
 * DetailRailGroup — a flat (Linear-style) group in the right rail: a pixel
 * micro-label eyebrow over a tight stack of rows. No box, airy by default.
 */
export function DetailRailGroup({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1.5">
        <span className="text-label text-muted-foreground">{label}</span>
        {action}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/**
 * Fixed 32px row height — enforces consistent geometry regardless of whether
 * the value slot contains plain text, a badge, or an editable Select trigger.
 * Children should use h-full to fill without overflow.
 */
const PROPERTY_ROW_CLASSNAME =
  "group mx-0 flex h-8 min-w-0 items-center justify-between gap-4 rounded-md px-1.5 transition-colors";

/**
 * PropertyRow — a single label-left / value-right metadata row. Optional
 * tooltip on the label. Inline-edit controls can be passed as `value`.
 *
 * `labelIcon` renders a trailing glyph next to the label that fades in on row
 * hover — the "there's a tooltip here" affordance used by triage's InfoRow.
 */
export function PropertyRow({
  label,
  value,
  tooltip,
  labelIcon,
}: {
  label: string;
  value: ReactNode;
  tooltip?: string;
  labelIcon?: ReactNode;
}) {
  const labelContent = (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      {labelIcon ? (
        <span className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-60">
          {labelIcon}
        </span>
      ) : null}
    </span>
  );
  return (
    <div className={PROPERTY_ROW_CLASSNAME}>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 cursor-default">{labelContent}</span>
          </TooltipTrigger>
          <TooltipContent
            className="max-w-[min(100vw-2rem,20rem)] text-xs leading-snug"
            side="left"
          >
            {tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        labelContent
      )}
      <div className="ml-auto flex min-w-0 items-center justify-end gap-1.5 truncate text-right text-sm text-foreground tabular-nums">
        {value}
      </div>
    </div>
  );
}
