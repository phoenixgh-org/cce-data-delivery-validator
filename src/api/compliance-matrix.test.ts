import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPLIANCE_MATRIX,
  computeComplianceSummary,
  type ComplianceRow,
  type OutdatedCountsByRequirement,
  type SeverityCountsByRequirement,
} from './compliance-matrix.js';
import { foldUnderLens, lensMatrix, type LensFinding } from './lens.js';
import type { Profile } from '../schema-registry.js';

/** Find the computed row for a requirement id (asserts it exists). */
function row(rows: ComplianceRow[], requirement: string): ComplianceRow {
  const found = rows.find((r) => r.requirement === requirement);
  assert.ok(found, `expected a row for requirement ${requirement}`);
  return found;
}

test('gradeable ✅ row with pass-only counts → pass', () => {
  // 1.4 is a ✅ (verified) gradeable row.
  const rows = computeComplianceSummary({ '1.4': { pass: 3, fail: 0, info: 1 } });
  assert.equal(row(rows, '1.4').status, 'pass');
});

test('gradeable row with a fail (no pass) → fail', () => {
  const rows = computeComplianceSummary({ '1.4': { pass: 0, fail: 2, info: 0 } });
  assert.equal(row(rows, '1.4').status, 'fail');
});

test('gradeable row with both pass and fail → mixed', () => {
  const rows = computeComplianceSummary({ '1.4': { pass: 1, fail: 1, info: 0 } });
  assert.equal(row(rows, '1.4').status, 'mixed');
});

test('🔌 active-only row → not-exercised regardless of counts', () => {
  // 4.1 is 🔌; even with nonzero counts it stays deferred.
  const rows = computeComplianceSummary({ '4.1': { pass: 5, fail: 2, info: 9 } });
  assert.equal(row(rows, '4.1').status, 'not-exercised');
});

test('📝 attestation row → self-attestation', () => {
  // 4.6 is 📝.
  const rows = computeComplianceSummary({ '4.6': { pass: 1, fail: 1, info: 0 } });
  assert.equal(row(rows, '4.6').status, 'self-attestation');
});

test('ungraded ✅ row with zero findings → untested (not a false pass)', () => {
  const rows = computeComplianceSummary({});
  assert.equal(row(rows, '1.4').status, 'untested');
});

/* ── the `outdated` modifier (2kx) ───────────────────────────────────────────
 * §3.2 records a transmission that validated cleanly against a registered-but-
 * OLDER schema version as severity=info + outdated=true, with NO pass finding
 * (bd memory schema-registry-0.8.1-current-outdated — info, not pass, is
 * deliberate). Counting only pass/fail therefore called such a session
 * "untested", claiming we never checked. These cases pin the fix: the outdated
 * tally is its own input, never a severity, and yields `pass-outdated`.
 *
 * These stay FIXTURE-driven even though a live outdated cohort now exists (0.8.0
 * is registered alongside 0.8.1, bd 8qa.4): what is under test here is
 * `computeComplianceSummary`'s arithmetic over counts, so feeding it counts
 * directly is the honest unit. The end-to-end path from a real 0.8.0 POST to
 * these tallies is covered by src/ingest/stages/schema-stage.test.ts and the
 * live exercise case '3.2-pass-outdated-schema-version'. */

test('2kx: §3.2 with ONLY outdated validations → pass-outdated, never untested', () => {
  // The shape the schema stage actually writes: one info per tx, no pass.
  const rows = computeComplianceSummary({ '3.2': { pass: 0, fail: 0, info: 3 } }, { '3.2': 3 });
  const r = row(rows, '3.2');
  assert.notEqual(r.status, 'untested', 'we DID check — claiming otherwise is the bug');
  assert.equal(r.status, 'pass-outdated');
  assert.equal(r.outdated, 3, 'the evidence behind the status travels with the row');
});

test('2kx: current-version passes only → plain pass, outdated 0', () => {
  const rows = computeComplianceSummary({ '3.2': { pass: 4, fail: 0, info: 0 } }, {});
  const r = row(rows, '3.2');
  assert.equal(r.status, 'pass');
  assert.equal(r.outdated, 0);
});

test('2kx: MIXED current + outdated passes → pass-outdated (the amber verdict wins)', () => {
  // Still transmitting on an older version somewhere, so the row must not read
  // as a clean pass.
  const rows = computeComplianceSummary({ '3.2': { pass: 4, fail: 0, info: 2 } }, { '3.2': 2 });
  assert.equal(row(rows, '3.2').status, 'pass-outdated');
});

test('2kx: a fail dominates the outdated modifier (fail / mixed unchanged)', () => {
  const failOnly = computeComplianceSummary({ '3.2': { pass: 0, fail: 2, info: 1 } }, { '3.2': 1 });
  assert.equal(row(failOnly, '3.2').status, 'fail', 'an outdated pass never softens a failure');

  const withPass = computeComplianceSummary({ '3.2': { pass: 1, fail: 2, info: 1 } }, { '3.2': 1 });
  assert.equal(row(withPass, '3.2').status, 'mixed');
});

test('2kx: no findings at all is STILL untested (outdated is not a false pass)', () => {
  const rows = computeComplianceSummary({}, {});
  const r = row(rows, '3.2');
  assert.equal(r.status, 'untested');
  assert.equal(r.outdated, 0);
});

test('2kx: outdated on a non-gradeable row does not disturb its status', () => {
  // 4.6 is 📝 self-attestation; nothing derived from traffic applies.
  const rows = computeComplianceSummary({ '4.6': { pass: 0, fail: 0, info: 1 } }, { '4.6': 1 });
  assert.equal(row(rows, '4.6').status, 'self-attestation');
});

test('2kx: omitting the outdated map reproduces the pre-fix statuses exactly', () => {
  const rows = computeComplianceSummary({ '3.2': { pass: 2, fail: 0, info: 5 } });
  assert.equal(row(rows, '3.2').status, 'pass');
  assert.equal(row(rows, '3.2').outdated, 0);
});

test('split-class 1.1 grades on the verified side; 4.4 on the active-only side', () => {
  const passOnly = computeComplianceSummary({ '1.1': { pass: 2, fail: 0, info: 0 } });
  assert.deepEqual(row(passOnly, '1.1').classes, ['verified', 'enforced']);
  assert.equal(row(passOnly, '1.1').status, 'pass');

  const r44 = computeComplianceSummary({ '4.4': { pass: 9, fail: 0, info: 0 } });
  assert.deepEqual(row(r44, '4.4').classes, ['active-only', 'attestation']);
  assert.equal(row(r44, '4.4').status, 'not-exercised');
});

test('1.7 (—) → not-applicable', () => {
  const rows = computeComplianceSummary({});
  assert.equal(row(rows, '1.7').status, 'not-applicable');
});

test('all 27 §7 requirements are present in the output', () => {
  const expected = [
    '1.1',
    '1.2',
    '1.3',
    '1.4',
    '1.5',
    '1.6',
    '1.7',
    '1.8',
    '2.1',
    '2.2',
    '2.3',
    '3.1',
    '3.2',
    '3.3',
    '3.4',
    '4.1',
    '4.2',
    '4.3',
    '4.4',
    '4.5',
    '4.6',
    '4.7',
    '4.8',
    '4.9',
    '5.1',
    '5.2',
    '5.3',
  ];
  assert.equal(COMPLIANCE_MATRIX.length, 27);

  const rows = computeComplianceSummary({});
  assert.equal(rows.length, 27);
  const ids = new Set(rows.map((r) => r.requirement));
  for (const id of expected) {
    assert.ok(ids.has(id), `missing requirement ${id}`);
  }
  assert.equal(ids.size, 27, 'no duplicate requirement ids');
});

/* ── THE SAFETY PIN: advisory ids cannot touch the §7 matrix (pwd / bva) ──────
 *
 * Advisories (src/ingest/stages/semantic/advisory.ts) are observations, not
 * verdicts: schema-compliant AND requirement-compliant practices worth telling a
 * supplier about. pwd's governing constraint is that an advisory must NEVER
 * change a requirement's pass/fail status — a supplier sitting at 100%
 * conformant must still be able to carry advisories, or the grade stops being an
 * independent read on conformance.
 *
 * That is guaranteed BY CONSTRUCTION rather than by a filter anyone could
 * forget: `computeComplianceSummary` is `COMPLIANCE_MATRIX.map(...)` over the 27
 * STATIC rows, so a finding whose requirement id is not one of the 27 is never
 * looked up at all. Advisory ids live in their own `adv.*` namespace, so they
 * cannot collide with a §7 id and cannot create a phantom row.
 *
 * THESE TESTS EXIST BECAUSE THAT GUARANTEE IS INVISIBLE IN THE CODE. Rewriting
 * the join to iterate `countsByRequirement` instead (a natural-looking
 * "optimization") would still pass every other test in this file while silently
 * turning house opinion into a compliance verdict. If one of these fails, the
 * bug is the join, not the test.
 *
 * Deliberately extreme inputs: the advisory entries below carry `fail` and
 * `pass` counts and an `outdated` tally too. Advisories only ever emit
 * `severity: 'info'` with `outdated` false, so those numbers cannot occur —
 * which is the point. The matrix must be immune to ANY finding filed under an
 * unknown id, not merely to well-behaved ones. */

/** A representative advisory-shaped slice of `countsByRequirement`. */
const ADVISORY_COUNTS = {
  'adv.null_identity': { pass: 0, fail: 0, info: 7 },
  'adv.null_padding': { pass: 0, fail: 0, info: 480 },
  // Hostile, impossible-in-practice entries — see the note above.
  'adv.hypothetical': { pass: 3, fail: 9, info: 2 },
};

/** Live counts for every gradeable §7 row, i.e. a fully conformant supplier. */
const ALL_PASSING = {
  '1.1': { pass: 5, fail: 0, info: 0 },
  '1.2': { pass: 5, fail: 0, info: 0 },
  '1.3': { pass: 5, fail: 0, info: 0 },
  '1.4': { pass: 5, fail: 0, info: 0 },
  '1.6': { pass: 5, fail: 0, info: 0 },
  '1.8': { pass: 5, fail: 0, info: 0 },
  '2.1': { pass: 5, fail: 0, info: 0 },
  '3.1': { pass: 5, fail: 0, info: 0 },
  '3.2': { pass: 5, fail: 0, info: 0 },
  '3.4': { pass: 5, fail: 0, info: 0 },
};

test('PIN: advisory ids never create a matrix row', () => {
  const rows = computeComplianceSummary(ADVISORY_COUNTS, { 'adv.null_padding': 480 });
  assert.equal(rows.length, 27, 'still exactly the 27 static §7 rows');
  assert.equal(
    rows.filter((r) => r.requirement.startsWith('adv.')).length,
    0,
    'no phantom row for an advisory id',
  );
});

test('PIN: the whole matrix is byte-identical with and without advisories', () => {
  const without = computeComplianceSummary(ALL_PASSING, {});
  const withAdvisories = computeComplianceSummary(
    { ...ALL_PASSING, ...ADVISORY_COUNTS },
    { 'adv.null_padding': 480 },
  );
  // deepEqual over the FULL row objects — counts, outdated tallies and derived
  // status alike, not just the statuses.
  assert.deepEqual(withAdvisories, without);
});

test('PIN: every requirement keeps its pass/fail status when advisories arrive', () => {
  const statusMap = (rows: ComplianceRow[]) =>
    Object.fromEntries(rows.map((r) => [r.requirement, r.status]));

  // Across a realistic spread of outcomes: passing, failing, mixed, untested,
  // pass-outdated, and each of the non-gradeable classes.
  const base = {
    ...ALL_PASSING,
    '2.1': { pass: 1, fail: 4, info: 0 }, // fail
    '1.8': { pass: 2, fail: 2, info: 0 }, // mixed
    '3.2': { pass: 0, fail: 0, info: 3 }, // pass-outdated (with the map below)
    '4.1': { pass: 1, fail: 1, info: 1 }, // 🔌 not-exercised
    '4.6': { pass: 1, fail: 0, info: 0 }, // 📝 self-attestation
    // 1.7 (—) and 3.3 (📝) deliberately left absent → untested/n-a paths.
  };
  const outdated = { '3.2': 3 };

  const before = statusMap(computeComplianceSummary(base, outdated));
  const after = statusMap(
    computeComplianceSummary(
      { ...base, ...ADVISORY_COUNTS },
      { ...outdated, 'adv.null_padding': 480 },
    ),
  );

  assert.deepEqual(after, before, 'advisories moved a requirement status');
  // Guard the guard: the fixture must actually exercise several statuses, or the
  // deepEqual above would be pinning a trivially uniform map.
  assert.ok(new Set(Object.values(before)).size >= 5, 'fixture covers ≥5 distinct statuses');
});

test('PIN: a 100%-conformant supplier stays 100% conformant while carrying advisories', () => {
  // The acceptance sentence from pwd, asserted directly on the gradeable rows.
  const gradeable = (rows: ComplianceRow[]) =>
    rows.filter((r) => r.classes[0] === 'verified' || r.classes[0] === 'heuristic');

  const clean = gradeable(computeComplianceSummary(ALL_PASSING, {}));
  assert.equal(clean.length, 10, 'ten gradeable §7 rows');
  assert.ok(
    clean.every((r) => r.status === 'pass'),
    'fixture really is 100% conformant',
  );

  const advised = gradeable(
    computeComplianceSummary({ ...ALL_PASSING, ...ADVISORY_COUNTS }, { 'adv.null_padding': 480 }),
  );
  assert.ok(
    advised.every((r) => r.status === 'pass'),
    'advisories must never cost a supplier a green row',
  );
});

/* ── the row's two units and its third state (vsy1, f2bl) ────────────────────
 *
 * A row's headline tally counts DISTINCT TRANSMISSIONS; the finding tally rides
 * beside it under `findings`; and `notReached` names the scoped transmissions
 * that produced no finding on the row at all. What these cases protect:
 *
 *   1. GRADING DOES NOT MOVE. The unit change is presentation. Every status is
 *      asserted against the status the SAME session produced under the old
 *      per-finding unit, recomputed here by `foldByFinding` rather than copied
 *      from a snapshot — so the pin cannot rot into agreeing with itself.
 *   2. NO ROW OUTRUNS THE SCOPE (f2bl). The defect f2bl records is a clause
 *      reporting 142 passes over 76 transmissions; the invariant that forbids it
 *      is asserted over every row of both packages.
 *   3. THE REMAINDER IS THE CALLER'S. `notReached` is 0 until a scoped total is
 *      supplied, because nothing in a finding set says how many transmissions
 *      never produced one.
 */

const CONTRACT_LENS: Profile = '2025';
const DRAFT_LENS: Profile = 'ds013';

/**
 * Seven transmissions exercising every way the two units diverge: a clause
 * collapse (1.1 + 1.2 → 5.1.3) on three bodies, a schema fan-out on one body in
 * each lineage, a transport halt, an outdated-but-valid body, and one body that
 * produced no finding at all — the not-reached case, which no fold can see.
 */
const SESSION: readonly LensFinding[] = [
  // tx-1 — clean under both members of the collapsed clause.
  {
    transmissionId: 'tx-1',
    requirement: '1.1',
    severity: 'pass',
    profile: '2025',
    outdated: false,
  },
  {
    transmissionId: 'tx-1',
    requirement: '1.2',
    severity: 'pass',
    profile: '2025',
    outdated: false,
  },
  {
    transmissionId: 'tx-1',
    requirement: '3.2',
    severity: 'pass',
    profile: '2025',
    outdated: false,
  },
  // tx-2 — clean on the clause, rejected by Annex 4 on five logger properties.
  {
    transmissionId: 'tx-2',
    requirement: '1.1',
    severity: 'pass',
    profile: '2025',
    outdated: false,
  },
  {
    transmissionId: 'tx-2',
    requirement: '1.2',
    severity: 'pass',
    profile: '2025',
    outdated: false,
  },
  ...['LDOP', 'LMFR', 'LPQS', 'LMOD', 'LSER'].map(
    (property): LensFinding => ({
      transmissionId: 'tx-2',
      requirement: '5.3.2',
      severity: 'fail',
      profile: 'ds013',
      outdated: false,
      code: `required:${property}`,
    }),
  ),
  // tx-3 — fails BOTH members of the collapsed clause: one failing transmission.
  {
    transmissionId: 'tx-3',
    requirement: '1.1',
    severity: 'fail',
    profile: '2025',
    outdated: false,
  },
  {
    transmissionId: 'tx-3',
    requirement: '1.2',
    severity: 'fail',
    profile: '2025',
    outdated: false,
  },
  // tx-4 — a transport halt, which the clause map carries onto 5.1.5.
  {
    transmissionId: 'tx-4',
    requirement: '1.4',
    severity: 'fail',
    profile: '2025',
    outdated: false,
  },
  // tx-5 — nothing at all: rejected at the door, and invisible to the fold.
  // tx-6 — valid against a registered-but-older version (2kx).
  { transmissionId: 'tx-6', requirement: '1.8', severity: 'info', profile: '2025', outdated: true },
  // tx-7 — the same fan-out on the CONTRACT side, so the two units diverge under
  // the contract lens too and the pin below is not a draft-only assertion. §3.2 is
  // not carried onto a DS01.3 clause, so these findings are dropped under the
  // draft lens — which is itself the rule tfnv locked.
  ...['ABST', 'TVC', 'CMPR'].map(
    (object): LensFinding => ({
      transmissionId: 'tx-7',
      requirement: '3.2',
      severity: 'fail',
      profile: '2025',
      outdated: false,
      code: `required:${object}`,
    }),
  ),
];

/** How many transmissions the scope above holds — tx-5 included, findings or not. */
const SCOPED = 7;

/** The PRE-vsy1 fold: one increment per finding, one per outdated flag. */
function foldByFinding(
  findings: readonly LensFinding[],
  lens: Profile,
): { counts: SeverityCountsByRequirement; outdated: OutdatedCountsByRequirement } {
  const counts: SeverityCountsByRequirement = {};
  const outdated: OutdatedCountsByRequirement = {};
  // The ROUTING is not what changed, so it is borrowed from the fold under test
  // rather than re-implemented: one finding at a time, the new fold's row tally
  // is 1 exactly on the row the old one would have incremented.
  for (const f of findings) {
    const { counts: single } = foldUnderLens([f], lens, CONTRACT_LENS);
    const row = Object.keys(single)[0];
    if (row === undefined) continue;
    const bucket = (counts[row] ??= { pass: 0, fail: 0, info: 0 });
    bucket[f.severity] += 1;
    if (f.outdated) outdated[row] = (outdated[row] ?? 0) + 1;
  }
  return { counts, outdated };
}

const statusMapOf = (rows: ComplianceRow[]) =>
  Object.fromEntries(rows.map((r) => [r.requirement, r.status]));

test('PIN: no row’s status moves when the tally changes unit (vsy1)', () => {
  for (const lens of [CONTRACT_LENS, DRAFT_LENS]) {
    const matrix = lensMatrix(lens, CONTRACT_LENS);
    const folded = foldUnderLens(SESSION, lens, CONTRACT_LENS);

    const after = computeComplianceSummary(folded.counts, folded.outdated, matrix, {
      findings: folded.findings,
      reached: folded.reached,
      scopedTotal: SCOPED,
    });

    const old = foldByFinding(SESSION, lens);
    const before = computeComplianceSummary(old.counts, old.outdated, matrix);

    assert.deepEqual(
      statusMapOf(after as ComplianceRow[]),
      statusMapOf(before as ComplianceRow[]),
      `${lens}: the unit change moved a status — the change is wrong, not the expectation`,
    );
    // Guard the guard: a fixture that produced one status everywhere would make
    // the equality above vacuous.
    assert.ok(
      new Set(Object.values(statusMapOf(after as ComplianceRow[]))).size >= 5,
      `${lens}: fixture covers ≥5 distinct statuses`,
    );
    // And the two units really did diverge on this fixture, or nothing was tested.
    assert.notDeepEqual(folded.counts, old.counts, `${lens}: the fixture separates the units`);
  }
});

test('PIN: no row reports more transmissions than the scope holds (f2bl)', () => {
  for (const lens of [CONTRACT_LENS, DRAFT_LENS]) {
    const folded = foldUnderLens(SESSION, lens, CONTRACT_LENS);
    const rows = computeComplianceSummary(
      folded.counts,
      folded.outdated,
      lensMatrix(lens, CONTRACT_LENS),
      { findings: folded.findings, reached: folded.reached, scopedTotal: SCOPED },
    );
    for (const r of rows) {
      for (const sev of ['pass', 'fail', 'info'] as const) {
        assert.ok(r.counts[sev] <= SCOPED, `${lens} ${r.requirement}: ${sev} exceeds the scope`);
      }
      assert.ok(r.outdated <= SCOPED, `${lens} ${r.requirement}: outdated exceeds the scope`);
      assert.ok(r.notReached >= 0 && r.notReached <= SCOPED, `${lens} ${r.requirement}: remainder`);
    }
  }
});

test('the collapsed clause 5.1.3 reads in transmissions, with its findings beside it', () => {
  // f2bl's worked case: three bodies touch the clause, each through BOTH members.
  // The old fold reported six passes and two fails on a session of six.
  const folded = foldUnderLens(SESSION, DRAFT_LENS, CONTRACT_LENS);
  const rows = computeComplianceSummary(
    folded.counts,
    folded.outdated,
    lensMatrix(DRAFT_LENS, CONTRACT_LENS),
    { findings: folded.findings, reached: folded.reached, scopedTotal: SCOPED },
  );
  const clause = row(rows as ComplianceRow[], '5.1.3');

  assert.deepEqual(clause.counts, { pass: 2, fail: 1, info: 0 }, 'tx-1 and tx-2 pass, tx-3 fails');
  assert.deepEqual(clause.findings, { pass: 4, fail: 2, info: 0 }, 'six findings behind them');
  assert.equal(clause.notReached, 4, 'tx-4 through tx-7 never reached the clause');
  assert.equal(clause.status, 'mixed', 'and the verdict is the one the old unit gave');

  // The fan-out row, the other way the units diverge.
  const annex4 = row(rows as ComplianceRow[], '5.3.2');
  assert.deepEqual(annex4.counts, { pass: 0, fail: 1, info: 0 }, 'one rejected body');
  assert.deepEqual(annex4.findings, { pass: 0, fail: 5, info: 0 }, 'five Ajv errors on it');
  assert.equal(annex4.notReached, 6);
});

test('the remainder is 0 until a caller supplies a scoped total', () => {
  const folded = foldUnderLens(SESSION, CONTRACT_LENS, CONTRACT_LENS);
  const rows = computeComplianceSummary(folded.counts, folded.outdated, COMPLIANCE_MATRIX, {
    findings: folded.findings,
    reached: folded.reached,
  });
  assert.ok(
    rows.every((r) => r.notReached === 0),
    'a fold over findings alone cannot see a transmission that produced none',
  );
});

test('omitting the evidence entirely reproduces the pre-vsy1 row', () => {
  const counts = { '1.4': { pass: 3, fail: 1, info: 0 } };
  const [only] = computeComplianceSummary(counts, {}, [
    { requirement: '1.4', summary: 'x', classes: ['verified'] },
  ]);
  assert.deepEqual(only?.counts, { pass: 3, fail: 1, info: 0 });
  assert.deepEqual(only?.findings, { pass: 3, fail: 1, info: 0 }, 'both tallies, one input');
  assert.equal(only?.notReached, 0);
  assert.equal(only?.status, 'mixed');
});
