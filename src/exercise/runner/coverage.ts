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
 *
 * PAYLOAD TYPES, the second dimension (1m8). Direction alone was an honest answer
 * only while every case sent the same payload: the join counts REQUIREMENTS, so
 * the moment the table gained EMS cases, "covered (both directions)" started
 * meaning "covered for rtm" on every row but §3.2 — a silent cap, and exactly the
 * kind this suite refuses to print. So each row also carries the payload types
 * (`meta.transferType`, via {@link payloadTypeOf}) its pass and fail cases send,
 * and {@link formatCoverage} annotates every claimed row with them. A row read
 * from this report can no longer look EMS-exercised when only its rtm half exists.
 *
 * The type dimension does NOT change a row's `status`: `covered` still means both
 * DIRECTIONS, which is what `coverage.test.ts` and the epic's acceptance criterion
 * are about. Types qualify that verdict rather than gate it — a row that is
 * rtm-only is not automatically a GAP (a §1.1 405 halts before the schema stage
 * runs at all, so an EMS twin of it would exercise nothing new), it is a fact the
 * report must state instead of hide.
 *
 * ADVISORIES, the second join (axdd). The §7 join above is blind to the advisory
 * catalogue by construction: every `adv.*` case declares `requirements: []` — an
 * advisory is deliberately not a requirement — so an advisory with no case at all
 * looks exactly like one with ten. That is how `adv.null_padding` came to be the
 * one registered advisory the live run never exercised, without a single test
 * objecting. So the report carries a second section, joining the case table onto
 * {@link ADVISORY_IDS} — the registry's own list, which grows with the catalogue.
 *
 * THE DS01.3 ROWS, the third join (tfnv.10). The two joins above are 2025-only by
 * construction, so the draft package the grading lens renders had no coverage
 * line at all: a clause every case ignores looked exactly like one nine cases
 * exercise. Now the cases' `shadowClauses` are joined onto {@link DS013_MATRIX}
 * — the same 27 rows the lens serves — and the report says which clauses the
 * table exercises and which it does not.
 *
 * EXERCISED, not covered, and the word is chosen. The 2025 join grades a row on
 * being claimed in BOTH directions; the DS01.3 join asks only whether any case
 * names the clause, because the draft is unpublished and a run against it is
 * preparation rather than grading. A clause nobody names is reported, never
 * failed: most of the 27 have no exercise today and several never will. A clause
 * with no 2025 member is informational — the receiving side files no finding
 * under it at all — UNLESS a finding code feeds it (`NEW_FED_BY` in
 * src/api/matrix-ds013.ts), which today is 5.3.5 alone.
 *
 * FIRED is the only direction this join reports: at least one case expects
 * `{ requirement: <id>, severity: 'info' }` under the CONTRACT profile. An
 * advisory that stays silent on conformant traffic is the other half of the
 * catalogue's contract and is NOT expressible yet — a case can only assert
 * findings it expects, never findings it expects to be absent — so this section
 * says "exercised", never "correct". Payload types annotate a fired advisory the
 * same way they annotate a requirement, and for the same reason: `adv.blank_admin`
 * exercised only on EMS traffic is a fact the report must state rather than hide.
 */

import {
  COMPLIANCE_MATRIX,
  type ComplianceClass,
  type MatrixRow,
} from '../../api/compliance-matrix.js';
import { DS013_MATRIX, type Ds013MatrixRow } from '../../api/matrix-ds013.js';
import { ADVISORY_IDS, type AdvisoryId } from '../../ingest/stages/semantic/advisory.js';
import { CONTRACT_PROFILE } from '../../schema-registry.js';
import { payloadTypeOf, type ExerciseCase } from '../case.js';

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
  /** Payload types the pass-direction cases send, sorted and deduplicated. */
  readonly passTypes: readonly string[];
  /** Payload types the fail-direction cases send, sorted and deduplicated. */
  readonly failTypes: readonly string[];
  /**
   * Payload types exercised in BOTH directions — the type-level analogue of
   * `covered`, and the field that keeps this report honest: a `covered` row whose
   * `coveredTypes` is `['rtm']` is not exercised for EMS, however green it reads.
   */
  readonly coveredTypes: readonly string[];
}

/**
 * One registered advisory joined with the cases that expect it to fire.
 *
 * There is no `passCases`/`failCases` split here, and deliberately: every `adv.*`
 * case is direction `fail` (it sends traffic the validator accepts while having
 * something to say about it), so splitting on direction would print one empty
 * column for the whole catalogue. What matters is whether the advisory is
 * exercised at all, and on which payload branches.
 */
export interface AdvisoryCoverageRow {
  /** The registered advisory id, e.g. `adv.null_padding`. */
  readonly advisory: AdvisoryId;
  /** True when at least one case expects this advisory under the contract. */
  readonly fired: boolean;
  /** Ids of the cases expecting it, in table order. */
  readonly fireCases: readonly string[];
  /** Payload types those cases send, sorted and deduplicated. */
  readonly fireTypes: readonly string[];
}

/** The advisory half of the report: every registered id, in registry order. */
export interface AdvisoryCoverage {
  readonly rows: readonly AdvisoryCoverageRow[];
  readonly fired: readonly AdvisoryCoverageRow[];
  /** Registered advisories no case fires — the gap this section exists to show. */
  readonly notExercised: readonly AdvisoryCoverageRow[];
}

/** One DS01.3 clause joined with the cases that name it in `shadowClauses`. */
export interface Ds013CoverageRow {
  /** The DS01.3 clause id, e.g. `5.3.2`. */
  readonly clause: string;
  readonly summary: string;
  /** True when at least one case names this clause. */
  readonly exercised: boolean;
  /** Ids of the cases naming it, in table order. */
  readonly cases: readonly string[];
  /** Payload types those cases send, sorted and deduplicated. */
  readonly types: readonly string[];
  /**
   * Whether live counts feed the clause (`Ds013MatrixRow.graded`): every clause
   * carried forward from a 2025 member, plus any clause a finding code feeds
   * (`NEW_FED_BY`, today 5.3.5 alone). Carried so an unexercised row can say
   * whether it is a gap in the table or a clause nothing files a finding under.
   */
  readonly graded: boolean;
}

/** The DS01.3 half of the report: every clause of the draft package, in matrix order. */
export interface Ds013Coverage {
  readonly rows: readonly Ds013CoverageRow[];
  readonly exercised: readonly Ds013CoverageRow[];
  readonly notExercised: readonly Ds013CoverageRow[];
  /**
   * Clause ids the cases name that the DS01.3 matrix does not carry — the same
   * rule as {@link CoverageReport.unknownClaims}, for the same reason: a claim
   * nobody joins to is indistinguishable from no claim at all.
   */
  readonly unknownClaims: readonly string[];
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
   * Every payload type the case table sends at all, sorted — the header's honest
   * answer to "which schema branches did this run touch?", computed from the
   * cases rather than stated by anyone.
   */
  readonly payloadTypes: readonly string[];
  /**
   * Requirement ids the case table claims that the matrix does not carry — a
   * typo'd or retired id, which would otherwise vanish silently (a claim nobody
   * joins to is indistinguishable from no claim at all).
   */
  readonly unknownClaims: readonly string[];
  /** The advisory join (axdd) — see {@link AdvisoryCoverage}. */
  readonly advisories: AdvisoryCoverage;
  /** The DS01.3 clause join (tfnv.10) — see {@link Ds013Coverage}. */
  readonly ds013: Ds013Coverage;
}

function statusFor(gradeable: boolean, passCases: string[], failCases: string[]): CoverageStatus {
  if (!gradeable) return 'uncovered-by-design';
  if (passCases.length > 0 && failCases.length > 0) return 'covered';
  if (passCases.length > 0 || failCases.length > 0) return 'partial';
  return 'uncovered';
}

/** Sorted, deduplicated — every list of payload types this module hands out. */
function sortedTypes(types: Iterable<string>): string[] {
  return [...new Set(types)].sort();
}

/**
 * Join the case table onto the registered advisory catalogue (axdd).
 *
 * FIRED means one specific expectation: a case expecting `severity: 'info'` on
 * this id under the CONTRACT profile. Each half of that matters. `info` is the
 * only severity an advisory can carry (advisory-finding.ts builds it), so an
 * expectation naming any other severity is about something else. And a shadow-
 * profile expectation grades an unpublished draft in a different vocabulary, so
 * counting one would report the contract catalogue as exercised by a run that
 * never touched it.
 *
 * The join runs over `expectedFindings`, not over `requirements`, which is the
 * mirror image of the §7 rule above — and for the same reason. There, counting
 * findings would inflate coverage because every accepted POST earns an incidental
 * §3.2 pass. Here, `requirements` is empty on every advisory case by design, so
 * the expectation IS the claim: a case cannot expect an advisory it does not mean
 * to provoke.
 */
function computeAdvisories(
  cases: readonly ExerciseCase[],
  ids: readonly AdvisoryId[],
): AdvisoryCoverage {
  const fireCases = new Map<string, string[]>();
  const fireTypes = new Map<string, string[]>();
  for (const kase of cases) {
    const expectations = kase.expectedFindings.filter(
      (finding) =>
        finding.severity === 'info' && (finding.profile ?? CONTRACT_PROFILE) === CONTRACT_PROFILE,
    );
    if (expectations.length === 0) continue;
    // Asked once per case, and only for a case that expects something: the type
    // is a property of the case, and asking costs a baseline generation.
    const type = payloadTypeOf(kase);
    for (const finding of expectations) {
      const caseIds = fireCases.get(finding.requirement);
      if (caseIds) caseIds.push(kase.id);
      else fireCases.set(finding.requirement, [kase.id]);
      const types = fireTypes.get(finding.requirement);
      if (types) types.push(type);
      else fireTypes.set(finding.requirement, [type]);
    }
  }

  const rows = ids.map((advisory): AdvisoryCoverageRow => {
    const caseIds = fireCases.get(advisory) ?? [];
    return {
      advisory,
      fired: caseIds.length > 0,
      fireCases: caseIds,
      fireTypes: sortedTypes(fireTypes.get(advisory) ?? []),
    };
  });

  return {
    rows,
    fired: rows.filter((row) => row.fired),
    notExercised: rows.filter((row) => !row.fired),
  };
}

/**
 * Join the case table onto the DS01.3 package (tfnv.10).
 *
 * THE CLAIM IS `shadowClauses`, which is the same rule the §7 join uses one
 * lineage over: the clauses a case says it is ABOUT, not the clauses its
 * expectations happen to reach. The two are not interchangeable here either — a
 * DS01.3 fail folds a transport breach onto 5.1.x whatever the case was written
 * for, so counting folded evidence would report most of the package as exercised
 * by cases that never considered it.
 *
 * Nothing about this join changes `requirements`, which stays 2025 ids: the two
 * packages are reported side by side, never merged.
 */
function computeDs013(
  cases: readonly ExerciseCase[],
  matrix: readonly Ds013MatrixRow[],
): Ds013Coverage {
  const claims = new Map<string, string[]>();
  const claimTypes = new Map<string, string[]>();
  for (const kase of cases) {
    const clauses = kase.shadowClauses ?? [];
    if (clauses.length === 0) continue;
    // Asked once per claiming case: the type is a property of the case, and
    // asking costs a baseline generation.
    const type = payloadTypeOf(kase);
    for (const clause of clauses) {
      const caseIds = claims.get(clause);
      if (caseIds) caseIds.push(kase.id);
      else claims.set(clause, [kase.id]);
      const types = claimTypes.get(clause);
      if (types) types.push(type);
      else claimTypes.set(clause, [type]);
    }
  }

  const rows = matrix.map((row): Ds013CoverageRow => {
    const caseIds = claims.get(row.clause) ?? [];
    return {
      clause: row.clause,
      summary: row.summary,
      exercised: caseIds.length > 0,
      cases: caseIds,
      types: sortedTypes(claimTypes.get(row.clause) ?? []),
      graded: row.graded,
    };
  });

  const known = new Set(matrix.map((row) => row.clause));
  const unknownClaims = [...claims.keys()].filter((clause) => !known.has(clause)).sort();

  return {
    rows,
    exercised: rows.filter((row) => row.exercised),
    notExercised: rows.filter((row) => !row.exercised),
    unknownClaims,
  };
}

/**
 * Join the case table onto the §7 matrix and the advisory catalogue. PURE — no
 * I/O, no mutation of inputs.
 *
 * `matrix`, `advisoryIds` and `ds013Matrix` default to the real tables and are
 * injectable ONLY so the unit tests can pin the join's RULES against small
 * synthetic ones; the runner passes the real matrix explicitly and the other two
 * by omission.
 */
export function computeCoverage(
  cases: readonly ExerciseCase[],
  matrix: readonly MatrixRow[] = COMPLIANCE_MATRIX,
  advisoryIds: readonly AdvisoryId[] = ADVISORY_IDS,
  ds013Matrix: readonly Ds013MatrixRow[] = DS013_MATRIX,
): CoverageReport {
  const passClaims = new Map<string, string[]>();
  const failClaims = new Map<string, string[]>();
  const passTypeClaims = new Map<string, string[]>();
  const failTypeClaims = new Map<string, string[]>();
  const allTypes: string[] = [];
  for (const kase of cases) {
    const pass = kase.direction === 'pass';
    const claims = pass ? passClaims : failClaims;
    const typeClaims = pass ? passTypeClaims : failTypeClaims;
    // Once per case, not once per (case, requirement): the type is a property of
    // the case, and asking costs a baseline generation.
    const type = payloadTypeOf(kase);
    allTypes.push(type);
    for (const requirement of kase.requirements) {
      const bucket = claims.get(requirement);
      if (bucket) bucket.push(kase.id);
      else claims.set(requirement, [kase.id]);
      const types = typeClaims.get(requirement);
      if (types) types.push(type);
      else typeClaims.set(requirement, [type]);
    }
  }

  const rows = matrix.map((row): CoverageRow => {
    const gradeable = isGradeable(row);
    const passCases = passClaims.get(row.requirement) ?? [];
    const failCases = failClaims.get(row.requirement) ?? [];
    const passTypes = sortedTypes(passTypeClaims.get(row.requirement) ?? []);
    const failTypes = sortedTypes(failTypeClaims.get(row.requirement) ?? []);
    return {
      requirement: row.requirement,
      summary: row.summary,
      primaryClass: row.classes[0]!,
      gradeable,
      status: statusFor(gradeable, passCases, failCases),
      passCases,
      failCases,
      passTypes,
      failTypes,
      coveredTypes: passTypes.filter((type) => failTypes.includes(type)),
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
    payloadTypes: sortedTypes(allTypes),
    unknownClaims,
    advisories: computeAdvisories(cases, advisoryIds),
    ds013: computeDs013(cases, ds013Matrix),
  };
}

/**
 * The payload types a row was exercised with, bracketed after its id — the
 * qualification that stops `covered` from reading as "covered for everything".
 *
 * A type exercised in only ONE direction of an otherwise-covered row is marked
 * as such (`3.2[ems(fail-only),rtm]`), because that is the same silent cap one
 * level down: an EMS fail case alone proves the validator catches EMS defects,
 * not that it accepts conformant EMS traffic. A `partial` row needs no such mark
 * — its own line already says which direction it has. Rows no case claims get no
 * annotation at all; there is nothing to qualify.
 */
function types(row: CoverageRow): string {
  const all = sortedTypes([...row.passTypes, ...row.failTypes]);
  if (all.length === 0) return '';
  const labelled = all.map((type) => {
    if (row.status !== 'covered' || row.coveredTypes.includes(type)) return type;
    return `${type}(${row.passTypes.includes(type) ? 'pass' : 'fail'}-only)`;
  });
  return `[${labelled.join(',')}]`;
}

function ids(rows: readonly CoverageRow[]): string {
  return rows.length === 0 ? '—' : rows.map((row) => `${row.requirement}${types(row)}`).join(' ');
}

/**
 * The DS01.3 equivalent of {@link ids}: the clause id, annotated with the payload
 * types its cases send. One direction like the advisory join, and for the same
 * reason — a DS01.3 clause is not claimed in a direction, it is named or it is
 * not. An unexercised clause gets no bracket; there is nothing to qualify.
 */
function ds013Ids(rows: readonly Ds013CoverageRow[]): string {
  if (rows.length === 0) return '—';
  return rows
    .map((row) => `${row.clause}${row.types.length === 0 ? '' : `[${row.types.join(',')}]`}`)
    .join(' ');
}

/**
 * The advisory equivalent of {@link ids}. The bracket is simpler here because an
 * advisory row has one direction to report rather than two: `[ems]` means every
 * case firing it sends EMS traffic, and nothing about the rtm branch is claimed.
 * An advisory nothing fires gets no bracket — there is nothing to qualify.
 */
function advisoryIds(rows: readonly AdvisoryCoverageRow[]): string {
  if (rows.length === 0) return '—';
  return rows
    .map(
      (row) => `${row.advisory}${row.fireTypes.length === 0 ? '' : `[${row.fireTypes.join(',')}]`}`,
    )
    .join(' ');
}

/**
 * Render the report as printable lines. Terse by design: the per-requirement
 * detail belongs to the dashboard, and this is a gap list, not a table.
 *
 * Every claimed requirement is printed WITH the payload types it was exercised
 * with, and the legend says what a single-type bracket means, so the reader
 * cannot take a green line for coverage it does not have (1m8). Both are derived
 * from the case table: nothing here states a count that can go stale.
 */
export function formatCoverage(report: CoverageReport): string[] {
  const lines = [
    `coverage — ${report.gradeable.length} gradeable requirement(s), ` +
      `payload types sent: ${report.payloadTypes.join(' ') || '—'}`,
  ];
  lines.push(
    '  [types] after a requirement are the payload branches it was exercised with — ' +
      '[rtm] means rtm ONLY',
  );
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

  // The advisory section (axdd). It reports EXERCISE, not correctness: an
  // advisory nothing fires is a gap in the suite, while an advisory that fires is
  // only known to be reachable — whether it stays quiet on conformant traffic is
  // a separate question this table cannot yet ask.
  const { advisories } = report;
  lines.push(`advisories — ${advisories.rows.length} registered: fired ${advisories.fired.length}`);
  lines.push(
    '  [types] after an advisory are the payload branches its fire case(s) send — ' +
      '[ems] means ems ONLY',
  );
  lines.push(`  fired                      ${advisoryIds(advisories.fired)}`);
  lines.push(`  NOT EXERCISED              ${advisoryIds(advisories.notExercised)}`);

  // The DS01.3 section (tfnv.10). It sits beside the 2025 lines rather than
  // inside them: the draft is a second package, not a second column of the first,
  // and a clause with no exercise is reported rather than failed — the draft is
  // unpublished, and several of its clauses are informational rows no finding is
  // ever filed under (a clause with no 2025 member is one of those unless a
  // finding code feeds it, which today is 5.3.5 alone).
  const { ds013 } = report;
  lines.push(
    `DS01.3 rows — ${ds013.rows.length} clause(s): exercised ${ds013.exercised.length}, ` +
      `not exercised ${ds013.notExercised.length}`,
  );
  lines.push(
    '  a clause is exercised when a case names it in `shadowClauses` — ' + 'reported, never failed',
  );
  lines.push(`  exercised                  ${ds013Ids(ds013.exercised)}`);
  lines.push(`  not exercised              ${ds013Ids(ds013.notExercised)}`);
  if (ds013.unknownClaims.length > 0) {
    lines.push(`  CLAIMED BUT NOT IN THE DS01.3 MATRIX  ${ds013.unknownClaims.join(' ')}`);
  }
  return lines;
}
