/**
 * The grading lens (tfnv.4) — a READ-TIME projection of one session's findings
 * onto the requirement package the reader selected.
 *
 * WHY: a transmission is graded once, when it arrives, against the lineage its
 * `meta.schemaVersion` resolves to (bd memory `shadow-grading-profile-model`).
 * The dashboard, though, has two packages to show: UNICEF Q1 2025, the
 * obligations in force, and the DS01.3 DRAFT a supplier is preparing for. The
 * lens switches the whole page between them. Nothing here changes what ingest
 * grades, what is stored, or what response code a supplier received — a finding
 * keeps its 2025 requirement id in the database and is TRANSLATED on the way out.
 *
 * WHAT THE FOLD DOES. Under the contract lens the fold is the identity it always
 * was: contract findings counted under their own requirement id, everything else
 * dropped. Under the draft lens each DS01.3 row collects two kinds of finding:
 *
 *   - CONTRACT findings whose 2025 id the clause map carries forward onto that
 *     clause. Transport and semantic checks are graded once and shared between
 *     the lineages, so a §1.4 failure is a 5.1.5 failure. The exception is
 *     {@link RE_RUN_UNDER_SHADOW}: §3.2 is genuinely re-run by the Annex 4
 *     validator, which writes its own findings, so re-tagging the 2025 schema
 *     result as well would report a defect the draft never measured.
 *   - DRAFT findings already numbered in DS01.3 (5.3.2, 5.3.3), which land on
 *     the clause they name.
 *
 * ONE SPLIT: §3.1 → 5.3.3 AND 5.3.5. DS01.3 separates the transmission-metadata
 * duties (5.3.3) from the duty to describe manufacturer-specific objects with a
 * schema (5.3.5), which the 2025 package carries as a single §3.1. The
 * custom-object check names both its outcomes with {@link CUSTOM_SCHEMA_CODES},
 * and a §3.1 finding carrying either of those codes folds onto 5.3.5 while the
 * rest of §3.1 follows the clause map onto 5.3.3. That is what makes 5.3.5 a
 * VERIFIED row rather than an informational one (bd memory
 * `lens-decisions-classes-and-verdict-2026-09-17`), even though it has no 2025
 * member to inherit from.
 */

import { forwardClause } from './clause-map.js';
import { COMPLIANCE_MATRIX } from './compliance-matrix.js';
import type {
  FindingCounts,
  FindingCountsByRequirement,
  MatrixRow,
  OutdatedCountsByRequirement,
} from './compliance-matrix.js';
import { DS013_MATRIX } from './matrix-ds013.js';
import { RE_RUN_UNDER_SHADOW } from './verdicts.js';
import type { Severity } from '../db/repository.js';
import { CUSTOM_SCHEMA_CODES } from '../ingest/stages/semantic/custom-schema.js';
import { CONTRACT_PROFILE, PROFILES } from '../schema-registry.js';
import type { Profile } from '../schema-registry.js';

/**
 * The lens values the session reads accept: every registered lineage id, contract
 * first. A lens is a requirement PACKAGE, and the packages are exactly the
 * lineages the registry knows — so this is the registry's own list, not a second
 * one that could fall behind it.
 */
export const ACCEPTED_LENSES: readonly Profile[] = PROFILES;

/**
 * Parse a raw `lens` query value.
 *
 * Unlike `parseWindow`/`parseSource` (src/api/scope.ts), which fall back to a
 * default rather than ever returning 400, an unknown lens is an ERROR: the two
 * packages grade differently, so silently serving the contract package to a
 * reader who asked for a package we do not know would answer a question they did
 * not ask. `null` is that case, and the route turns it into an HTTP 400 naming
 * the accepted values.
 *
 * An ABSENT lens — the parameter missing, or present with an empty value, which
 * is what a form control serializes when it has not been set — is the contract
 * package. The default is the contract for the same reason the matrix is: it is
 * what a supplier is graded against today.
 */
export function parseLens(
  raw: unknown,
  accepted: readonly Profile[] = ACCEPTED_LENSES,
): Profile | null {
  if (raw === undefined || raw === null || raw === '') return CONTRACT_PROFILE;
  if (typeof raw !== 'string') return null;
  return accepted.find((p) => p === raw) ?? null;
}

/**
 * The DS01.3 clause a CONTRACT finding is counted under when the draft lens is
 * selected, or `null` when it is counted under none.
 *
 * `null` has two causes, and they are different claims. A requirement the clause
 * map does not carry forward (an `adv.*` advisory id, say) has no DS01.3 home at
 * all. A requirement in {@link RE_RUN_UNDER_SHADOW} has one, but the draft grades
 * it for itself — counting the 2025 result there as well would double-count the
 * clause and, worse, report a 2025 schema failure as a draft failure on a body
 * that satisfies Annex 4.
 */
export function clauseUnderLens(requirement: string, code?: string | null): string | null {
  if (RE_RUN_UNDER_SHADOW.has(requirement)) return null;
  if (code === CUSTOM_SCHEMA_CODES.pass || code === CUSTOM_SCHEMA_CODES.fail) return '5.3.5';
  return forwardClause(requirement);
}

/** The minimal finding shape the fold reads: what it counts, and where it counts. */
export interface LensFinding {
  requirement: string;
  severity: Severity;
  /** Which lineage produced the finding (by1c.5) — the fold's first question. */
  profile: Profile;
  /** The §3.2 outdated-but-valid modifier (2kx), tallied in its own map. */
  outdated: boolean;
  /** Stable check code, where the finding carries one. */
  code?: string | null;
}

/** What {@link foldUnderLens} produces: the two maps `computeComplianceSummary` joins on. */
export interface LensCounts {
  counts: FindingCountsByRequirement;
  outdated: OutdatedCountsByRequirement;
}

/**
 * Fold an already-scoped finding set into per-row counts under the selected lens.
 * PURE: no DB, no HTTP, and no knowledge of transmissions — the caller narrows to
 * the scope and hands over the findings.
 *
 * Under the contract lens this is exactly the fold the summary read has always
 * done (count contract findings by requirement id, ignore the other lineage), so
 * the default response is unchanged by construction rather than by coincidence.
 * Keys that no matrix row claims — an advisory id, a clause the selected package
 * does not carry — are simply never read by the join, which is how they were
 * dropped before.
 */
export function foldUnderLens(
  findings: Iterable<LensFinding>,
  lens: Profile,
  contract: Profile = CONTRACT_PROFILE,
): LensCounts {
  const counts: FindingCountsByRequirement = {};
  const outdated: OutdatedCountsByRequirement = {};

  for (const f of findings) {
    const row = rowFor(f, lens, contract);
    if (row === null) continue;
    const bucket: FindingCounts = (counts[row] ??= { pass: 0, fail: 0, info: 0 });
    bucket[f.severity] += 1;
    if (f.outdated) outdated[row] = (outdated[row] ?? 0) + 1;
  }

  return { counts, outdated };
}

/** The row one finding is counted under, or `null` when the lens counts it nowhere. */
function rowFor(f: LensFinding, lens: Profile, contract: Profile): string | null {
  if (lens === contract) return f.profile === contract ? f.requirement : null;
  if (f.profile === lens) return f.requirement;
  if (f.profile === contract) return clauseUnderLens(f.requirement, f.code);
  return null;
}

/**
 * A matrix row as the lens serves it: the three fields every row has, plus the
 * three the DS01.3 package adds.
 *
 * The extras are OPTIONAL and are ABSENT — not `false`/empty — under the contract
 * lens, so the default response body is byte-for-byte what it was before the lens
 * existed. A row that carries them is a DS01.3 row, and the browser can tag it
 * without a second lookup or a mirror of the clause map.
 */
export interface LensMatrixRow extends MatrixRow {
  /** At least one 2025 member is in `TIGHTENED`: conformance itself changed. */
  tightened?: boolean;
  /** The 2025 requirement ids this clause merges, in 2025 document order. */
  members?: readonly string[];
  /** Whether live counts feed the row (see the caution below). */
  graded?: boolean;
}

/**
 * The DS01.3 package as matrix rows: `requirement` is the clause id, and the
 * three DS01.3 fields ride along for the browser's tags.
 *
 * CAUTION on `graded`. It reports whether live counts FEED the row, which is not
 * the same question as whether DS01.3 added the clause. The two agree on 26 of the
 * 27 rows and part company on 5.3.5, which has no 2025 member and is still fed, by
 * the §3.1 custom-object check (see the header). So anything deciding what to show
 * as "new in DS01.3" should read `members.length === 0`, and anything deciding
 * whether a row has numbers behind it should read `graded`.
 */
const DS013_LENS_MATRIX: readonly LensMatrixRow[] = DS013_MATRIX.map((row) => ({
  requirement: row.clause,
  summary: row.summary,
  classes: row.classes,
  tightened: row.tightened,
  members: row.members,
  graded: row.graded,
}));

/** The matrix the selected lens renders: the §7 27 rows, or the DS01.3 27 clauses. */
export function lensMatrix(
  lens: Profile,
  contract: Profile = CONTRACT_PROFILE,
): readonly LensMatrixRow[] {
  return lens === contract ? COMPLIANCE_MATRIX : DS013_LENS_MATRIX;
}
