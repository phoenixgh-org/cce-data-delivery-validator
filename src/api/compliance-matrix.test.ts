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
