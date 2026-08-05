import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPLIANCE_MATRIX,
  computeComplianceSummary,
  type ComplianceRow,
} from './compliance-matrix.js';

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
