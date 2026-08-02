/**
 * The §7 verifiability matrix and per-session compliance summary (DESIGN.md §7).
 *
 * The product's distinguishing honesty is classifying EVERY requirement — not
 * just the ones we can grade. This module owns the static 27-row matrix and a
 * PURE join of live finding counts onto it. There is deliberately NO DB and NO
 * HTTP here: slice B (sessions API) aggregates `finding` rows by
 * requirement+severity and hands us the counts; we derive display status.
 */

import type { Severity } from '../db/repository.js';

/**
 * The §7 honesty classes (DESIGN.md §7 legend):
 * - `verified`    ✅ Passively verified from supplier traffic.
 * - `heuristic`   🟡 Heuristic / partial.
 * - `active-only` 🔌 Active-only (deferred — needs a future test harness).
 * - `attestation` 📝 Self-attestation (not provable from the receiving side).
 * - `enforced`    🔒 Enforced by us (guaranteed by the endpoint, not a test of
 *                    the supplier's choice).
 * - `none`        — Nothing to grade (permissive).
 */
export type ComplianceClass =
  | 'verified'
  | 'heuristic'
  | 'active-only'
  | 'attestation'
  | 'enforced'
  | 'none';

/** A single static matrix row. Some requirements carry two classes (1.1, 4.4). */
export interface MatrixRow {
  /** Requirement id, e.g. '1.4'. */
  requirement: string;
  /** Short human-readable summary for the dashboard. */
  summary: string;
  /**
   * One or more honesty classes. Split-class rows (1.1 ✅/🔒, 4.4 🔌/📝) list
   * BOTH; the first entry is the "primary" class that drives display status
   * (see `deriveStatus`). All others list exactly one.
   */
  classes: readonly ComplianceClass[];
}

/** Live per-requirement finding counts, keyed by `Severity` (DESIGN.md §8). */
export type FindingCounts = Record<Severity, number>;

/**
 * Map of requirement id → live counts. The caller (slice B) aggregates
 * `finding` rows by requirement+severity. Requirements absent from the map are
 * treated as having zero findings.
 */
export type FindingCountsByRequirement = Record<string, FindingCounts>;

/**
 * Map of requirement id → how many of that requirement's findings carry the
 * `outdated` flag (2kx).
 *
 * `outdated` is NOT a severity and deliberately does not become one: an
 * outdated-but-valid schema version is recorded severity=`info` (see bd memory
 * `schema-registry-0.8.1-current-outdated`), and 2kx locked that model — no
 * fourth severity, no DDL. It is a per-finding MODIFIER carried alongside the
 * severity counts, which is why it travels in its own map rather than as a
 * fourth key of {@link FindingCounts} (that type mirrors the DB severity enum
 * and the browser's copy of it). Requirements absent from the map have zero.
 *
 * Only the §3.2 schema stage sets the flag today, but nothing here is §3.2
 * specific — any requirement that ever flags a finding gets the same treatment.
 */
export type OutdatedCountsByRequirement = Record<string, number>;

/**
 * Derived display status for a row (DESIGN.md §7 render rules):
 * - `pass`            gradeable, only pass findings (≥1).
 * - `pass-outdated`   gradeable, no fails, but ≥1 finding flagged `outdated` —
 *                     "we checked and it passed, against an OLDER schema
 *                     version" (2kx). Distinct from `pass` so the dashboard can
 *                     say which schema version the evidence came from.
 * - `fail`            gradeable, ≥1 fail finding and no pass.
 * - `mixed`           gradeable, both pass and fail present.
 * - `untested`        gradeable, ZERO findings so far (not a false pass).
 * - `not-exercised`   🔌 — "not yet exercised — available in a future test mode".
 * - `self-attestation` 📝 — "outside what a receiver can prove".
 * - `enforced`        🔒 — guaranteed by the endpoint.
 * - `not-applicable`  — nothing to grade (1.7).
 */
export type DisplayStatus =
  | 'pass'
  | 'pass-outdated'
  | 'fail'
  | 'mixed'
  | 'untested'
  | 'not-exercised'
  | 'self-attestation'
  | 'enforced'
  | 'not-applicable';

/** A matrix row joined with its live counts and derived display status. */
export interface ComplianceRow extends MatrixRow {
  counts: FindingCounts;
  /**
   * How many of this requirement's findings carry the `outdated` flag (2kx).
   * Sits beside `counts` rather than inside it because it is a modifier, not a
   * severity — see {@link OutdatedCountsByRequirement}. It is the evidence
   * behind a `pass-outdated` status, and the dashboard renders it as its own
   * amber count.
   */
  outdated: number;
  status: DisplayStatus;
}

/**
 * The §7 verifiability matrix — exactly 27 rows, encoded verbatim from the
 * DESIGN.md §7 table. Order matches the document (1.x → 5.x).
 *
 * Split-class rows put the gradeable/observable class FIRST so it drives the
 * derived status, with the enforced/attestation side carried alongside:
 * - 1.1 → ['verified', 'enforced']: POST+UTF-8 parse is ✅ verified; HTTPS is
 *   🔒 enforced at the edge. The verified side grades.
 * - 4.4 → ['active-only', 'attestation']: backoff SHAPE needs an active harness
 *   (🔌); the "describe to employer" half is 📝. The active-only side grades, so
 *   the row shows `not-exercised` until a future test mode exists.
 */
export const COMPLIANCE_MATRIX: readonly MatrixRow[] = [
  { requirement: '1.1', summary: 'HTTPS POST, UTF-8 JSON', classes: ['verified', 'enforced'] },
  {
    requirement: '1.2',
    summary: 'Content-Type: application/json; charset=utf-8',
    classes: ['verified'],
  },
  {
    requirement: '1.3',
    summary: 'Auth via token header, Basic, or Bearer (opt-in)',
    classes: ['verified'],
  },
  { requirement: '1.4', summary: 'Body ≤ 1MB post-encoding', classes: ['verified'] },
  { requirement: '1.5', summary: 'Expect standard 2xx/4xx/5xx', classes: ['attestation'] },
  {
    requirement: '1.6',
    summary: 'Gzip via Content-Encoding, no double base64',
    classes: ['verified'],
  },
  { requirement: '1.7', summary: 'Custom headers permitted', classes: ['none'] },
  {
    requirement: '1.8',
    summary: 'No duplicates except allowed conditions',
    classes: ['heuristic'],
  },
  { requirement: '2.1', summary: 'Serial delivery by default', classes: ['heuristic'] },
  { requirement: '2.2', summary: 'Deliver within minutes of receipt', classes: ['attestation'] },
  {
    requirement: '2.3',
    summary: 'Alarm within 15 min + include data since last tx',
    classes: ['attestation'],
  },
  // 3.1's STRUCTURAL half (metadata block + DS01 object shapes) is graded by
  // §3.2's Ajv run — grading it twice would double-count the same evidence. What
  // this row grades is the half a schema cannot express: the CONDITIONAL duty to
  // declare `meta.customDataSchema` when the payload carries manufacturer-specific
  // data objects — clause 4.5 `z`-prefixed keys PLUS keys that are custom by
  // elimination (neither DS01-shaped nor a mis-cased DS01 code, e.g. `customTemp`,
  // `zTPCM`) — checked by the stage-8 `customDataSchemaCheck` (5bs.1). See
  // DESIGN §7 row 3.1.
  {
    requirement: '3.1',
    summary: 'Declare custom data objects via meta.customDataSchema',
    classes: ['verified'],
  },
  { requirement: '3.2', summary: 'Validates against the schema', classes: ['verified'] },
  { requirement: '3.3', summary: 'Transmit all collected objects', classes: ['attestation'] },
  { requirement: '3.4', summary: 'Preserve logger time resolution', classes: ['heuristic'] },
  { requirement: '4.1', summary: 'Retry on non-2xx', classes: ['active-only'] },
  { requirement: '4.2', summary: '≥6 retries / 24h, non-blocking', classes: ['active-only'] },
  {
    requirement: '4.3',
    summary: 'Abandon on permanent failures',
    classes: ['active-only'],
  },
  {
    requirement: '4.4',
    summary: 'Backoff strategy (+ describe to employer)',
    classes: ['active-only', 'attestation'],
  },
  { requirement: '4.5', summary: '429 Retry-After honored', classes: ['active-only'] },
  { requirement: '4.6', summary: 'Log failed attempts', classes: ['attestation'] },
  { requirement: '4.7', summary: 'Provide email + SLA', classes: ['attestation'] },
  { requirement: '4.8', summary: 'Monitor transmission status', classes: ['attestation'] },
  {
    requirement: '4.9',
    summary: 'Notify staff/employer on elevated failures',
    classes: ['attestation'],
  },
  { requirement: '5.1', summary: 'Retransmit last 6 months on request', classes: ['active-only'] },
  { requirement: '5.2', summary: 'Filter retransmit by time range', classes: ['active-only'] },
  { requirement: '5.3', summary: 'Filter all vs never-sent', classes: ['active-only'] },
];

const ZERO_COUNTS: FindingCounts = { pass: 0, fail: 0, info: 0 };

/**
 * Derive a row's display status from its PRIMARY class (classes[0]), live counts
 * and the count of findings flagged `outdated`, per the §7 render rules. `info`
 * findings never affect grading on their own — they are drill-down detail, not a
 * pass/fail signal.
 *
 * THE `outdated` MODIFIER (2kx). A transmission that validates cleanly against a
 * registered-but-older schema version is recorded as info + `outdated`, with NO
 * pass finding. Counting only pass/fail therefore reported `untested` for a
 * session whose traffic all used an older version — a false claim that we never
 * checked, when we checked and it passed. So, for gradeable rows:
 *
 *   1. a fail still dominates (`fail`/`mixed` unchanged — an outdated pass never
 *      softens a real failure);
 *   2. otherwise ≥1 outdated finding yields `pass-outdated`, whether or not
 *      current-version passes are also present (a supplier still transmitting on
 *      an older version has something to fix, so the amber verdict wins over a
 *      clean `pass`);
 *   3. only then do zero pass findings mean `untested`.
 */
function deriveStatus(
  primary: ComplianceClass,
  counts: FindingCounts,
  outdated: number,
): DisplayStatus {
  switch (primary) {
    case 'active-only':
      // 🔌 — always deferred, regardless of any counts that happen to exist.
      return 'not-exercised';
    case 'attestation':
      return 'self-attestation';
    case 'enforced':
      return 'enforced';
    case 'none':
      return 'not-applicable';
    case 'verified':
    case 'heuristic': {
      // Gradeable rows: pass/fail/mixed/pass-outdated/untested from live counts.
      if (counts.fail > 0) return counts.pass > 0 ? 'mixed' : 'fail';
      if (outdated > 0) return 'pass-outdated';
      if (counts.pass === 0) return 'untested';
      return 'pass';
    }
  }
}

/**
 * Join LIVE per-requirement finding counts onto the static §7 matrix and derive
 * each row's display status (DESIGN.md §7). PURE: no DB, no HTTP, no mutation of
 * inputs. Returns all 27 rows in matrix order; requirements with no entry in
 * `countsByRequirement` are treated as zero findings (→ `untested` when
 * gradeable, never a false pass).
 *
 * `outdatedByRequirement` (2kx) is the parallel count of findings carrying the
 * `outdated` flag; omitting it reproduces the pre-2kx behaviour exactly.
 */
export function computeComplianceSummary(
  countsByRequirement: FindingCountsByRequirement = {},
  outdatedByRequirement: OutdatedCountsByRequirement = {},
): ComplianceRow[] {
  return COMPLIANCE_MATRIX.map((row) => {
    const live = countsByRequirement[row.requirement];
    const counts: FindingCounts = live
      ? { pass: live.pass, fail: live.fail, info: live.info }
      : { ...ZERO_COUNTS };
    const outdated = outdatedByRequirement[row.requirement] ?? 0;
    // classes is non-empty by construction; classes[0] is the grading class.
    const primary = row.classes[0]!;
    return { ...row, counts, outdated, status: deriveStatus(primary, counts, outdated) };
  });
}
