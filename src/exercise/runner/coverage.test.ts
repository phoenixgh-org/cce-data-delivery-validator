/**
 * Unit tests for the coverage join (8qa.2).
 *
 * These DO run in `npm test`. The join is what makes an unexercised requirement
 * a computed fact rather than a stale annotation, so it is tested against a
 * synthetic matrix (to pin the RULES) and against the real
 * COMPLIANCE_MATRIX + EXERCISE_CASES (to pin the join's actual shape).
 *
 * NOTE ON THE LIVE TABLE: this used to say gradeable requirements were EXPECTED to
 * show up uncovered while 8qa.3–.5 filled them in. They are all filled in now, so
 * the real-table test below asserts the epic's target outright — no gradeable row
 * left partial or uncovered. The synthetic-matrix tests still check the join's
 * MECHANICS, which is why both halves are here.
 *
 * The ADVISORY join (axdd) is tested the same way, against a synthetic catalogue
 * for the rules and against ADVISORY_IDS + EXERCISE_CASES for the live fact:
 * every registered advisory has a case that fires it.
 *
 * The DS01.3 join (tfnv.10) follows the same pattern once more. Its live fact is
 * weaker on purpose: a clause with no exercise is REPORTED, never failed, because
 * the draft is unpublished and several of its clauses are informational rows no
 * finding is filed under — so what is pinned is that the report prints both
 * halves and that the table names no clause the draft matrix lacks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPLIANCE_MATRIX, type MatrixRow } from '../../api/compliance-matrix.js';
import { DS013_MATRIX, type Ds013MatrixRow } from '../../api/matrix-ds013.js';
import { ADVISORY_IDS, type AdvisoryId } from '../../ingest/stages/semantic/advisory.js';
import { emsBaseline } from '../baseline.js';
import type { ExerciseCase } from '../case.js';
import { EXERCISE_CASES } from '../cases.js';
import { computeCoverage, formatCoverage, isGradeable } from './coverage.js';

const MATRIX: readonly MatrixRow[] = [
  { requirement: '1.1', summary: 'verified + enforced', classes: ['verified', 'enforced'] },
  { requirement: '1.7', summary: 'nothing to grade', classes: ['none'] },
  { requirement: '1.8', summary: 'heuristic', classes: ['heuristic'] },
  { requirement: '3.2', summary: 'verified', classes: ['verified'] },
  { requirement: '4.1', summary: 'active-only', classes: ['active-only'] },
  { requirement: '4.7', summary: 'attestation', classes: ['attestation'] },
];

function kase(overrides: Partial<ExerciseCase> & Pick<ExerciseCase, 'id'>): ExerciseCase {
  return {
    title: overrides.id,
    requirements: ['3.2'],
    direction: 'pass',
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [],
    ...overrides,
  };
}

// ── the gradeable filter ────────────────────────────────────────────────────

test('gradeable is decided by the PRIMARY class, so a split row like 1.1 grades', () => {
  assert.equal(isGradeable(MATRIX[0]!), true); // ['verified', 'enforced']
  assert.equal(isGradeable(MATRIX[2]!), true); // heuristic
  assert.equal(isGradeable(MATRIX[1]!), false); // none
  assert.equal(isGradeable(MATRIX[4]!), false); // active-only
  assert.equal(isGradeable(MATRIX[5]!), false); // attestation
});

// ── statuses ────────────────────────────────────────────────────────────────

test('a requirement exercised in both directions is covered', () => {
  const report = computeCoverage(
    [
      kase({ id: 'pass', requirements: ['3.2'], direction: 'pass' }),
      kase({
        id: 'fail',
        requirements: ['3.2'],
        direction: 'fail',
        fault: { layer: 'payload', note: 'synthetic' },
      }),
    ],
    MATRIX,
  );
  const row = report.rows.find((r) => r.requirement === '3.2')!;
  assert.equal(row.status, 'covered');
  assert.deepEqual(row.passCases, ['pass']);
  assert.deepEqual(row.failCases, ['fail']);
  assert.deepEqual(
    report.covered.map((r) => r.requirement),
    ['3.2'],
  );
});

test('a requirement exercised in one direction only is partial, not covered', () => {
  const report = computeCoverage([kase({ id: 'pass-only', requirements: ['3.2'] })], MATRIX);
  assert.equal(report.rows.find((r) => r.requirement === '3.2')!.status, 'partial');
  assert.deepEqual(
    report.partial.map((r) => r.requirement),
    ['3.2'],
  );
});

test('a gradeable requirement no case claims is UNCOVERED', () => {
  const report = computeCoverage([kase({ id: 'only-3.2' })], MATRIX);
  assert.deepEqual(
    report.uncovered.map((r) => r.requirement),
    ['1.1', '1.8'],
  );
});

test('non-gradeable rows are uncovered BY DESIGN, never counted as gaps', () => {
  const report = computeCoverage([], MATRIX);
  assert.deepEqual(
    report.byDesign.map((r) => r.requirement),
    ['1.7', '4.1', '4.7'],
  );
  for (const row of report.byDesign) assert.equal(row.gradeable, false);
  // …and they never appear in the gap list, however bare the table is.
  assert.deepEqual(
    report.uncovered.map((r) => r.requirement),
    ['1.1', '1.8', '3.2'],
  );
});

test('coverage comes from a case’s targets, not from findings it merely observes', () => {
  // Mirrors the real 1.2 case, which expects the incidental §3.2 pass finding.
  const report = computeCoverage(
    [
      kase({
        id: '1.1-fail-thing',
        requirements: ['1.1'],
        direction: 'fail',
        fault: { layer: 'transport', note: 'synthetic' },
        expectedFindings: [
          { requirement: '1.1', severity: 'fail' },
          { requirement: '3.2', severity: 'pass' },
        ],
      }),
    ],
    MATRIX,
  );
  assert.equal(report.rows.find((r) => r.requirement === '1.1')!.status, 'partial');
  assert.equal(report.rows.find((r) => r.requirement === '3.2')!.status, 'uncovered');
});

test('a claim the matrix does not carry is surfaced rather than silently dropped', () => {
  const report = computeCoverage([kase({ id: 'typo', requirements: ['3.2', '9.9'] })], MATRIX);
  assert.deepEqual(report.unknownClaims, ['9.9']);
});

// ── the payload-type dimension (1m8) ────────────────────────────────────────

function emsKase(overrides: Partial<ExerciseCase> & Pick<ExerciseCase, 'id'>): ExerciseCase {
  return { ...kase(overrides), baseline: emsBaseline };
}

test('a row carries the payload types of the cases claiming it', () => {
  const report = computeCoverage(
    [
      kase({ id: 'rtm-pass' }),
      emsKase({ id: 'ems-pass' }),
      kase({
        id: 'rtm-fail',
        direction: 'fail',
        fault: { layer: 'payload', note: 'synthetic' },
      }),
    ],
    MATRIX,
  );
  const row = report.rows.find((r) => r.requirement === '3.2')!;
  assert.deepEqual(row.passTypes, ['ems', 'rtm']);
  assert.deepEqual(row.failTypes, ['rtm']);
  // ems is exercised in ONE direction, so it is not a type this row covers…
  assert.deepEqual(row.coveredTypes, ['rtm']);
  // …while the row's own status stays direction-based, as the epic defines it.
  assert.equal(row.status, 'covered');
  assert.deepEqual(report.payloadTypes, ['ems', 'rtm']);
});

test('a requirement exercised only with ems does not read as covered for rtm', () => {
  // The silent cap, in the small: counting requirements alone, this row is
  // "covered (both directions)" and says nothing about which branch of the schema
  // either direction actually reached.
  const report = computeCoverage(
    [
      emsKase({ id: 'ems-pass' }),
      emsKase({ id: 'ems-fail', direction: 'fail', fault: { layer: 'payload', note: 'x' } }),
    ],
    MATRIX,
  );
  const row = report.rows.find((r) => r.requirement === '3.2')!;
  assert.deepEqual(row.coveredTypes, ['ems']);
  assert.match(formatCoverage(report).join('\n'), /covered \(both directions\)\s+3\.2\[ems\]/);
});

test('formatCoverage marks a type that only one direction exercises', () => {
  const report = computeCoverage(
    [
      kase({ id: 'rtm-pass' }),
      kase({ id: 'rtm-fail', direction: 'fail', fault: { layer: 'payload', note: 'x' } }),
      emsKase({ id: 'ems-fail', direction: 'fail', fault: { layer: 'payload', note: 'x' } }),
    ],
    MATRIX,
  );
  assert.match(formatCoverage(report).join('\n'), /3\.2\[ems\(fail-only\),rtm\]/);
});

test('a partial row lists its types plainly — its line already names the direction', () => {
  const report = computeCoverage([emsKase({ id: 'ems-pass' })], MATRIX);
  const text = formatCoverage(report).join('\n');
  assert.match(text, /partial \(one direction\)\s+3\.2\[ems\]/);
  assert.doesNotMatch(text, /pass-only/);
});

test('rows no case claims are printed without a type annotation', () => {
  const text = formatCoverage(computeCoverage([], MATRIX)).join('\n');
  assert.match(text, /UNCOVERED\s+1\.1 1\.8 3\.2$/m);
});

// ── the advisory join (axdd) ────────────────────────────────────────────────

/**
 * A synthetic catalogue, so these tests pin the RULES rather than today's thirteen
 * registered advisories — the same reason `MATRIX` above is not COMPLIANCE_MATRIX.
 */
const ADVISORIES: readonly AdvisoryId[] = ['adv.alpha', 'adv.beta', 'adv.gamma'];

/** An advisory case in the table's own idiom: fail direction, no requirement claimed. */
function advKase(overrides: Partial<ExerciseCase> & Pick<ExerciseCase, 'id'>): ExerciseCase {
  return kase({
    requirements: [],
    direction: 'fail',
    fault: { layer: 'payload', note: 'synthetic' },
    ...overrides,
  });
}

test('an advisory a case expects is fired, with the case that fires it', () => {
  const report = computeCoverage(
    [
      advKase({
        id: 'adv.alpha-fail-thing',
        expectedFindings: [{ requirement: 'adv.alpha', severity: 'info' }],
      }),
    ],
    MATRIX,
    ADVISORIES,
  );
  assert.deepEqual(
    report.advisories.rows.map((row) => row.advisory),
    ['adv.alpha', 'adv.beta', 'adv.gamma'],
  );
  const row = report.advisories.rows.find((r) => r.advisory === 'adv.alpha')!;
  assert.equal(row.fired, true);
  assert.deepEqual(row.fireCases, ['adv.alpha-fail-thing']);
  assert.deepEqual(row.fireTypes, ['rtm']);
});

test('a registered advisory no case expects is NOT EXERCISED', () => {
  const report = computeCoverage(
    [
      advKase({
        id: 'adv.alpha-fail-thing',
        expectedFindings: [{ requirement: 'adv.alpha', severity: 'info' }],
      }),
    ],
    MATRIX,
    ADVISORIES,
  );
  assert.deepEqual(
    report.advisories.notExercised.map((row) => row.advisory),
    ['adv.beta', 'adv.gamma'],
  );
  assert.match(formatCoverage(report).join('\n'), /NOT EXERCISED\s+adv\.beta adv\.gamma$/m);
});

test('a fired advisory carries the payload branches its cases send', () => {
  // The same anti-silent-cap rule as for requirements, one level over: an
  // advisory exercised only on EMS traffic says nothing about the rtm branch.
  const report = computeCoverage(
    [
      advKase({
        id: 'adv.alpha-fail-rtm',
        expectedFindings: [{ requirement: 'adv.alpha', severity: 'info' }],
      }),
      advKase({
        id: 'adv.alpha-fail-ems',
        baseline: emsBaseline,
        expectedFindings: [{ requirement: 'adv.alpha', severity: 'info' }],
      }),
      advKase({
        id: 'adv.beta-fail-ems',
        baseline: emsBaseline,
        expectedFindings: [{ requirement: 'adv.beta', severity: 'info' }],
      }),
    ],
    MATRIX,
    ADVISORIES,
  );
  const alpha = report.advisories.rows.find((r) => r.advisory === 'adv.alpha')!;
  assert.deepEqual(alpha.fireCases, ['adv.alpha-fail-rtm', 'adv.alpha-fail-ems']);
  assert.deepEqual(alpha.fireTypes, ['ems', 'rtm']);
  const text = formatCoverage(report).join('\n');
  assert.match(text, /adv\.alpha\[ems,rtm\]/);
  assert.match(text, /adv\.beta\[ems\]/);
});

test('a shadow-profile expectation does not fire a contract advisory', () => {
  // One transmission carries findings of both lineages (by1c.6). An `info` graded
  // against the unpublished DS01.3 draft is a statement about that draft, and the
  // advisory catalogue it would be credited to belongs to the contract — so the
  // expectation must not count, exactly as it does not count for a §7 row.
  const report = computeCoverage(
    [
      advKase({
        id: 'adv.alpha-fail-shadow-only',
        expectedFindings: [{ requirement: 'adv.alpha', severity: 'info', profile: 'ds013' }],
      }),
    ],
    MATRIX,
    ADVISORIES,
  );
  assert.equal(report.advisories.rows.find((r) => r.advisory === 'adv.alpha')!.fired, false);
  assert.deepEqual(report.advisories.fired, []);
});

test('only an info expectation fires an advisory', () => {
  // `advisory()` builds `severity: 'info'` and can build nothing else, so an
  // expectation naming another severity is not an advisory expectation at all.
  const report = computeCoverage(
    [
      advKase({
        id: 'adv.alpha-fail-wrong-severity',
        expectedFindings: [{ requirement: 'adv.alpha', severity: 'fail' }],
      }),
    ],
    MATRIX,
    ADVISORIES,
  );
  assert.deepEqual(report.advisories.fired, []);
});

test('an advisory expectation is not coverage of a requirement', () => {
  // The two joins stay independent: an `adv.*` case claims no matrix row, and the
  // §3.2 pass it incidentally observes is scaffolding, not an exercise of §3.2.
  const report = computeCoverage(
    [
      advKase({
        id: 'adv.alpha-fail-thing',
        expectedFindings: [
          { requirement: 'adv.alpha', severity: 'info' },
          { requirement: '3.2', severity: 'pass' },
        ],
      }),
    ],
    MATRIX,
    ADVISORIES,
  );
  assert.equal(report.rows.find((r) => r.requirement === '3.2')!.status, 'uncovered');
  assert.deepEqual(report.unknownClaims, []);
});

// ── the real table ──────────────────────────────────────────────────────────

test('every row of the real matrix is classified exactly once', () => {
  const report = computeCoverage(EXERCISE_CASES);
  assert.equal(report.rows.length, COMPLIANCE_MATRIX.length);
  assert.equal(
    report.covered.length + report.partial.length + report.uncovered.length,
    report.gradeable.length,
  );
  assert.equal(report.gradeable.length + report.byDesign.length, report.rows.length);
});

test('the shipped case table claims no requirement the matrix lacks', () => {
  assert.deepEqual(computeCoverage(EXERCISE_CASES).unknownClaims, []);
});

test('every gradeable requirement is exercised in BOTH directions (8qa.5)', () => {
  // The epic's acceptance criterion, stated as a computed fact rather than as a
  // checklist someone maintains: with 8qa.5's sequence cases landed there is no
  // gradeable matrix row left without a pass case AND a fail case.
  //
  // The last holdout was §2.1, which needs POSTs genuinely IN FLIGHT at once —
  // now expressible as `delivery: 'concurrent'` (../case.ts, ./run.ts).
  //
  // A row that becomes gradeable later (its primary class flipping to
  // verified|heuristic in COMPLIANCE_MATRIX) lands here as a failure with its own
  // id named, which is the point: the gap surfaces in CI rather than as a quiet
  // line in the runner's report.
  const report = computeCoverage(EXERCISE_CASES);
  const describe = (rows: typeof report.partial) =>
    rows.map((r) => `§${r.requirement} (${r.summary})`).join(', ');
  assert.deepEqual(
    report.partial,
    [],
    `exercised in one direction only: ${describe(report.partial)}`,
  );
  assert.deepEqual(report.uncovered, [], `no exercise at all: ${describe(report.uncovered)}`);
  assert.equal(report.covered.length, report.gradeable.length);
});

test('the printed report never states coverage without saying for which payload type', () => {
  // THE ANTI-SILENT-CAP INVARIANT (1m8). Direction-only coverage printed
  // "covered (both directions) … 3.2 …" for rows exercised with one payload type,
  // which reads as coverage of the whole schema and is not. Asserted as a
  // property of the OUTPUT rather than as today's type list, so adding EMS cases
  // to another requirement improves the report without failing this test — what
  // must never come back is an unqualified claim.
  const report = computeCoverage(EXERCISE_CASES);
  const text = formatCoverage(report).join('\n');
  for (const row of [...report.covered, ...report.partial]) {
    const annotation = [...new Set([...row.passTypes, ...row.failTypes])].length;
    assert.ok(annotation > 0, `§${row.requirement} is claimed but names no payload type`);
    assert.match(
      text,
      new RegExp(`${row.requirement.replace('.', '\\.')}\\[[^\\]]+\\]`),
      `§${row.requirement} is printed without its payload types`,
    );
  }
  assert.ok(report.payloadTypes.length > 0, 'the header names the types the table sends');
});

test('§3.2 is the requirement exercised with BOTH schema branches (1m8)', () => {
  // The EMS cases all target §3.2, so it is the one row whose pass AND fail sides
  // both reach `ems-report`/`ems-record` as well as the rtmd pair. Pinned because
  // it is the whole reason the type dimension exists: if the EMS group is ever
  // reworked away, this fails rather than the report quietly going rtm-only again.
  const report = computeCoverage(EXERCISE_CASES);
  const row = report.rows.find((r) => r.requirement === '3.2')!;
  assert.deepEqual(row.coveredTypes, ['ems', 'rtm']);
  assert.ok(
    report.gradeable.some((r) => r.requirement !== '3.2' && !r.coveredTypes.includes('ems')),
    'if every gradeable row now covers ems, say so in docs/exercise-suite.md and drop this',
  );
});

test('formatCoverage names every gap it found', () => {
  const text = formatCoverage(computeCoverage(EXERCISE_CASES)).join('\n');
  assert.match(text, /UNCOVERED/);
  for (const row of computeCoverage(EXERCISE_CASES).uncovered) {
    assert.ok(text.includes(`§${row.requirement}`), `gap §${row.requirement} is printed`);
  }
});

test('every registered advisory has a fire case (axdd)', () => {
  // The advisory half of the epic's acceptance criterion, and the reason this
  // join exists: `adv.null_padding` was registered, documented and shipped with
  // no exercise case at all, and nothing said so because coverage only ever
  // looked at `requirements` — which every advisory case leaves empty by design.
  //
  // A NEW advisory added to ADVISORY_CHECKS lands here as a failure naming its
  // own id, which is the point: registering a check without exercising it is now
  // a CI fact rather than a quiet line in the runner's report.
  //
  // This says EXERCISED, not correct. Whether an advisory stays silent on
  // conformant traffic needs a negative expectation the case model cannot yet
  // express; see docs/exercise-suite.md.
  const report = computeCoverage(EXERCISE_CASES);
  assert.equal(report.advisories.rows.length, ADVISORY_IDS.length);
  assert.deepEqual(
    report.advisories.notExercised.map((row) => row.advisory),
    [],
    'registered advisories with no fire case — add one in src/exercise/cases/payload.ts',
  );
  // …and the printed report names the branches, so a fired advisory can never
  // read as exercised on both branches when only one case exists.
  const text = formatCoverage(report).join('\n');
  for (const row of report.advisories.fired) {
    assert.ok(row.fireTypes.length > 0, `${row.advisory} fires but names no payload type`);
    assert.ok(
      text.includes(`${row.advisory}[${row.fireTypes.join(',')}]`),
      `${row.advisory} is printed without its payload types`,
    );
  }
});

// ── the DS01.3 join (tfnv.10) ───────────────────────────────────────────────

const DS013: readonly Ds013MatrixRow[] = [
  {
    clause: '5.1.5',
    summary: 'payload size',
    classes: ['verified'],
    tightened: false,
    members: ['1.4'],
    graded: true,
  },
  {
    clause: '5.3.2',
    summary: 'validates against Annex 4',
    classes: ['verified'],
    tightened: true,
    members: ['3.2'],
    graded: true,
  },
  {
    clause: '5.1.11',
    summary: 'optional pull API',
    classes: ['none'],
    tightened: false,
    members: [],
    graded: false,
  },
];

test('a DS01.3 clause is exercised when a case names it in shadowClauses', () => {
  const report = computeCoverage(
    [
      kase({ id: 'a', shadowClauses: ['5.3.2'] }),
      kase({ id: 'b', shadowClauses: ['5.3.2'], baseline: emsBaseline }),
      kase({ id: 'c' }),
    ],
    MATRIX,
    [],
    DS013,
  );

  assert.deepEqual(
    report.ds013.exercised.map((row) => [row.clause, row.cases, row.types]),
    [['5.3.2', ['a', 'b'], ['ems', 'rtm']]],
  );
  assert.deepEqual(
    report.ds013.notExercised.map((row) => row.clause),
    ['5.1.5', '5.1.11'],
  );
  assert.equal(report.ds013.rows.length, DS013.length);
});

test('a clause a case names that the DS01.3 matrix lacks is reported, not dropped', () => {
  // The same rule as `unknownClaims` on the 2025 side: a claim nobody joins to is
  // indistinguishable from no claim at all, so a retired or mistyped clause id
  // would otherwise vanish.
  const report = computeCoverage([kase({ id: 'a', shadowClauses: ['5.9.9'] })], MATRIX, [], DS013);
  assert.deepEqual(report.ds013.unknownClaims, ['5.9.9']);
});

test('the DS01.3 join says whether an unexercised clause has anything to grade', () => {
  // `graded` travels with the row so the report can distinguish a gap in the case
  // table from a clause the receiving side files no finding under at all — the
  // six DS01.3 clauses with no 2025 member.
  const report = computeCoverage([], MATRIX, [], DS013);
  const informational = report.ds013.rows.find((row) => row.clause === '5.1.11')!;
  assert.equal(informational.graded, false);
  assert.equal(informational.exercised, false);
  assert.equal(report.ds013.rows.find((row) => row.clause === '5.1.5')!.graded, true);
});

test('the shipped case table names no DS01.3 clause the draft matrix lacks', () => {
  const report = computeCoverage(EXERCISE_CASES);
  assert.deepEqual(report.ds013.unknownClaims, []);
  assert.equal(report.ds013.rows.length, DS013_MATRIX.length);
  assert.ok(
    report.ds013.exercised.length > 0,
    'the table still exercises at least one DS01.3 clause',
  );
});

test('the printed report names the DS01.3 clauses it exercises and the ones it does not', () => {
  // The gap this section exists to make visible: with the 2025 joins alone, a
  // DS01.3 clause nothing exercises read exactly like one nine cases exercise.
  const report = computeCoverage(EXERCISE_CASES);
  const text = formatCoverage(report).join('\n');
  assert.match(text, /DS01\.3 rows — \d+ clause\(s\): exercised \d+, not exercised \d+/);
  for (const row of report.ds013.exercised) {
    assert.ok(row.types.length > 0, `${row.clause} is exercised but names no payload type`);
    assert.ok(
      text.includes(`${row.clause}[${row.types.join(',')}]`),
      `${row.clause} is printed without its payload types`,
    );
  }
  for (const row of report.ds013.notExercised) {
    assert.ok(text.includes(row.clause), `unexercised clause ${row.clause} is printed`);
  }
});
