import { useId } from "react";

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// KPIBars — compact vertical bar mini-chart for the KPI card.
//
// Renders the metric's recent samples as evenly-spaced rounded bars, all in
// the accent color (peak emphasis comes from height alone). When the series
// is empty, falls back to muted grey placeholder bars so the card still
// reads visually.
// ---------------------------------------------------------------------------

interface KPIBarsProps {
  /** Per-bar width in px. Total SVG width scales with bar count. */
  barWidthPx?: number;
  className?: string;
  /** Accent color (CSS color string) for the bars. */
  color: string;
  data: number[];
  /** SVG height in px. */
  heightPx?: number;
  /** Max bars to render. Series is truncated to the most recent N. */
  maxBars?: number;
  /** Min bars to render — pads grey placeholders if data is shorter. */
  minBars?: number;
}

const VIEWBOX_W = 100;
const VIEWBOX_H = 100;
const MIN_BAR_H = 16;
const GAP_RATIO = 0.32;

export function KPIBars({
  data,
  color,
  maxBars = 12,
  minBars = 5,
  className,
  barWidthPx = 10,
  heightPx = 40,
}: KPIBarsProps) {
  const gradientId = useId();
  const cleanData = (data ?? []).filter((v) => Number.isFinite(v));
  const isEmpty = cleanData.length === 0;

  // No data: show placeholder grey bars. Otherwise use real series, capped at maxBars.
  const samples = isEmpty
    ? Array.from({ length: minBars }, (_, i) => i + 1)
    : cleanData.slice(Math.max(0, cleanData.length - maxBars));

  const max = Math.max(...samples, 1);
  const bars = samples.length;
  const slot = VIEWBOX_W / bars;
  const barWidth = slot * (1 - GAP_RATIO);
  const gap = slot * GAP_RATIO;
  const fillId = `kpi-bar-fill-${gradientId}`;
  const widthPx = bars * barWidthPx;

  return (
    <svg
      aria-hidden
      className={cn("block shrink-0", className)}
      fill="none"
      height={heightPx}
      preserveAspectRatio="none"
      style={{ width: widthPx, height: heightPx }}
      viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
      width={widthPx}
    >
      <title>Recent trend</title>
      <defs>
        <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={1} />
          <stop offset="100%" stopColor={color} stopOpacity={0.65} />
        </linearGradient>
      </defs>
      {samples.map((value, i) => {
        const h = Math.max((value / max) * VIEWBOX_H, MIN_BAR_H);
        const x = i * slot + gap / 2;
        const y = VIEWBOX_H - h;
        return (
          <rect
            fill={isEmpty ? "currentColor" : `url(#${fillId})`}
            height={h}
            key={`bar-${i}-${value}`}
            opacity={isEmpty ? 0.18 : 1}
            rx={2.5}
            style={{
              transition:
                "height 500ms cubic-bezier(0.16,1,0.3,1), y 500ms cubic-bezier(0.16,1,0.3,1)",
            }}
            width={barWidth}
            x={x}
            y={y}
          />
        );
      })}
    </svg>
  );
}
