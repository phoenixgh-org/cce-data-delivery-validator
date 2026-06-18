/**
 * Compact pass-rate trend sparkline (4h4.7). Ported from the redesign mock
 * (design_handoff_scale_at_volume/redesign/shared.jsx `Sparkline`).
 *
 * Input: the `passTrend` buckets ({ tot, fail, rate }[]), oldest -> newest.
 * Draws a pass-rate line with a faint --pass area fill; empty buckets
 * (rate === null) carry the previous known rate forward so the line stays
 * continuous. A short --fail tick rises from the baseline on any bucket that
 * contained a failure, taller for more failures (scaled by bucket.fail). The
 * baseline is drawn in --border.
 *
 * No new color tokens: only --pass / --fail / --border are used. The line draws
 * with a stroke-dash animation, gated on `prefers-reduced-motion` (no animated
 * draw when the user prefers reduced motion).
 */
import { useId, type CSSProperties, type ReactElement } from 'react';

/** A single pass-rate trend bucket, as produced by `passTrend`. */
export interface TrendBucket {
  /** Total transmissions in the bucket. */
  tot: number;
  /** Failing transmissions in the bucket. */
  fail: number;
  /** Pass rate 0..1, or null when the bucket is empty (tot === 0). */
  rate: number | null;
}

export interface SparklineProps {
  buckets: TrendBucket[];
  /** SVG width in px. Defaults to 168. */
  width?: number;
  /** SVG height in px. Defaults to 34. */
  height?: number;
  style?: CSSProperties;
}

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Sparkline({
  buckets,
  width = 168,
  height = 34,
  style,
}: SparklineProps): ReactElement {
  if (!buckets || buckets.length === 0) {
    return (
      <div
        style={{
          width,
          height,
          fontSize: 10.5,
          color: 'var(--text-faint)',
          display: 'flex',
          alignItems: 'center',
          ...style,
        }}
      >
        no data
      </div>
    );
  }

  const n = buckets.length;
  const padY = 4;
  const x = (i: number): number => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (r: number): number => padY + (1 - r) * (height - padY * 2);

  // Build a continuous line, carrying the last known rate across empty buckets.
  let last: number | null = null;
  const pts: Array<[number, number]> = [];
  buckets.forEach((b, i) => {
    if (b.rate != null) last = b.rate;
    if (last != null) pts.push([x(i), y(last)]);
  });

  const line = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ');
  const first = pts[0];
  const lastPt = pts[pts.length - 1];
  const area =
    first && lastPt
      ? `${line} L${lastPt[0].toFixed(1)} ${height} L${first[0].toFixed(1)} ${height} Z`
      : '';

  // Approximate path length for the draw animation (sum of segment lengths).
  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) pathLen += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const animate = !prefersReducedMotion && pathLen > 0;

  const uid = useId();
  const animName = `spark-draw-${uid.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <svg
      width={width}
      height={height}
      style={{ display: 'block', overflow: 'visible', ...style }}
      aria-hidden="true"
    >
      {animate && <style>{`@keyframes ${animName}{to{stroke-dashoffset:0}}`}</style>}
      <line x1="0" y1={y(1)} x2={width} y2={y(1)} stroke="var(--border)" strokeWidth="1" />
      {area && <path d={area} fill="var(--pass)" opacity="0.1" />}
      {buckets.map((b, i) =>
        b.fail > 0 ? (
          <rect
            key={i}
            x={x(i) - 1}
            y={height - Math.min(height - 2, 3 + b.fail * 2.2)}
            width="2"
            height={Math.min(height - 2, 3 + b.fail * 2.2)}
            fill="var(--fail)"
            opacity="0.8"
            rx="1"
          />
        ) : null,
      )}
      {line && (
        <path
          d={line}
          fill="none"
          stroke="var(--pass)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
          style={
            animate
              ? {
                  strokeDasharray: pathLen,
                  strokeDashoffset: pathLen,
                  animation: `${animName} 0.6s ease-out forwards`,
                }
              : undefined
          }
        />
      )}
    </svg>
  );
}
