"use client";

import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

// Keep page chrome fixed on the x-axis when a wide table owns page scrolling.
export const CHROME_PIN_CLASSNAME =
  "sticky left-0 w-[var(--list-viewport-w,100%)]";

/**
 * The invariant shell for every full-bleed list surface (prompts, traces-style
 * tables, …), modelled on the traces page: the WHOLE region scrolls, the title
 * row scrolls away, and the filter bar docks at the top. The table (a
 * {@link ListPageTable} child) flows in the same scroll, its header sticking just
 * below the docked filter bar and its pagination pinned to the bottom.
 *
 *   ┌ overflow-y-auto column on bg-background ───────────────────────────┐
 *   │  px-6 ‹icon› Title …………………………………… ‹actions›    │  title row (scrolls away)
 *   │  px-6 ‹tabs?›                                                      │
 *   │ ═ sticky top-0 ═ ‹filters?›  ───────────────────────── border-b ── │  docks on scroll
 *   │ ‹table — full width; header sticks below the filter bar›           │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * The filter bar's height is measured and published as `--list-dock-top` on the
 * scroll container so a {@link ListPageTable} header can dock immediately below
 * the docked filter bar (no magic numbers; adapts to chip wrapping).
 *
 * Slots, all optional except `title` + `children`:
 *  - `icon` / `title` — page identity (pixel font, per the design philosophy).
 *  - `tabs` — a {@link SegmentedTabs} (or any node); below the title row.
 *  - `actions` — right-aligned controls (search, create, column visibility…).
 *  - `filters` — the shared filter-chip bar; becomes the sticky dock.
 */
export interface ListPageLayoutProps {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  filters?: ReactNode;
  icon?: ReactNode;
  tabs?: ReactNode;
  title: ReactNode;
  toolbar?: ReactNode;
}

export function ListPageLayout({
  actions,
  children,
  className,
  filters,
  toolbar,
  icon,
  tabs,
  title,
}: ListPageLayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const [dockTop, setDockTop] = useState(0);

  const activeFilters = filters ?? toolbar;
  // Track presence because JSX prop identity changes every render.
  const hasActiveFilters = activeFilters != null;

  // Publish the docked filter bar's height so the table header can stick just
  // below it. Re-measured on resize (chips wrapping changes the height).
  const measure = useCallback(() => {
    setDockTop((prev) => {
      const next = filterRef.current?.offsetHeight ?? 0;
      return prev === next ? prev : next;
    });
  }, []);

  useLayoutEffect(() => {
    if (!hasActiveFilters) {
      setDockTop(0);
      return;
    }
    measure();
    const el = filterRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasActiveFilters, measure]);

  // Flag the scroll container while the table header is docked at its sticky
  // offset, so the header can show a subtle shadow lifting it off the rows
  // (matches the traces list page). thead is re-queried each scroll because the
  // table re-renders it on data/page changes. Also flag horizontal scroll so a
  // page-scroll table's pinned column can cast its depth shadow.
  useEffect(() => {
    const col = scrollRef.current;
    if (!col) {
      return;
    }
    const update = () => {
      const thead = col.querySelector("thead");
      if (thead) {
        const stuck =
          thead.getBoundingClientRect().top <=
          col.getBoundingClientRect().top + dockTop + 1;
        col.setAttribute("data-header-stuck", String(stuck));
      } else {
        col.removeAttribute("data-header-stuck");
      }
      col.setAttribute("data-col-scrolled", String(col.scrollLeft > 0));
    };
    update();
    col.addEventListener("scroll", update, { passive: true });
    return () => col.removeEventListener("scroll", update);
  }, [dockTop]);

  // Publish the visible viewport width so a child DataTable in `scroll="page"`
  // mode can size its pinned pager to the VISIBLE area (not the full, possibly
  // wider, table content) — without this the pager's right-hand controls slide
  // off-screen when the table overflows horizontally. Mirrors PageTopSection.
  useLayoutEffect(() => {
    const col = scrollRef.current;
    if (!col) {
      return;
    }
    const publishViewportWidth = () => {
      col.style.setProperty("--list-viewport-w", `${col.clientWidth}px`);
    };
    publishViewportWidth();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(publishViewportWidth);
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className={cn(
        "bg-background flex h-full min-h-0 w-full flex-col overflow-y-auto overscroll-y-contain",
        className
      )}
      // The scroll owner for a page-scroll DataTable child: its sticky header
      // docks against this container and it reads --list-viewport-w / the depth
      // flags from here (same contract PageTopSection publishes elsewhere).
      data-scroll-root
      ref={scrollRef}
      style={{
        ["--list-dock-top" as string]: `${dockTop}px`,
        ["--list-toolbar-h" as string]: `${dockTop}px`,
      }}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-4 px-6 pt-3",
          // Uniform 12px vertical rhythm. The title drops its bottom padding
          // ONLY when the filter bar sits directly beneath it (its own py-3 then
          // supplies the gap). With a tab row in between, the title keeps pb-3
          // so title→tabs stays 12px, and the tab row supplies the tabs→filter gap.
          activeFilters && !tabs ? "pb-0" : "pb-3",
          CHROME_PIN_CLASSNAME
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {icon ? (
            <span className="flex size-5 shrink-0 items-center justify-center text-foreground [&_svg]:size-5">
              {icon}
            </span>
          ) : null}
          <span className="truncate font-pixel text-base text-foreground">
            {title}
          </span>
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {tabs ? (
        <div
          className={cn(
            "px-6",
            // Tabs are the row directly before the filter bar; when a filter bar
            // follows, its py-3 supplies the gap, so tabs drop their bottom
            // padding (same rule the title row uses) to avoid a doubled gap.
            activeFilters ? "pb-0" : "pb-3",
            CHROME_PIN_CLASSNAME
          )}
        >
          {tabs}
        </div>
      ) : null}

      {activeFilters ? (
        <div
          className="sticky top-0 left-0 z-30 flex w-[var(--list-viewport-w,100%)] items-center border-b border-border/60 bg-background px-6 py-3"
          ref={filterRef}
        >
          <div className="flex min-w-0 flex-1">{activeFilters}</div>
        </div>
      ) : null}

      {children}
    </div>
  );
}

/**
 * The table for a ListPageLayout. Unlike `Table`, it has no overflow wrapper: the page column
 * is the scroll owner, so the sticky header can dock under the filter bar via `--list-dock-top`.
 */
export function ListPageTable({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("w-full caption-bottom text-sm", className)} {...props} />;
}
