/**
 * The COVERAGE JOIN (8qa.2; epic 8qa "Traceability is a mechanical join").
 *
 * Which requirements the suite exercises is a COMPUTED fact, never an annotation
 * someone has to remember to update. This module joins the case table onto
 * `COMPLIANCE_MATRIX` — the same 27 rows the dashboard grades against — and says,
 * per row, whether a case claims it and in which directions.
 *
 * GRADEABLE is the matrix's own definition: the row's PRIMARY class (`classes[0]`,
 * the one `deriveStatus` grades on) is `verified` or `heuristic`. Every other
 * primary class — `active-only`, `attestation`, `enforced`, `none` — describes a
 * requirement the receiving side cannot passively grade at all (DESIGN.md §7), so
 * those rows are reported as UNCOVERED BY DESIGN rather than as gaps. Reusing the
 * matrix's classes means a requirement that becomes gradeable later joins the
 * gradeable set here automatically.
 *
 * WHAT COUNTS AS A CLAIM: `ExerciseCase.requirements` — the requirements the case
 * TARGETS — and not the requirements its `expectedFindings` happen to mention. A
 * case that targets §1.2 while observing the incidental §3.2 pass every accepted
 * POST earns is not an exercise OF §3.2, and letting it count as one would make
 * coverage look complete the moment any case passed the schema stage.
 *
 * DIRECTIONS: the epic wants each gradeable requirement exercised BOTH ways, so a
 * row claimed in only one direction is reported `partial` rather than silently
 * counted as covered. `partial` is informational — the runner prints it but does
 * not fail on it (nor on `uncovered`): with the 8qa.1 representative table
 * several gradeable rows are legitimately still bare until 8qa.3–.5 fill them.
 * The coverage report is the thing that makes those gaps VISIBLE.
 */

import {
  COMPLIANCE_MATRIX,
  type ComplianceClass,
  type MatrixRow,
} from '../../api/compliance-matrix.js';
import type { ExerciseCase } from '../case.js';

/** Primary classes the receiving side actually grades (DESIGN.md §7). */
export const GRADEABLE_CLASSES: readonly ComplianceClass[] = ['verified', 'heuristic'];

/** True when a matrix row's PRIMARY class is one this validator grades. */
export function isGradeable(row: MatrixRow): boolean {
  // classes is non-empty by construction; classes[0] is the grading class.
  return GRADEABLE_CLASSES.includes(row.classes[0]!);
}

/**
 * A gradeable row's coverage state:
 * - `covered`             at least one pass-direction AND one fail-direction case.
 * - `partial`             claimed, but in only one direction.
 * - `uncovered`           no case claims it.
 * - `uncovered-by-design`  not gradeable — nothing to exercise from here.
 */
export type CoverageStatus = 'covered' | 'partial' | 'uncovered' | 'uncovered-by-design';

/** One matrix row joined with the cases that claim it. */
export interface CoverageRow {
  readonly requirement: string;
  readonly summary: string;
  readonly primaryClass: ComplianceClass;
  readonly gradeable: boolean;
  readonly status: CoverageStatus;
  /** Ids of pass-direction cases claiming this requirement, in table order. */
  readonly passCases: readonly string[];
  /** Ids of fail-direction cases claiming this requirement, in table order. */
  readonly failCases: readonly string[];
}

/** The whole join. `rows` is every matrix row, in matrix order. */
export interface CoverageReport {
  readonly rows: readonly CoverageRow[];
  readonly gradeable: readonly CoverageRow[];
  readonly covered: readonly CoverageRow[];
  readonly partial: readonly CoverageRow[];
  readonly uncovered: readonly CoverageRow[];
  readonly byDesign: readonly CoverageRow[];
  /**
   * Requirement ids the case table claims that the matrix does not carry — a
   * typo'd or retired id, which would otherwise vanish silently (a claim nobody
   * joins to is indistinguishable from no claim at all).
   */
  readonly unknownClaims: readonly string[];
}

function statusFor(gradeable: boolean, passCases: string[], failCases: string[]): CoverageStatus {
  if (!gradeable) return 'uncovered-by-design';
  if (passCases.length > 0 && failCases.length > 0) return 'covered';
  if (passCases.length > 0 || failCases.length > 0) return 'partial';
  return 'uncovered';
}

/** Join the case table onto the §7 matrix. PURE — no I/O, no mutation of inputs. */
export function computeCoverage(
  cases: readonly ExerciseCase[],
  matrix: readonly MatrixRow[] = COMPLIANCE_MATRIX,
): CoverageReport {
  const passClaims = new Map<string, string[]>();
  const failClaims = new Map<string, string[]>();
  for (const kase of cases) {
    const claims = kase.direction === 'pass' ? passClaims : failClaims;
    for (const requirement of kase.requirements) {
      const bucket = claims.get(requirement);
      if (bucket) bucket.push(kase.id);
      else claims.set(requirement, [kase.id]);
    }
  }

  const rows = matrix.map((row): CoverageRow => {
    const gradeable = isGradeable(row);
    const passCases = passClaims.get(row.requirement) ?? [];
    const failCases = failClaims.get(row.requirement) ?? [];
    return {
      requirement: row.requirement,
      summary: row.summary,
      primaryClass: row.classes[0]!,
      gradeable,
      status: statusFor(gradeable, passCases, failCases),
      passCases,
      failCases,
    };
  });

  const known = new Set(matrix.map((row) => row.requirement));
  const unknownClaims = [
    ...new Set(
      cases.flatMap((kase) => kase.requirements.filter((requirement) => !known.has(requirement))),
    ),
  ].sort();

  return {
    rows,
    gradeable: rows.filter((row) => row.gradeable),
    covered: rows.filter((row) => row.status === 'covered'),
    partial: rows.filter((row) => row.status === 'partial'),
    uncovered: rows.filter((row) => row.status === 'uncovered'),
    byDesign: rows.filter((row) => row.status === 'uncovered-by-design'),
    unknownClaims,
  };
}

function ids(rows: readonly CoverageRow[]): string {
  return rows.length === 0 ? '—' : rows.map((row) => row.requirement).join(' ');
}

/**
 * Render the report as printable lines. Terse by design: the per-requirement
 * detail belongs to the dashboard, and this is a gap list, not a table.
 */
export function formatCoverage(report: CoverageReport): string[] {
  const lines = [`coverage — ${report.gradeable.length} gradeable requirement(s)`];
  lines.push(`  covered (both directions)  ${ids(report.covered)}`);
  lines.push(`  partial (one direction)    ${ids(report.partial)}`);
  for (const row of report.partial) {
    const direction = row.passCases.length > 0 ? 'pass only' : 'fail only';
    lines.push(`      §${row.requirement} ${direction} — ${row.summary}`);
  }
  lines.push(`  UNCOVERED                  ${ids(report.uncovered)}`);
  for (const row of report.uncovered) {
    lines.push(`      §${row.requirement} — ${row.summary}`);
  }
  lines.push(`  uncovered by design (${report.byDesign.length})  ${ids(report.byDesign)}`);
  if (report.unknownClaims.length > 0) {
    lines.push(`  CLAIMED BUT NOT IN THE MATRIX  ${report.unknownClaims.join(' ')}`);
  }
  return lines;
}
