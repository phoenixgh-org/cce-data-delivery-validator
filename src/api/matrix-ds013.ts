/**
 * The DS01.3 requirement matrix (tfnv.2) — the 27 rows the grading lens renders
 * when the dashboard is switched from UNICEF Q1 2025 to DS01.3 DRAFT.
 *
 * It is DERIVED, not hand-typed. Every graded row is computed at module load
 * from {@link FORWARD} in `./clause-map.js` joined onto {@link COMPLIANCE_MATRIX}
 * in `./compliance-matrix.js`. A second hand-typed table would be a second place
 * to forget: adding a 2025 requirement, or re-pointing a clause in the map, would
 * leave the two tables disagreeing and nothing would say so. Here the join IS the
 * table, and `matrix-ds013.test.ts` proves the two sources cover each other.
 *
 * INHERITANCE RULE. A DS01.3 clause that merges several 2025 requirements (1.1 +
 * 1.2 → 5.1.3; 4.1 + 4.2 + 4.3 → 5.4.1; 4.4 + 4.5 → 5.4.2; 5.1 + 5.2 + 5.3 →
 * 5.4.4) takes the UNION of its members' verifiability classes, in first-seen
 * order, so `classes[0]` is the first member's primary class and still drives
 * display status. Inheriting is right for the reason DESIGN §7 gives for keeping
 * the 2025 rows contract-only: the class describes what a passive receiver can
 * establish about a supplier — this service's vantage — not what the standard
 * demands. Renumbering a clause does not change the vantage, so it must not
 * change the class.
 *
 * The six clauses with no 2025 equivalent ({@link NEW_IN_DS013}) have no members
 * to inherit from, so each carries the class decided for it (bd memory
 * `lens-decisions-classes-and-verdict-2026-09-17`) and `graded` is decided from
 * {@link NEW_FED_BY}: five of them are fed by nothing this service measures and
 * are carried as INFORMATIONAL rows, while 5.3.5 is fed by the §3.1 custom-object
 * check and is graded like any carried-forward clause. No finding is filed under a
 * DS01.3 clause id by this module, and nothing here changes what ingest grades or
 * stores.
 *
 * Internal `finding.requirement` values stay on the 2025 numbering; the lens
 * translates at read time. `docs/clause-mapping.md` remains the prose authority
 * for the map itself.
 */

import { DS013_TITLE, FORWARD, NEW_IN_DS013, TIGHTENED } from './clause-map.js';
import { COMPLIANCE_MATRIX, type ComplianceClass } from './compliance-matrix.js';
import { CUSTOM_SCHEMA_CODES } from '../ingest/stages/semantic/custom-schema.js';

/** A single DS01.3 matrix row: carried forward from 2025, or added by the draft. */
export interface Ds013MatrixRow {
  /** DS01.3 clause id, e.g. `5.1.3`. */
  clause: string;
  /** Short human-readable summary, from `DS013_TITLE`. */
  summary: string;
  /**
   * One or more verifiability classes. For a graded row this is the union of the
   * members' classes in first-seen order, so `classes[0]` is the first member's
   * primary class. For a clause DS01.3 adds it is the single decided class.
   */
  classes: readonly ComplianceClass[];
  /**
   * True when at least one member is in {@link TIGHTENED} — the clause changes
   * what conformance MEANS, not just where the text lives. Always false for a
   * clause DS01.3 adds: a clause with no 2025 equivalent cannot have tightened.
   */
  tightened: boolean;
  /**
   * The 2025 requirement ids this clause merges, in 2025 document order. Empty
   * for a clause DS01.3 adds, which is what makes a row new in the draft. The
   * lens's count fold and the web tags read it.
   */
  members: readonly string[];
  /**
   * True when live counts feed the row: every clause carried forward from a 2025
   * requirement, plus a clause DS01.3 adds whose finding codes fold onto it
   * ({@link NEW_FED_BY}). False where nothing this service measures lands on the
   * clause, so the card can say what DS01.3 adds beyond what we grade. This is a
   * different question from whether the clause is new — `members.length === 0`
   * answers that — and 5.3.5 is the one row where the two answers differ.
   */
  graded: boolean;
}

/**
 * Verifiability classes for the clauses with no 2025 equivalent. DECIDED
 * 2026-09-17 (Benson), clause by clause:
 *
 * - `5.1.1` employer data access rights — attestation; the rights themselves are
 *   contractual and invisible to a receiver.
 * - `5.1.2` transport of data — enforced; the endpoint is HTTPS-only.
 * - `5.1.11` transmission frequency — attestation; it mirrors §2.2, where the
 *   remote system's receipt time is unknown to the service.
 * - `5.1.12` optional pull API — none; permissive, like §1.7.
 * - `5.3.1` general payload contents — attestation; the identification half is
 *   enforced under 5.3.2, and the completeness half mirrors §3.3.
 * - `5.3.5` custom data object schema — verified; it is already graded passively
 *   by the §3.1 check (custom object names without `meta.customDataSchema` fail).
 *   Those findings carry a code of their own, so the lens files them under 5.3.5
 *   while the 2025 lens keeps them under §3.1. {@link NEW_FED_BY} is where this
 *   module reads that, and it is why 5.3.5 is the one added clause with counts.
 */
const NEW_CLASS: Readonly<Record<string, ComplianceClass>> = {
  '5.1.1': 'attestation',
  '5.1.2': 'enforced',
  '5.1.11': 'attestation',
  '5.1.12': 'none',
  '5.3.1': 'attestation',
  '5.3.5': 'verified',
};

/**
 * The finding codes that feed a clause with no 2025 member — the table that makes
 * such a row `graded`.
 *
 * DS01.3 splits the single 2025 §3.1 into the transmission-metadata duties (5.3.3)
 * and the duty to describe manufacturer-specific objects with a schema (5.3.5). The
 * custom-object check names both of its outcomes with a code, and a §3.1 finding
 * carrying either one folds onto 5.3.5 under the draft lens (`clauseUnderLens` in
 * `./lens.js`). So 5.3.5 has live counts without having a member, and this table is
 * what `buildMatrix` reads to say so — the clause id is not written into the build.
 * A clause absent from the table is fed by nothing this service measures, and its
 * row carries no counts.
 */
export const NEW_FED_BY: Readonly<Record<string, readonly string[]>> = {
  '5.3.5': [CUSTOM_SCHEMA_CODES.fail, CUSTOM_SCHEMA_CODES.pass],
};

/**
 * DS01.3 document order: compare clause ids segment by segment, numerically, so
 * `5.1.9` sorts before `5.1.10` (a plain string sort would not).
 */
function byClauseId(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function buildMatrix(): readonly Ds013MatrixRow[] {
  // Walk COMPLIANCE_MATRIX, not FORWARD's keys, so members land in 2025 document
  // order and `classes[0]` is the first member's primary class.
  const carried = new Map<string, { classes: ComplianceClass[]; members: string[] }>();
  for (const row of COMPLIANCE_MATRIX) {
    const clause = FORWARD[row.requirement];
    if (!clause) continue;
    const entry = carried.get(clause) ?? { classes: [], members: [] };
    entry.members.push(row.requirement);
    for (const cls of row.classes) {
      if (!entry.classes.includes(cls)) entry.classes.push(cls);
    }
    carried.set(clause, entry);
  }

  const rows: Ds013MatrixRow[] = [];
  for (const [clause, entry] of carried) {
    rows.push({
      clause,
      summary: DS013_TITLE[clause] ?? clause,
      classes: entry.classes,
      tightened: entry.members.some((req) => TIGHTENED.has(req)),
      members: entry.members,
      graded: true,
    });
  }
  for (const clause of NEW_IN_DS013) {
    const cls = NEW_CLASS[clause];
    rows.push({
      clause,
      summary: DS013_TITLE[clause] ?? clause,
      classes: cls ? [cls] : [],
      tightened: false,
      members: [],
      graded: (NEW_FED_BY[clause]?.length ?? 0) > 0,
    });
  }

  return rows.sort((a, b) => byClauseId(a.clause, b.clause));
}

/**
 * The DS01.3 matrix: 27 clauses in DS01.3 document order — 21 carried forward from
 * 2025 requirements and 6 the draft adds. 22 of them are graded, the extra one
 * being 5.3.5. Computed once at module load.
 */
export const DS013_MATRIX: readonly Ds013MatrixRow[] = buildMatrix();
