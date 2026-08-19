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
 *      `txFailing`/`passTrend`/`scopeTotals` (src/api/scope.ts). `info` on its
 *      own moves nothing.
 *   3. `outdated` stays FALSE. `isIssue` (src/api/signatures.ts) groups a
 *      finding into the "distinct issues to fix" list when it is a `fail` OR an
 *      `info` carrying `outdated` — so an advisory is deliberately EXCLUDED from
 *      the signature fold and from the `distinctIssues` headline. Advisories are
 *      not defects and must not be counted among them; the dashboard gives them
 *      their own surface.
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
 * Advisory prose must OBSERVE, never CONCLUDE. We cannot prove a null means "no
 * sensor fitted" — a broken sensor looks identical, and a 100%-null rate is
 * strong evidence, not proof. Lead with the payload-size argument (actionable
 * self-interest) rather than a judgement about the supplier's hardware.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck, SemanticDeps } from '../semantic.js';
import { cmprMinutesCheck } from './cmpr-minutes.js';
import { compressorSupplyCheck } from './compressor-supply.js';
import { dateFormatCheck } from './date-format.js';
import { duplicateRecordsCheck } from './duplicate-records.js';
import { nullIdentityCheck } from './null-identity.js';
import { nullPaddingCheck } from './null-padding.js';
import { sampleGapCheck } from './sample-gap.js';
import { timeOrderCheck } from './time-order.js';

/** Namespace prefix separating advisory ids from the §7 requirement ids. */
export const ADVISORY_PREFIX = 'adv.';

/**
 * An advisory id, e.g. `adv.null_identity`. Carried in BOTH `finding.requirement`
 * (so the §7 matrix ignores it) and `finding.code` (so it de-duplicates).
 */
export type AdvisoryId = `${typeof ADVISORY_PREFIX}${string}`;

/**
 * Whether a `finding.requirement` (or `finding.code`) is an advisory id rather
 * than a §7 requirement id. Prefix-only, and unambiguous: every §7 id is
 * `MAJOR.MINOR` digits, so no requirement can ever start with `adv.`.
 */
export function isAdvisoryId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(ADVISORY_PREFIX);
}

/** What a check supplies when it raises one advisory. */
export interface AdvisoryInput {
  /** The `adv.*` id of the advisory being raised. */
  id: AdvisoryId;
  /**
   * The observation, in the supplier's terms. OBSERVE, never conclude — see the
   * wording note in the module header.
   */
  detail: string;
  /** JSON Pointer to where it was observed, for the raw-payload drill-down. */
  pointer?: string | null;
}

/**
 * Build one advisory {@link Finding}. This is the ONLY way advisories should be
 * constructed: it is what guarantees the three enforcement properties above —
 * `severity: 'info'`, the `adv.*` id in both `requirement` and `code`, and
 * `outdated` left false (never set here, so an advisory can never be folded into
 * the distinct-issues list).
 */
export function advisory(input: AdvisoryInput): Finding {
  return {
    requirement: input.id,
    severity: 'info',
    detail: input.detail,
    pointer: input.pointer ?? null,
    code: input.id,
  };
}

/**
 * THE REGISTRATION POINT. Every advisory check lands here, and only here — the
 * stage-8 orchestrator runs the whole list via {@link advisoriesCheck}, so
 * adding a check means adding a module under `semantic/` and one entry below.
 *
 * The checks below are the catalogue today — the two the category shipped with
 * (bva slice C) plus `adv.date_format` (agj.1), `adv.time_not_increasing`
 * (agj.4), `adv.compressor_exceeds_supply` (agj.3), `adv.cmpr_minutes` (agj.7),
 * `adv.sample_gap` (agj.6) and `adv.duplicate_records` (agj.8); it grows from
 * here. Each is a HOISTED FUNCTION DECLARATION in its own module, not the
 * `const check: SemanticCheck =` idiom the §7 checks use — the checks import
 * {@link advisory} from here while this array names them, which is an ESM cycle
 * that a `const` binding would resolve into a temporal-dead-zone throw under one
 * of the two possible load orders. See the note above each declaration.
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
];

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
