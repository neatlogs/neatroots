"use client";

import { useSyncExternalStore } from "react";

/** Matches Tailwind `md` breakpoint (768px). */
export function useMinMdMedia(): boolean {
  return useSyncExternalStore(
    subscribeMdMinWidth,
    getMdSnapshot,
    getMdServerSnapshot
  );
}

/** Matches Tailwind `lg` breakpoint (1024px). */
export function useMinLgMedia(): boolean {
  return useSyncExternalStore(
    subscribeLgMinWidth,
    getLgSnapshot,
    getLgServerSnapshot
  );
}

const QUERY = "(min-width: 768px)";

function subscribeMdMinWidth(onStoreChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
}

function getMdSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

/** Prefer desktop layout on SSR to avoid flash on typical dashboard builds (aligned with laptop-first suggestions UX). */
function getMdServerSnapshot(): boolean {
  return true;
}

const LG_QUERY = "(min-width: 1024px)";

function subscribeLgMinWidth(onStoreChange: () => void): () => void {
  const mq = window.matchMedia(LG_QUERY);
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
}

function getLgSnapshot(): boolean {
  return window.matchMedia(LG_QUERY).matches;
}

function getLgServerSnapshot(): boolean {
  return true;
}
