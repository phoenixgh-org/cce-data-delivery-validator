/**
 * ADVISORIES — the non-verdict finding category (owning issue: pwd, bite bva).
 *
 * Some payloads are fully schema-compliant AND fully requirement-compliant, yet
 * obviously unhelpful to the country receiving them (a report whose ASER and
 * AMID are both `null`; a property sent as `null` in every record because no
 * sensor is fitted). Before this category the validator had nowhere to say so:
 * every finding was keyed to a §7 requirement, so a practice that violates no
 * requirement was invisible.
 *
 * THE GOVERNING CONSTRAINT (pwd). An advisory must NEVER change a requirement's
 * pass/fail status. The product's proposition is an INDEPENDENT read on
 * conformance; the moment house opinion moves a compliance verdict, a supplier
 * can no longer trust the grade. A supplier must be able to sit at 100%
 * conformant and still carry advisories. That is the whole reason for a separate
 * category rather than extra findings on existing requirements.
 *
 * ── how the constraint is enforced ───────────────────────────────────────────
 * Not by a flag anyone can forget, but by three properties of the existing
 * pipeline (each verified 2026-08-05, each pinned by a test):
 *
 *   1. `computeComplianceSummary` (src/api/compliance-matrix.ts) is
 *      `COMPLIANCE_MATRIX.map(...)` over the 27 STATIC §7 rows. A finding whose
 *      `requirement` is not one of those 27 ids is silently ignored — it cannot
 *      create a phantom row and cannot perturb an existing one. Advisory ids
 *      live in their own `adv.*` namespace precisely so they never collide.
 *      Pinned by src/api/compliance-matrix.test.ts; a future rewrite of that
 *      join to iterate the counts map instead would silently break it.
 *   2. Severity is ALWAYS `info` (2kx locked "no fourth severity, no DDL"), and
 *      every verdict-bearing aggregate keys off `fail` — `deriveStatus`,
 *      `txFailing`/`scopeTotals` (src/api/scope.ts). `info` on its
 *      own moves nothing.
 *   3. `outdated` stays FALSE. `isIssue` (src/api/signatures.ts) counts a
 *      finding as a "distinct issue to fix" when it is a `fail` OR an `info`
 *      carrying `outdated` — an advisory is neither, so it is deliberately
 *      EXCLUDED from the `distinctIssues` headline and from every requirement
 *      grouping. It DOES get a signature of its own (agj.15) — `kind:
 *      'advisory'`, keyed `adv|<adv.id>` — so one `?signatureKey=` cross-filter
 *      serves both; `issueSignatures()` is what any grading count reads.
 *      Advisories are not defects and must not be counted among them; the
 *      dashboard gives them their own surface.
 *
 * ── NO DDL ───────────────────────────────────────────────────────────────────
 * `finding.requirement` is `text NOT NULL` with no CHECK and no FK
 * (db/initdb/30-finding.sql), so a separate id namespace needs no migration.
 * `severity` reuses the existing `info` member of its CHECK constraint.
 *
 * ── the id shape ─────────────────────────────────────────────────────────────
 * One `adv.*` id per advisory, carried in BOTH `requirement` and `code`
 * (decided 2026-08-04, pwd NOTES). Named codes, not numbers: the §7 ids take
 * their numbering from the 2025 requirements document, but an advisory
 * catalogue has no external document to number against, so numbers would be
 * arbitrary and would churn as the catalogue grows. This mirrors the existing
 * `tx.missing_charset` convention for transport checks. `code` additionally
 * gives the de-duplication keying in `sigKey` for free (`req|code`), and
 * `pointer` makes the raw-payload drill-down work for free.
 *
 * NAMING IS CLOSED (Benson, 2026-08-04): the category is "Advisories" — in the
 * dashboard, in finding prose, and in code. No synonyms, and never "warning" or
 * "issue", which read as defects.
 *
 * ── wording ──────────────────────────────────────────────────────────────────
 * Advisory prose is TWO PIECES, not one (agj.17), and the two are read on
 * different surfaces. `summary` is the OBSERVATION — one line, roughly 90
 * characters at ordinary values, carrying this transmission's numbers; it is the
 * advisory line in the transmission detail. An advisory that cites a prior
 * delivery is the one exception to that figure and may run longer; see
 * {@link ADVISORY_IDS_CITING_A_PRIOR}. `detail` is the RATIONALE — a few
 * sentences, STATIC PER ADVISORY ID (synm): one text per id, with no branch
 * variant and nothing interpolated from the payload, collected in
 * {@link ADVISORY_RATIONALES} and served on the advisory signature for the
 * compliance column's advisory row. Both are required of every check; see
 * ./advisory-finding.ts for the shape and DESIGN §7.1 for why the prose is split
 * that way.
 *
 * The split is what makes the static rule affordable: a number that describes
 * one delivery goes in that delivery's `summary`, so a rationale shown once, on
 * a row that has no payload in front of it, never has to speak for a payload it
 * cannot see.
 *
 * Both must OBSERVE, never CONCLUDE. We cannot prove a null means "no sensor
 * fitted" — a broken sensor looks identical, and a 100%-null rate is strong
 * evidence, not proof. So the observation states what arrived and the rationale
 * says why a receiving country cares, and neither names a cause.
 *
 * ELAPSED TIME IS STATED IN MINUTES (decided 2026-09-15), however large the
 * value — `165 min`, never `2 h 45 min`. Seconds are for values that quote a
 * schema object whose own declared unit is seconds (`900 s period`, `200 s`
 * excess), not for durations the check measured itself.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck, SemanticDeps } from '../semantic.js';
import {
  ABST_WINDOW_OVERLAP_ID,
  ABST_WINDOW_OVERLAP_RATIONALE,
  abstWindowOverlapCheck,
} from './abst-window-overlap.js';
import type { AdvisoryId } from './advisory-finding.js';
import { BLANK_ADMIN_ID, BLANK_ADMIN_RATIONALE, blankAdminCheck } from './blank-admin.js';
import { CMPR_MINUTES_ID, CMPR_MINUTES_RATIONALE, cmprMinutesCheck } from './cmpr-minutes.js';
import {
  COMPRESSOR_EXCEEDS_SUPPLY_ID,
  COMPRESSOR_EXCEEDS_SUPPLY_RATIONALE,
  compressorSupplyCheck,
} from './compressor-supply.js';
import { DATE_FORMAT_ID, DATE_FORMAT_RATIONALE, dateFormatCheck } from './date-format.js';
import {
  DUPLICATE_RECORDS_ID,
  DUPLICATE_RECORDS_RATIONALE,
  duplicateRecordsCheck,
} from './duplicate-records.js';
import {
  IDENTIFIER_COLLISION_ID,
  IDENTIFIER_COLLISION_RATIONALE,
  identifierCollisionCheck,
} from './identifier-collision.js';
import {
  NULL_ACCUMULATOR_ID,
  NULL_ACCUMULATOR_RATIONALE,
  nullAccumulatorCheck,
} from './null-accumulator.js';
import { NULL_IDENTITY_ID, NULL_IDENTITY_RATIONALE, nullIdentityCheck } from './null-identity.js';
import { NULL_PADDING_ID, NULL_PADDING_RATIONALE, nullPaddingCheck } from './null-padding.js';
import { SAMPLE_GAP_ID, SAMPLE_GAP_RATIONALE, sampleGapCheck } from './sample-gap.js';
import {
  SHORT_IDENTIFIER_ID,
  SHORT_IDENTIFIER_RATIONALE,
  shortIdentifierCheck,
} from './short-identifier.js';
import {
  TIME_NOT_INCREASING_ID,
  TIME_NOT_INCREASING_RATIONALE,
  timeOrderCheck,
} from './time-order.js';
import {
  UNEXPLAINED_NULL_TEMP_ID,
  UNEXPLAINED_NULL_TEMP_RATIONALE,
  unexplainedNullTempCheck,
} from './unexplained-null-temp.js';

/**
 * The advisory constructor and its id helpers live in the LEAF module
 * advisory-finding.ts so that the checks below can import them without importing
 * this registry back — see that module's header for why (igw). They are
 * re-exported here because this file is the front door to the category: every
 * existing importer (src/api/signatures.ts, src/ingest/pipeline.ts, the check
 * tests) keeps reaching for them at `semantic/advisory.js`.
 */
export {
  ADVISORY_PREFIX,
  advisory,
  isAdvisoryId,
  type AdvisoryId,
  type AdvisoryInput,
} from './advisory-finding.js';

/**
 * THE REGISTRATION POINT. Every advisory check lands here, and only here — the
 * stage-8 orchestrator runs the whole list via {@link advisoriesCheck}, so
 * adding a check means adding a module under `semantic/` and one entry below.
 *
 * The checks below are the catalogue today — the two the category shipped with
 * (bva slice C) plus `adv.date_format` (agj.1), `adv.time_not_increasing`
 * (agj.4), `adv.compressor_exceeds_supply` (agj.3), `adv.cmpr_minutes` (agj.7),
 * `adv.sample_gap` (agj.6), `adv.duplicate_records` (agj.8),
 * `adv.blank_admin` (agj.5), `adv.unexplained_null_temp` (agj.2),
 * `adv.short_identifier` (krh), `adv.null_accumulator` (agj.9),
 * `adv.abst_window_overlap` (agj.24) and `adv.identifier_collision` (0rfk); it
 * grows from here. Each is written in the ordinary
 * `export const …Check: SemanticCheck =` idiom the §7 checks use: the imports
 * run ONE WAY (checks ← advisory-finding.ts, this registry ← checks), so there
 * is no cycle and no load-order hazard to work around (igw). A new check needs
 * nothing but a module and an entry below.
 */
export const ADVISORY_CHECKS: readonly SemanticCheck[] = [
  nullIdentityCheck,
  nullPaddingCheck,
  dateFormatCheck,
  timeOrderCheck,
  compressorSupplyCheck,
  cmprMinutesCheck,
  sampleGapCheck,
  duplicateRecordsCheck,
  blankAdminCheck,
  unexplainedNullTempCheck,
  shortIdentifierCheck,
  nullAccumulatorCheck,
  abstWindowOverlapCheck,
  identifierCollisionCheck,
];

/**
 * THE CATALOGUE AS DATA — the same fourteen advisories as {@link ADVISORY_CHECKS},
 * in the same order, named by id rather than by function (axdd).
 *
 * The checks are bare functions and carry no id metadata: an id is a string
 * literal inside each check's `advisory({ id })` call, which is fine for
 * emission and useless to anything that wants to ask "what advisories exist?".
 * The exercise suite's coverage join is the first such reader — it reports which
 * advisories the case table actually fires — and it needs a source of truth that
 * GROWS WITH THE REGISTRY rather than a list beside it that someone has to
 * remember to update.
 *
 * So each check module exports its own id constant and this array collects them.
 * A hand-maintained list here was rejected for being a second source of truth:
 * it could disagree with what the check emits, and nothing would say so. As
 * written the constant is the one the check passes to {@link advisory}, so the
 * two cannot drift. What a list still cannot catch is a NEW check module added
 * to {@link ADVISORY_CHECKS} whose id is never added here — advisory.test.ts
 * pins the two lengths against each other for exactly that.
 */
export const ADVISORY_IDS: readonly AdvisoryId[] = [
  NULL_IDENTITY_ID,
  NULL_PADDING_ID,
  DATE_FORMAT_ID,
  TIME_NOT_INCREASING_ID,
  COMPRESSOR_EXCEEDS_SUPPLY_ID,
  CMPR_MINUTES_ID,
  SAMPLE_GAP_ID,
  DUPLICATE_RECORDS_ID,
  BLANK_ADMIN_ID,
  UNEXPLAINED_NULL_TEMP_ID,
  SHORT_IDENTIFIER_ID,
  NULL_ACCUMULATOR_ID,
  ABST_WINDOW_OVERLAP_ID,
  IDENTIFIER_COLLISION_ID,
];

/**
 * THE ADVISORIES THAT CITE A PRIOR DELIVERY — the stated exception to the
 * roughly-90-character summary guidance on `AdvisoryInput` (yjni, decided by the
 * owner 2026-09-21).
 *
 * Most advisories observe THIS payload and carry one or two of its numbers, which
 * is what the 90-character figure was sized for. A cross-transmission advisory
 * has to name the other delivery as well, and that costs four values on the
 * line: the value the two deliveries share, this report's side of the
 * disagreement, the prior's side, and the prior's `received_at`. Dropping the
 * receipt time leaves a supplier holding several deliveries unable to find the
 * one meant; dropping either side removes the disagreement the finding exists to
 * report. So the length is structural, and these summaries are NOT compressed to
 * fit.
 *
 * It is a list rather than a judgment each check argues in its own header, and it
 * is here so that both readers of the guidance agree: the docblock a new check's
 * author reads, and the exercise runner's copy audit, which does not print its
 * length warning for an id listed here. A new advisory belongs on it only when
 * its observation names a prior delivery — a summary that is merely long does
 * not qualify.
 */
export const ADVISORY_IDS_CITING_A_PRIOR: readonly AdvisoryId[] = [
  ABST_WINDOW_OVERLAP_ID,
  IDENTIFIER_COLLISION_ID,
];

/**
 * THE RATIONALE CATALOGUE — one static text per advisory id, in
 * {@link ADVISORY_IDS} order (synm).
 *
 * A rationale says why the receiving country cares about what the check
 * observed. It used to be emitted per finding, and two checks worded it by
 * report branch. The compliance column now carries a single expandable row per
 * advisory id, which has one rationale to show and no payload in front of it, so
 * a branch- or payload-dependent text would render whichever transmission
 * happened to arrive last. Every rationale is therefore STATIC PER ID: no branch
 * variant, no interpolation. Numbers that belong to one delivery live in that
 * finding's `summary` instead.
 *
 * Collected here for the reason {@link ADVISORY_IDS} is: each check module stays
 * the single owner of its own wording and exports the constant, and this file
 * gathers them, so the text a check emits as `detail` and the text a reader
 * looks up by id cannot drift apart. What a map still cannot catch is a new
 * check whose rationale is never added here — advisory.test.ts pins the key set
 * against `ADVISORY_IDS` exactly, in both directions, for that.
 *
 * Checks keep passing their own constant as `detail`, so nothing about the
 * `Finding` shape or its persistence changed: this is a second way to reach the
 * same string, for a reader holding an id and no finding.
 */
export const ADVISORY_RATIONALES: ReadonlyMap<string, string> = new Map<string, string>([
  [NULL_IDENTITY_ID, NULL_IDENTITY_RATIONALE],
  [NULL_PADDING_ID, NULL_PADDING_RATIONALE],
  [DATE_FORMAT_ID, DATE_FORMAT_RATIONALE],
  [TIME_NOT_INCREASING_ID, TIME_NOT_INCREASING_RATIONALE],
  [COMPRESSOR_EXCEEDS_SUPPLY_ID, COMPRESSOR_EXCEEDS_SUPPLY_RATIONALE],
  [CMPR_MINUTES_ID, CMPR_MINUTES_RATIONALE],
  [SAMPLE_GAP_ID, SAMPLE_GAP_RATIONALE],
  [DUPLICATE_RECORDS_ID, DUPLICATE_RECORDS_RATIONALE],
  [BLANK_ADMIN_ID, BLANK_ADMIN_RATIONALE],
  [UNEXPLAINED_NULL_TEMP_ID, UNEXPLAINED_NULL_TEMP_RATIONALE],
  [SHORT_IDENTIFIER_ID, SHORT_IDENTIFIER_RATIONALE],
  [NULL_ACCUMULATOR_ID, NULL_ACCUMULATOR_RATIONALE],
  [ABST_WINDOW_OVERLAP_ID, ABST_WINDOW_OVERLAP_RATIONALE],
  [IDENTIFIER_COLLISION_ID, IDENTIFIER_COLLISION_RATIONALE],
]);

/**
 * The rationale for one advisory id, or `null` for an id the catalogue does not
 * hold. A miss is not an error: a finding stored before a check was renamed
 * still reaches the API inside the retention window, and a reader that gets
 * `null` should show no rationale rather than invent one.
 */
export function advisoryRationale(id: string | null | undefined): string | null {
  return (typeof id === 'string' ? ADVISORY_RATIONALES.get(id) : undefined) ?? null;
}

/**
 * Run `checks` against the context and collect their advisories. `checks`
 * defaults to the registry and is injectable ONLY so the plumbing can be tested
 * end to end without a real check registered — production callers use
 * {@link advisoriesCheck}.
 */
export async function runAdvisories(
  ctx: PipelineContext,
  deps: SemanticDeps,
  checks: readonly SemanticCheck[] = ADVISORY_CHECKS,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const check of checks) {
    findings.push(...(await check(ctx, deps)));
  }
  return findings;
}

/**
 * The single semantic check the stage-8 orchestrator registers for the whole
 * category (see `BODY_CHECKS` in ../semantic.ts). Like every semantic check it
 * only ever returns findings — it never halts, and the data is still accepted.
 */
export const advisoriesCheck: SemanticCheck = (ctx, deps) => runAdvisories(ctx, deps);
