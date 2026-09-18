/**
 * Scope helpers (4h4.4) — the reusable, PURE core that makes every number above
 * the dashboard list mean "within this scope". No DB, no HTTP: callers hand in an
 * already-fetched transmission set and these helpers parse the window/source
 * params, narrow the set, and pre-aggregate the scope-relative rollup and scope
 * totals the browser would otherwise have to compute over every raw finding.
 *
 * These are the shared semantics 4h4.5 (the paginated/filterable list endpoint)
 * reuses — kept in this small sibling module precisely so both endpoints scope
 * identically. This is a behavioral port of design_handoff_scale_at_volume/
 * redesign/engine.js `rollup()`/`txFailing()`, with the prototype's `f.sev`/`f.req`
 * accessors adapted to the landed view: findings carry `severity`/`requirement`,
 * and the window bound reads `received_at` as an epoch (ms), not the prototype's
 * minutes-since-midnight.
 *
 * {@link txFailing} now delegates to the verdict engine (by1c.8) and so reads
 * `CONTRACT_PROFILE` off the registry. That is the only non-pure edge in this
 * module, and it is a constant, not a capability: keeping the flip point in one
 * place matters more here than keeping the import list at one entry.
 */

import type { ComplianceRow } from './compliance-matrix.js';
import { verdict } from './verdicts.js';
import type { VerdictFinding } from './verdicts.js';
import { CONTRACT_PROFILE } from '../schema-registry.js';
import { unitKey } from '../identity/unit-key.js';

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
 * folds `mixed` in with `fail` (a row with any failure is "failing"), and
 * `passing` folds `pass-outdated` in with `pass` (2kx): a row validated only
 * against an older registered schema version still passed, and must not silently
 * vanish from all three buckets — the amber pill on the matrix row itself, not
 * this coarse scorecard, carries the "upgrade your schema version" nuance.
 */
export function rollup(summary: readonly ComplianceRow[]): Rollup {
  const grade = summary.filter((r) => r.classes[0] === 'verified' || r.classes[0] === 'heuristic');
  return {
    total: summary.length,
    gradeable: grade.length,
    passing: grade.filter((r) => r.status === 'pass' || r.status === 'pass-outdated').length,
    failing: grade.filter((r) => r.status === 'fail' || r.status === 'mixed').length,
    untested: grade.filter((r) => r.status === 'untested').length,
  };
}

/**
 * The minimal transmission shape the scope helpers read (findings + time). Named
 * for the scope, not for any one readout: {@link txFailing} takes it, and
 * {@link scopeTotals} takes it intersected with {@link UnitTransmission}.
 */
export interface ScopedTransmission {
  received_at: string | Date;
  findings: readonly VerdictFinding[];
}

/**
 * A transmission "fails" if the CONTRACT lineage says so — the verdict engine's
 * contract rule (src/api/verdicts.ts), which is the engine.js `txFailing` this
 * was ported from plus the profile test.
 *
 * The profile test is what keeps the scorecard and the `withFailures` readout
 * meaning what they meant before the shadow run existed (by1c.8). Since bd by1c.6
 * a perfectly conformant payload can carry `fail` findings describing how it would
 * fare under DS01.3; those grade a different lineage and must not move a single
 * number a supplier is graded on today.
 */
export function txFailing(tx: ScopedTransmission): boolean {
  return verdict(tx, CONTRACT_PROFILE, CONTRACT_PROFILE) === 'fail';
}

/** The minimal transmission shape the CCE-unit count reads: the parsed body. */
export interface UnitTransmission {
  /**
   * The parsed JSON body as stored (`null` when the payload never parsed, which
   * is why this is `unknown` rather than a typed payload — an unparsed or
   * schema-invalid transmission still reaches this helper).
   */
  body?: unknown;
}

/** Distinct CCE units in a scope, and the reports that named none. */
export interface UnitTotals {
  /** Distinct appliance identities seen across the scoped set. */
  units: number;
  /** Reports in scope that carried neither ASER nor AMID. */
  unidentifiedReports: number;
}

/** Whether a value is a plain (non-array) object we can read keys off. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Count the DISTINCT CCE units an already-scoped transmission set reported on,
 * plus the reports that identified none. Pure, and independent of both the
 * grading profile and the verdict: a schema-INVALID transmission still reported
 * on a unit, and this number is "what was received", not "what passed".
 *
 * Reads the parsed `body.data[]` array only. A transmission whose body is not an
 * object with an array `data` contributes nothing — including an unparsed body
 * (`null`), where there is nothing to read. Entries of `data[]` that are not
 * objects are skipped rather than counted as unidentified: they are not reports,
 * which is the same treatment src/ingest/stages/semantic/null-identity.ts gives
 * them.
 *
 * DESIGN §7: this counts units that REPORTED, so it can never show a unit that
 * never sent anything. The dashboard wording, not this function, is what keeps
 * it from being read as fleet coverage.
 */
export function unitTotals(transmissions: readonly UnitTransmission[]): UnitTotals {
  const keys = new Set<string>();
  let unidentifiedReports = 0;
  for (const tx of transmissions) {
    if (!isPlainObject(tx.body)) continue;
    const data = tx.body['data'];
    if (!Array.isArray(data)) continue;
    for (const report of data) {
      if (!isPlainObject(report)) continue;
      const key = unitKey(report);
      if (key === null) unidentifiedReports += 1;
      else keys.add(key);
    }
  }
  return { units: keys.size, unidentifiedReports };
}

/** Scope totals for the readout above the list. */
export interface ScopeTotals {
  /** Total transmissions in the scope. */
  scoped: number;
  /** Transmissions exhibiting ≥1 fail finding. */
  withFailures: number;
  /** Distinct signature count over the scope. */
  distinctIssues: number;
  /** Distinct CCE units reported on in the scope ({@link unitTotals}). */
  units: number;
  /** Reports in scope that carried no appliance identifier ({@link unitTotals}). */
  unidentifiedReports: number;
}

/**
 * Scope totals: total scoped tx, tx-with-≥1-fail count, distinct-issue count, and
 * the distinct-CCE-unit pair. `distinctIssues` is the length of the (already-
 * computed) signature set — passed in so this helper does not re-fold the
 * findings; the unit pair IS folded here, off the bodies the scoped views carry.
 *
 * `failing` defaults to {@link txFailing}, the CONTRACT verdict. The grading lens
 * (tfnv.4) passes the verdict of the package the reader selected instead, so
 * `withFailures` counts what fails on the page being read; the default keeps the
 * contract reading of that number exactly as it was.
 */
export function scopeTotals(
  transmissions: readonly (ScopedTransmission & UnitTransmission)[],
  distinctIssues: number,
  failing: (tx: ScopedTransmission) => boolean = txFailing,
): ScopeTotals {
  return {
    scoped: transmissions.length,
    withFailures: transmissions.filter((tx) => failing(tx)).length,
    distinctIssues,
    ...unitTotals(transmissions),
  };
}
