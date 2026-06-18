/**
 * Scope helpers (4h4.4) — the reusable, PURE core that makes every number above
 * the dashboard list mean "within this scope". No DB, no HTTP: callers hand in an
 * already-fetched transmission set and these helpers parse the window/source
 * params, narrow the set, and pre-aggregate the scope-relative rollup, pass-rate
 * trend, and scope totals the browser would otherwise have to compute over every
 * raw finding.
 *
 * These are the shared semantics 4h4.5 (the paginated/filterable list endpoint)
 * reuses — kept in this small sibling module precisely so both endpoints scope
 * identically. This is a behavioral port of design_handoff_scale_at_volume/
 * redesign/engine.js `rollup()`/`passTrend()`/`txFailing()`, with the prototype's
 * `f.sev`/`f.req`/`tx.mins` accessors adapted to the landed view: findings carry
 * `severity`/`requirement`, and time buckets on `received_at` epoch (ms), not
 * minutes-since-midnight.
 */

import type { ComplianceRow } from './compliance-matrix.js';

/** The four selectable time windows (DESIGN.md §10 scope control). */
export type Window = '15m' | '1h' | '6h' | 'all';

/** Allowed window tokens; anything else falls back to the default (no 400). */
const WINDOWS: readonly Window[] = ['15m', '1h', '6h', 'all'];

/** The default window when the param is absent/unknown: no time bound. */
export const DEFAULT_WINDOW: Window = 'all';

/** The default source when the param is absent/unknown: every source. */
export const DEFAULT_SOURCE = 'all';

/** Span of each bounded window in milliseconds ('all' has no bound). */
const WINDOW_MS: Record<Exclude<Window, 'all'>, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
};

/**
 * Parse a raw `window` query value, FALLING BACK to {@link DEFAULT_WINDOW} for
 * absent/unknown/invalid values (the dashboard must stay resilient — never 400).
 */
export function parseWindow(raw: unknown): Window {
  return WINDOWS.includes(raw as Window) ? (raw as Window) : DEFAULT_WINDOW;
}

/**
 * The lower time bound (epoch ms) a window admits, or `null` for the unbounded
 * `'all'` window. Single source of the window→time math: the SUMMARY endpoint
 * filters an in-memory array via {@link inScope}, while the paginated LIST
 * endpoint (4h4.5) pushes this bound into SQL (`received_at >= $lo`) to reuse the
 * `(session_uuid, received_at DESC)` index instead of scanning every row. Keeping
 * the bound here means both endpoints share one definition of "within this
 * window" — change the spans once, in {@link WINDOW_MS}.
 */
export function windowLowerBound(window: Window, now: number): number | null {
  return window === 'all' ? null : now - WINDOW_MS[window];
}

/**
 * Parse a raw `source` query value: a non-empty string is taken as a source key,
 * anything else falls back to {@link DEFAULT_SOURCE} ('all'). The empty string is
 * the canonical UNKNOWN bucket key, so it is preserved as a real selector.
 */
export function parseSource(raw: unknown): string {
  return typeof raw === 'string' ? raw : DEFAULT_SOURCE;
}

/** The minimal transmission shape the scope predicate reads. */
export interface ScopeTransmission {
  /** ISO timestamp string (serialized Date) or a Date. */
  received_at: string | Date;
  /** Raw source key (empty string = the single unknown bucket). */
  source: string;
}

/** Epoch ms of an ISO string or Date. */
function epoch(t: string | Date): number {
  return t instanceof Date ? t.getTime() : new Date(t).getTime();
}

/**
 * The scope predicate: a transmission is in scope when its `received_at` falls in
 * `[now - window, now]` ('all' = no time bound) AND its source matches the
 * selector (`'all'` = every source, else exact raw-key match). `now` is injected
 * so the predicate is deterministic/testable.
 */
export function inScope(
  tx: ScopeTransmission,
  window: Window,
  source: string,
  now: number,
): boolean {
  if (source !== DEFAULT_SOURCE && tx.source !== source) return false;
  if (window === 'all') return true;
  const lo = now - WINDOW_MS[window];
  const at = epoch(tx.received_at);
  return at >= lo && at <= now;
}

/** Narrow a transmission set to the in-scope subset (preserves input order). */
export function scopeTransmissions<T extends ScopeTransmission>(
  transmissions: readonly T[],
  window: Window,
  source: string,
  now: number,
): T[] {
  return transmissions.filter((tx) => inScope(tx, window, source, now));
}

/** The scope-relative gradeable rollup (scorecard numbers). */
export interface Rollup {
  total: number;
  gradeable: number;
  passing: number;
  failing: number;
  untested: number;
}

/**
 * Gradeable rollup — VERBATIM port of engine.js `rollup()` (mirrors the client
 * `computeRollup` in src/web/routes/Dashboard.tsx). Counts passing/failing/
 * untested over GRADEABLE rows only (primary class verified or heuristic);
 * self-attested/active/permissive/enforced rows are never counted. `failing`
 * folds `mixed` in with `fail` (a row with any failure is "failing").
 */
export function rollup(summary: readonly ComplianceRow[]): Rollup {
  const grade = summary.filter((r) => r.classes[0] === 'verified' || r.classes[0] === 'heuristic');
  return {
    total: summary.length,
    gradeable: grade.length,
    passing: grade.filter((r) => r.status === 'pass').length,
    failing: grade.filter((r) => r.status === 'fail' || r.status === 'mixed').length,
    untested: grade.filter((r) => r.status === 'untested').length,
  };
}

/** The minimal transmission shape the trend/totals read (findings + time). */
export interface TrendTransmission {
  received_at: string | Date;
  findings: readonly { severity: string }[];
}

/** A transmission "fails" if any finding has severity 'fail' (engine.js txFailing). */
export function txFailing(tx: TrendTransmission): boolean {
  return tx.findings.some((f) => f.severity === 'fail');
}

/** One pass-rate trend bucket. `rate` is pass/(pass+fail), or null when empty. */
export interface TrendBucket {
  tot: number;
  fail: number;
  rate: number | null;
}

/**
 * Pass-rate trend — VERBATIM port of engine.js `passTrend()`, bucketing on the
 * `received_at` EPOCH (ms) instead of the prototype's minutes-since-midnight.
 * Splits the scope's [min,max] received_at span into `nb` (default 30) buckets;
 * each bucket reports raw `{ tot, fail, rate }` where rate = pass/(pass+fail) or
 * null for an empty bucket. Empty-bucket carry-forward is a RENDER concern (the
 * Sparkline component) — this returns RAW per-bucket values. Empty set → [].
 */
export function passTrend(transmissions: readonly TrendTransmission[], nb = 30): TrendBucket[] {
  if (transmissions.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of transmissions) {
    const at = epoch(t.received_at);
    if (at < lo) lo = at;
    if (at > hi) hi = at;
  }
  const span = Math.max(1, hi - lo);
  const buckets = Array.from({ length: nb }, () => ({ pass: 0, fail: 0 }));
  for (const tx of transmissions) {
    const i = Math.min(nb - 1, Math.floor(((epoch(tx.received_at) - lo) / span) * nb));
    buckets[i]![txFailing(tx) ? 'fail' : 'pass'] += 1;
  }
  return buckets.map((b) => {
    const tot = b.pass + b.fail;
    return { tot, fail: b.fail, rate: tot ? b.pass / tot : null };
  });
}

/** Scope totals for the readout above the list. */
export interface ScopeTotals {
  /** Total transmissions in the scope. */
  scoped: number;
  /** Transmissions exhibiting ≥1 fail finding. */
  withFailures: number;
  /** Distinct signature count over the scope. */
  distinctIssues: number;
}

/**
 * Scope totals: total scoped tx, tx-with-≥1-fail count, and distinct-issue count.
 * `distinctIssues` is the length of the (already-computed) signature set — passed
 * in so this helper does not re-fold the findings.
 */
export function scopeTotals(
  transmissions: readonly TrendTransmission[],
  distinctIssues: number,
): ScopeTotals {
  return {
    scoped: transmissions.length,
    withFailures: transmissions.filter(txFailing).length,
    distinctIssues,
  };
}
