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

/**
 * A live tally keyed by `Severity` (DESIGN.md §8).
 *
 * THE UNIT IS THE FIELD'S, NOT THE TYPE'S (vsy1). The same three keys now carry
 * two different units, and the field holding them says which:
 * {@link ComplianceLive.counts} tallies DISTINCT TRANSMISSIONS, and
 * {@link ComplianceLive.findings} tallies FINDINGS. That is why this type is no
 * longer called `FindingCounts` — a name that was true while there was only one
 * unit and would now be a lie on the larger of the two readings.
 */
export type SeverityCounts = Record<Severity, number>;

/**
 * Map of requirement id → live counts. The caller (slice B) aggregates the
 * session's findings by requirement+severity. Requirements absent from the map
 * are treated as zero.
 */
export type SeverityCountsByRequirement = Record<string, SeverityCounts>;

/**
 * Map of requirement id → how many SCOPED TRANSMISSIONS produced at least one
 * finding on that row — the "reached the check" half of {@link
 * ComplianceLive.notReached}.
 *
 * It is not derivable from {@link SeverityCountsByRequirement}: one transmission
 * can carry both a pass and a fail on a collapsed DS01.3 clause (one member
 * passed, another failed), so `pass + fail` can exceed the number of
 * transmissions that reached the row. Requirements absent from the map have zero.
 */
export type ReachedByRequirement = Record<string, number>;

/**
 * Map of requirement id → how many SCOPED TRANSMISSIONS carry at least one
 * `outdated`-flagged finding on that row (2kx).
 *
 * `outdated` is NOT a severity and deliberately does not become one: an
 * outdated-but-valid schema version is recorded severity=`info` (see bd memory
 * `schema-registry-0.8.1-current-outdated`), and 2kx locked that model — no
 * fourth severity, no DDL. It is a per-finding MODIFIER carried alongside the
 * severity counts, which is why it travels in its own map rather than as a
 * fourth key of {@link SeverityCounts} (that type mirrors the DB severity enum
 * and the browser's copy of it). Requirements absent from the map have zero.
 *
 * ITS UNIT FOLLOWS `counts` (vsy1). The modifier is rendered on the same line as
 * the severity tally, so leaving it in findings while that tally moved to
 * transmissions would put two units in one line — the defect vsy1 exists to
 * remove. Today the two readings coincide (the schema stage writes at most one
 * outdated finding per transmission), so nothing on the page moves.
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

/**
 * What the join ADDS to a matrix row: the live counts, the outdated modifier and
 * the derived status. Split out from {@link ComplianceRow} so the join can carry
 * a richer row type through — the DS01.3 package's rows (src/api/lens.ts) add
 * three fields of their own, and they reach the wire because the join spreads
 * whatever row it was given rather than rebuilding a fixed shape.
 *
 * WHY THE ROW CARRIES BOTH UNITS (vsy1). A row's headline tally has to be
 * readable against the scorecard beside it, and the scorecard counts
 * TRANSMISSIONS. Counting findings made the two read as a ratio when they were
 * not one: the schema stage emits one fail per Ajv error, so a single structural
 * omission could show as five failures on a row whose neighbour reported one
 * transmission. So `counts` moves to transmissions.
 *
 * The finding tally is kept rather than dropped, under its own name, because it
 * is the only number that says how much evidence sits behind the row — "55
 * transmissions failing" and "230 distinct findings" answer different questions,
 * and the expansion shows both. The alternative considered was moving the finding
 * tally into the signature payload and leaving only transmissions here. It was
 * rejected: a signature is a defect SHAPE, so its counts cannot be summed back to
 * a row total (one transmission contributes to several signatures), and a row
 * with no matching signature would lose its finding count altogether. Two fields
 * on the row keep both numbers derivable from the row that reports them, which is
 * also what a hand-written browser mirror can follow without a second join.
 */
export interface ComplianceLive {
  /**
   * DISTINCT SCOPED TRANSMISSIONS carrying at least one finding of that severity
   * on this row. A transmission with five `fail` findings here counts once, and
   * so does a transmission failing two members of a collapsed DS01.3 clause
   * (f2bl) — which is why no row can now report more than the scope holds.
   *
   * The three keys are independent, not a partition: a transmission that passed
   * one member of a collapsed clause and failed another is counted in `pass` AND
   * in `fail`. Use {@link notReached}, not `total − pass − fail`, for the
   * remainder.
   */
  counts: SeverityCounts;
  /**
   * FINDINGS on this row, by severity — the unit `counts` carried before vsy1,
   * retained so the expansion can say how much evidence is behind the tally.
   * Always ≥ the matching `counts` entry.
   */
  findings: SeverityCounts;
  /**
   * How many of this row's scoped transmissions carry an `outdated`-flagged
   * finding (2kx). Sits beside `counts` rather than inside it because it is a
   * modifier, not a severity — see {@link OutdatedCountsByRequirement}. It is the
   * evidence behind a `pass-outdated` status, and the dashboard renders it as its
   * own amber count.
   */
  outdated: number;
  /**
   * Scoped transmissions that produced NO finding on this row: they never reached
   * the check, because an earlier stage rejected them (a 401, a 413, a body that
   * never parsed) or because the check does not apply to them.
   *
   * This is a THIRD STATE, not a subtraction the reader can do: `pass + fail`
   * never had to equal the scope, and the two are not disjoint. It is computed
   * here, in the join, because this is the first place that knows both halves —
   * the fold sees only findings and cannot know how large the scope was, and the
   * browser knows neither. Zero when the caller supplied no scoped total, which
   * says the join was handed no scope beyond the findings themselves.
   */
  notReached: number;
  status: DisplayStatus;
}

/** A §7 matrix row joined with its live counts and derived display status. */
export interface ComplianceRow extends MatrixRow, ComplianceLive {}

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

const ZERO_COUNTS: SeverityCounts = { pass: 0, fail: 0, info: 0 };

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
 *
 * UNIT-INDEPENDENT BY CONSTRUCTION (vsy1). Every test here is `> 0` or `=== 0`,
 * and a row has a nonzero transmission count for a severity exactly when it has a
 * nonzero finding count for it. Moving `counts` from findings to distinct
 * transmissions therefore cannot move a single status — which is why that change
 * was presentation only, and why the equality is pinned by test rather than
 * argued.
 */
function deriveStatus(
  primary: ComplianceClass,
  counts: SeverityCounts,
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
 * The SECOND unit and the THIRD state, supplied by the caller that knows them
 * (vsy1). Optional as a group: omitting it reproduces the pre-vsy1 row exactly,
 * with the finding tally equal to `counts` and nothing outstanding.
 */
export interface ScopeEvidence {
  /**
   * Findings per row per severity. Defaults to `countsByRequirement`, which is
   * right for a caller that has not distinguished the two units — the counts it
   * passed are then both tallies at once.
   */
  findings?: SeverityCountsByRequirement;
  /** Scoped transmissions that produced any finding on the row. */
  reached?: ReachedByRequirement;
  /**
   * How many transmissions the caller's scope holds. This is the one fact no
   * pure fold over findings can recover, and without it {@link
   * ComplianceLive.notReached} is 0 on every row.
   */
  scopedTotal?: number;
}

/**
 * Join LIVE per-requirement counts onto a requirement matrix and derive each
 * row's display status (DESIGN.md §7). PURE: no DB, no HTTP, no mutation of
 * inputs. Returns every row in matrix order; requirements with no entry in
 * `countsByRequirement` are treated as zero (→ `untested` when gradeable, never a
 * false pass).
 *
 * `countsByRequirement` is in DISTINCT TRANSMISSIONS since vsy1 when the caller
 * folded it that way (src/api/lens.ts does). The join neither knows nor needs to
 * know which unit it was handed — `deriveStatus` only asks `> 0` — so a caller
 * that still passes per-finding counts gets exactly the row it got before.
 *
 * `outdatedByRequirement` (2kx) is the parallel count of transmissions carrying
 * an `outdated`-flagged finding; omitting it reproduces the pre-2kx behaviour.
 *
 * `evidence` carries the finding tally and the scoped total, the two things this
 * module cannot derive; see {@link ScopeEvidence}. THE NOT-REACHED REMAINDER IS
 * COMPUTED HERE, and deliberately not in the fold (which cannot see the scope)
 * nor in the browser (which cannot see it either, and would have to subtract two
 * non-disjoint counts to guess it).
 *
 * `matrix` defaults to the §7 matrix and is the ONE thing the grading lens
 * changes (tfnv.4): under the DS01.3 lens the caller passes that package's rows,
 * keyed by clause id, with counts already folded through the clause map. The
 * derivation is deliberately shared rather than copied — a package's rows differ
 * in which requirements exist, never in what `pass`, `mixed` or `untested` mean.
 * Row fields beyond `requirement`/`summary`/`classes` are carried through onto
 * the result untouched.
 */
export function computeComplianceSummary<T extends MatrixRow = MatrixRow>(
  countsByRequirement: SeverityCountsByRequirement = {},
  outdatedByRequirement: OutdatedCountsByRequirement = {},
  matrix: readonly T[] = COMPLIANCE_MATRIX as readonly T[],
  evidence: ScopeEvidence = {},
): Array<T & ComplianceLive> {
  const {
    findings: findingsByRequirement = countsByRequirement,
    reached: reachedByRequirement = {},
    scopedTotal,
  } = evidence;

  return matrix.map((row) => {
    const live = countsByRequirement[row.requirement];
    const counts: SeverityCounts = live
      ? { pass: live.pass, fail: live.fail, info: live.info }
      : { ...ZERO_COUNTS };
    const liveFindings = findingsByRequirement[row.requirement];
    const findings: SeverityCounts = liveFindings
      ? { pass: liveFindings.pass, fail: liveFindings.fail, info: liveFindings.info }
      : { ...ZERO_COUNTS };
    const outdated = outdatedByRequirement[row.requirement] ?? 0;
    // Clamped at zero so a caller that scoped one set and folded another can
    // never make a row read as owing a negative number of transmissions.
    const notReached =
      scopedTotal === undefined
        ? 0
        : Math.max(0, scopedTotal - (reachedByRequirement[row.requirement] ?? 0));
    // classes is non-empty by construction; classes[0] is the grading class.
    const primary = row.classes[0]!;
    return {
      ...row,
      counts,
      findings,
      outdated,
      notReached,
      status: deriveStatus(primary, counts, outdated),
    };
  });
}
