
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

function useVerticalScrollEdges(element: HTMLElement | null) {
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  useEffect(() => {
    if (!element) {
      setCanScrollUp(false);
      setCanScrollDown(false);
      return;
    }

    const measure = () => {
      const { scrollTop, scrollHeight, clientHeight } = element;
      setCanScrollUp(scrollTop > 1);
      setCanScrollDown(scrollTop + clientHeight < scrollHeight - 1);
    };

    measure();
    element.addEventListener("scroll", measure, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    mutationObserver?.observe(element, { childList: true, subtree: true });

    return () => {
      element.removeEventListener("scroll", measure);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [element]);

  return { canScrollDown, canScrollUp };
}

export function DropdownMenuScrollViewport({
  children,
}: {
  children: ReactNode;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { canScrollUp, canScrollDown } = useVerticalScrollEdges(scrollEl);

  return (
    <div className="relative min-h-0">
      <div
        className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1"
        ref={setScrollEl}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "from-popover pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b to-transparent transition-opacity duration-150",
          canScrollUp ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        aria-hidden
        className={cn(
          "from-popover pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-linear-to-t to-transparent transition-opacity duration-150",
          canScrollDown ? "opacity-100" : "opacity-0"
        )}
      />
    </div>
  );
}
