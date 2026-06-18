/**
 * Semantic check — §3.4 reading-interval regularity (owning issue: 8ji.2).
 *
 * §3.4 asks suppliers to "preserve logger time resolution": a device's readings
 * should arrive on a regular cadence. This check reads each report's
 * `records[].ABST` (the UTC logger timestamps) and grades how regular the
 * resulting time series is. It is a TEACHING heuristic — irregularity may be
 * perfectly legitimate (a logger that wakes on temperature events, a gap from a
 * power outage), so a fail OBSERVES the spread, it does not condemn the data.
 *
 * ── ABST format ──────────────────────────────────────────────────────────────
 * `ABST` is the compact `YYYYMMDDThhmmss(.fff)Z` form, e.g. `20200115T040554Z`.
 * This is NOT ISO-8601 with separators, so `Date.parse` of it is unreliable
 * (engine-dependent). We parse the fields explicitly via a regex matching the
 * schema pattern and build the epoch with `Date.UTC(...)`.
 *
 * ── regularity heuristic ─────────────────────────────────────────────────────
 * Per report: sort the parseable timestamps ascending, take consecutive
 * intervals, and compute the coefficient of variation CV = stdev / mean of those
 * intervals (population stdev). CV is unitless, so it grades cadence regularity
 * independently of the actual sampling period (15 min vs 1 h). We call a series
 * REGULAR when CV ≤ 0.25 (25%). Rationale: a truly periodic logger has CV ≈ 0;
 * small jitter from rounding / transmission scheduling stays well under 25%,
 * while genuinely uneven gaps push CV above it. The threshold is deliberately
 * generous so we only flag clear irregularity, honouring the §3.4 caveat that we
 * observe rather than definitively judge. (Degenerate cases: a single interval,
 * or a mean of 0 from coincident timestamps, are treated as regular — there is
 * no spread to fault.)
 *
 * ── multi-report aggregation ─────────────────────────────────────────────────
 * The payload may carry many reports (many devices). We evaluate every report
 * whose series has ≥2 parseable timestamps. We emit a single overall finding:
 * PASS only if all evaluated series are regular; FAIL if ANY evaluated series is
 * irregular. The fail detail names how many of the evaluated series were
 * irregular and the worst CV observed. If fewer than 2 timestamps parse across
 * the WHOLE payload (sparse/empty — nothing to judge), we return no finding.
 */

import type { Finding } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';

/** §3.4 regularity tolerance: intervals are "regular" when CV ≤ this. */
const CV_TOLERANCE = 0.25;

/** Matches the schema's ABST pattern: `^2[0-9]{7}T[0-2][0-9]{5}(\.[0-9]+)?Z$`. */
const ABST_RE = /^2(\d{3})(\d{2})(\d{2})T([0-2]\d)(\d{2})(\d{2})(?:\.(\d+))?Z$/;

/**
 * Parse one `YYYYMMDDThhmmss(.fff)Z` ABST string into epoch-ms (UTC), or null if
 * it does not match the format. Fields are read explicitly and assembled with
 * `Date.UTC` — never `Date.parse` of the compact form.
 */
export function parseAbst(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ABST_RE.exec(value);
  if (m === null) return null;
  const year = Number(`2${m[1]}`); // leading '2' + next 3 digits → full 4-digit year
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const millis = m[7] !== undefined ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  // month is 1-based in the string; Date.UTC wants 0-based.
  return Date.UTC(year, month - 1, day, hour, minute, second, millis);
}

interface SeriesResult {
  /** Coefficient of variation of the consecutive intervals. */
  cv: number;
  regular: boolean;
}

/**
 * Grade one report's sorted timestamps. Requires ≥2 timestamps (caller filters).
 * Returns the CV of consecutive intervals and whether the series is regular.
 */
function gradeSeries(timestamps: number[]): SeriesResult {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) intervals.push(sorted[i]! - sorted[i - 1]!);

  // A single interval has no spread to fault → regular by definition.
  if (intervals.length < 2) return { cv: 0, regular: true };

  const mean = intervals.reduce((sum, x) => sum + x, 0) / intervals.length;
  // Coincident timestamps (mean 0) → no cadence to grade → regular.
  if (mean === 0) return { cv: 0, regular: true };

  const variance =
    intervals.reduce((sum, x) => sum + (x - mean) * (x - mean), 0) / intervals.length;
  const cv = Math.sqrt(variance) / mean;
  return { cv, regular: cv <= CV_TOLERANCE };
}

/** Extract the parseable ABST epoch-ms from one report's `records`, defensively. */
function timestampsForReport(report: unknown): number[] {
  const records = (report as { records?: unknown })?.records;
  if (!Array.isArray(records)) return [];
  const out: number[] = [];
  for (const rec of records) {
    const ts = parseAbst((rec as { ABST?: unknown })?.ABST);
    if (ts !== null) out.push(ts);
  }
  return out;
}

export const intervalCheck: SemanticCheck = (ctx): Finding[] => {
  const data = (ctx.parsedBody as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  let parseableTotal = 0;
  const evaluated: SeriesResult[] = [];
  for (const report of data) {
    const timestamps = timestampsForReport(report);
    parseableTotal += timestamps.length;
    // Only series with ≥2 timestamps can have an interval to grade.
    if (timestamps.length >= 2) evaluated.push(gradeSeries(timestamps));
  }

  // Sparse / empty / unparseable: nothing to judge → no finding.
  if (parseableTotal < 2 || evaluated.length === 0) return [];

  const irregular = evaluated.filter((s) => !s.regular);
  const worstCv = evaluated.reduce((max, s) => Math.max(max, s.cv), 0);
  const pct = (cv: number) => `${(cv * 100).toFixed(1)}%`;

  if (irregular.length === 0) {
    return [
      {
        requirement: '3.4',
        severity: 'pass',
        detail: `reading cadence is regular across ${evaluated.length} report series (worst CV ${pct(
          worstCv,
        )} ≤ ${pct(CV_TOLERANCE)} tolerance) (§3.4)`,
      },
    ];
  }

  return [
    {
      requirement: '3.4',
      severity: 'fail',
      code: 'tx.irregular_interval',
      detail:
        `reading cadence looks irregular in ${irregular.length} of ${evaluated.length} ` +
        `report series (worst interval CV ${pct(worstCv)} exceeds the ${pct(
          CV_TOLERANCE,
        )} tolerance). Heuristic only — irregular gaps may be legitimate (event-driven ` +
        `loggers, outages); we observe the spread, we do not definitively judge (§3.4)`,
    },
  ];
};
