/**
 * Per-profile verdicts and DS01.3 readiness (by1c.8) — the one place that turns
 * a transmission's findings into "did this pass?", once per requirement lineage.
 *
 * WHY: since bd by1c.6 the schema stage grades every transmission twice, so the
 * raw question "does this transmission carry a `severity === 'fail'` finding?"
 * no longer has a single answer. Asked of the contract lineage it decides the
 * summary counts and every per-transmission readout above the list; asked of the
 * shadow lineage it decides how the same payload would fare once DS01.3
 * publishes. Every consumer that used to ask the raw question now asks this
 * module which profile it means, so a shadow failure can never grade a supplier
 * against the obligations in force today.
 *
 * VERDICT IS BY PROFILE, NOT BY HTTP STATUS (epic by1c item 8). A transmission
 * whose primary lineage is DS01.3 can be rejected 422 on Annex 4 and still hold
 * a contract verdict of 'pass' — the 2025 shadow run found nothing. The status
 * records what the primary validator decided; the verdict records what a lineage
 * decided. They are different questions and this module answers only the second.
 *
 * PURE, AND BROWSER-SAFE IN SHAPE. The only runtime import is `./clause-map`,
 * which is itself dependency-free; everything else is a type. That is deliberate:
 * by1c.12 mirrors this rule in `src/web` for the second verdict column, and a
 * mirror is only trustworthy if it can be a copy with its imports swapped.
 * Two consequences of that constraint, both decided here:
 *
 *   - `CONTRACT_PROFILE` lives in `src/schema-registry.ts`, which pulls in Ajv,
 *     `node:fs` and the vendored bytes. Rather than mirror the constant a third
 *     time, the contract profile is a PARAMETER: each caller passes the constant
 *     it already knows (the server's registry constant, the browser's mirror in
 *     `src/web/api.ts`), and the flip when DS01.3 is adopted stays a one-literal
 *     change at the source.
 *   - {@link readiness} returns two COUNTS and nothing else, so it needs no
 *     signature fold and imports none. It used to take `computeSignatures` as a
 *     function parameter to build its `reasons` list; the grading lens replaced
 *     that list with the DS01.3 rows themselves (tfnv.4), and the parameter went
 *     with it rather than being kept for a caller that no longer exists.
 */

import { forwardClause } from './clause-map.js';
import type { Profile } from '../schema-registry.js';

/**
 * A lineage's verdict on one transmission: it passed, it failed, or this lineage
 * has nothing to say about it (`null`).
 *
 * `null` is a SHADOW-ONLY answer and it is not a soft fail. It asserts two things
 * at once (tfnv.3): the shadow run was skipped because there was nothing to
 * shadow-grade — an unparseable body, an unresolvable `meta.schemaVersion`, a
 * transport stage that halted before the schema stage — AND no contract failure
 * is carried forward onto a clause of this lineage. Transport and semantic
 * breaches are graded once and shared through the clause map, so a halt before
 * the schema stage still names a failed clause under the other lineage; `null`
 * is reserved for the case where neither validator saw the body and nothing
 * forward-mapped failed either. Reporting 'pass' there would claim a check that
 * never happened; reporting 'fail' would blame a supplier for the validator's
 * own short-circuit. The contract verdict is never null: a transmission with no
 * contract findings at all failed nothing, which is exactly what the pre-shadow
 * `txFailing` said.
 */
export type Verdict = 'pass' | 'fail' | null;

/**
 * Namespace prefix separating ADVISORY ids from §7 requirement ids. MIRRORED
 * from `ADVISORY_PREFIX` in src/ingest/stages/semantic/advisory.ts rather than
 * imported — that module pulls in the whole semantic-check graph, which this one
 * must stay clear of (see the header). `src/web/api.ts` mirrors it for the same
 * reason. Keep the three in step; the prefix is unambiguous because every §7 id
 * is digits and dots, so no requirement can start with `adv.`.
 */
const ADVISORY_PREFIX = 'adv.';

/**
 * The 2025 requirement ids that are NOT re-tagged forward into the shadow
 * verdict, even though the clause map carries a forward entry for them.
 *
 * Only §3.2 qualifies. Transport and semantic checks are emitted once under 2025
 * numbering and re-tagged for the shadow profile rather than re-run, so a 2025
 * failure on one of them is also a DS01.3 failure. §3.2 is the exception: its
 * DS01.3 counterpart (5.3.2, "validates against Annex 4") is genuinely RE-RUN by
 * the shadow validator, which writes its own `ds013` findings. Re-tagging a 2025
 * schema failure as well would let a body that fails cce-interop 0.8.1 but
 * satisfies Annex 4 read as a DS01.3 failure — the opposite of what the shadow
 * run measured.
 *
 * EXPORTED for the grading lens (tfnv.4): the read-time fold that counts contract
 * findings onto DS01.3 rows has to skip exactly the same ids, and a second copy
 * of the set would be a second place to forget §3.2 is re-run.
 */
export const RE_RUN_UNDER_SHADOW: ReadonlySet<string> = new Set(['3.2']);

/**
 * The minimal finding shape a verdict reads. Structurally compatible with BOTH
 * the server's `FindingRow` (src/db/repository.ts) and the browser's
 * `FindingView` (src/web/api.ts), so either side passes its own objects through
 * unchanged. `severity` is widened to `string` so the narrower views also fit.
 */
export interface VerdictFinding {
  requirement: string;
  severity: string;
  /** Which requirement lineage this finding graded against (by1c.5). */
  profile: Profile;
  /** Stable check code; advisories carry their `adv.*` id here as well. */
  code?: string | null;
}

/** The minimal transmission shape a verdict reads: its findings, nothing else. */
export interface VerdictTransmission {
  findings: readonly VerdictFinding[];
}

/**
 * Whether a finding is an advisory — an observation about a conformant payload,
 * never a defect. Advisories are `info` today and so could not reach a fail
 * verdict anyway; the guard is here so that a future advisory severity change
 * cannot silently start grading suppliers.
 */
function isAdvisory(f: VerdictFinding): boolean {
  return f.requirement.startsWith(ADVISORY_PREFIX) || (f.code ?? '').startsWith(ADVISORY_PREFIX);
}

/** A graded failure under `profile`: severity 'fail', that lineage, not advisory. */
function isGradedFail(f: VerdictFinding, profile: Profile): boolean {
  return f.profile === profile && f.severity === 'fail' && !isAdvisory(f);
}

/**
 * Whether a 2025 failure is carried forward into the shadow verdict: the clause
 * map has a forward entry for it and it is not one of the {@link
 * RE_RUN_UNDER_SHADOW} ids the shadow validator grades for itself.
 */
function isRetaggedForward(requirement: string): boolean {
  return forwardClause(requirement) !== null && !RE_RUN_UNDER_SHADOW.has(requirement);
}

/**
 * One lineage's verdict on one transmission.
 *
 * `contractProfile` names which lineage is the contract in force — pass the
 * `CONTRACT_PROFILE` constant (see the header for why it is not imported here).
 * The rule is stated once and reads the same whichever way that constant points,
 * so adopting DS01.3 is a change of constant, not of logic:
 *
 *   - Contract lineage: 'fail' when the transmission carries any non-advisory
 *     fail finding of that lineage, else 'pass'. This is the pre-shadow
 *     `txFailing` (src/api/scope.ts), unchanged.
 *   - Shadow lineage, in this order: 'fail' when a contract failure is re-tagged
 *     forward by the clause map ({@link isRetaggedForward}) — a transport or
 *     semantic breach is graded once and counts under both lineages; else `null`
 *     when the transmission carries no finding of that lineage at all; else
 *     'fail' when the shadow run itself failed; else 'pass'.
 *
 * The forward check comes FIRST (tfnv.3). Asking "did this lineage run?" first
 * answered `null` for every transport halt, which reads as "not graded here" on
 * a page that grades against DS01.3 — yet a 401 is a §1.3 failure and §1.3 maps
 * onto clause 5.1.4, so the draft plainly has a failed clause to report. `null`
 * now means the body reached NEITHER validator under this package AND nothing
 * forward-mapped failed: genuinely nothing to say, rather than nothing measured.
 */
export function verdict(
  tx: VerdictTransmission,
  profile: Profile,
  contractProfile: Profile,
): Verdict {
  if (profile === contractProfile) {
    return tx.findings.some((f) => isGradedFail(f, contractProfile)) ? 'fail' : 'pass';
  }
  // A contract failure the clause map carries forward is a failure of this
  // lineage too, whether or not its validator ever ran — so it is asked before
  // "did this lineage run?", not after.
  if (tx.findings.some((f) => isGradedFail(f, contractProfile) && isRetaggedForward(f.requirement)))
    return 'fail';
  // No finding of this lineage means the shadow validator never ran (unresolved
  // schemaVersion, unparseable body, a transport halt). A clean shadow run still
  // writes one `pass` finding, so "it ran" is detectable without a second field.
  if (!tx.findings.some((f) => f.profile === profile)) return null;
  if (tx.findings.some((f) => isGradedFail(f, profile))) return 'fail';
  return 'pass';
}

/**
 * How much of a conformant stream is DS01.3-ready: two counts, and nothing else.
 *
 * It carried a third field, `reasons` — the shadow-lineage fail signatures
 * standing between the two counts — until the grading lens landed (tfnv.4).
 * Under the DS01.3 lens the whole page is those reasons, row by row, so a
 * separate list beside it was the same information told twice and the second
 * telling could not be filtered, sorted or opened like the rest.
 */
export interface Readiness {
  /** Transmissions whose contract verdict is 'pass'. */
  passingContract: number;
  /** Of those, the ones whose shadow verdict is also 'pass'. */
  passingBoth: number;
}

/** {@link readiness} inputs that are not the transmissions themselves. */
export interface ReadinessOptions {
  /** The lineage in force — the server's or browser's `CONTRACT_PROFILE`. */
  contractProfile: Profile;
  /** The lineage being previewed (`'ds013'` today). */
  shadowProfile: Profile;
}

/**
 * Readiness over an ALREADY-SCOPED transmission set (window + source). The
 * caller narrows; this counts. The failures-only filter is deliberately NOT
 * applied by the caller either: readiness is a statement about the whole scope,
 * and a set narrowed to failing transmissions would report readiness over the
 * transmissions least able to demonstrate it.
 *
 * Both numbers fold over the contract-PASSING transmissions, because that is the
 * question being asked: of the traffic that conforms today, how much would still
 * conform under DS01.3? A transmission already failing the contract has a defect
 * to fix either way. One whose shadow verdict is `null` counts in the first
 * number and not the second — nothing was measured, so nothing is claimed.
 */
export function readiness(
  transmissions: readonly VerdictTransmission[],
  options: ReadinessOptions,
): Readiness {
  const { contractProfile, shadowProfile } = options;

  const passingContract = transmissions.filter(
    (tx) => verdict(tx, contractProfile, contractProfile) === 'pass',
  );
  const passingBoth = passingContract.filter(
    (tx) => verdict(tx, shadowProfile, contractProfile) === 'pass',
  );

  return {
    passingContract: passingContract.length,
    passingBoth: passingBoth.length,
  };
}
