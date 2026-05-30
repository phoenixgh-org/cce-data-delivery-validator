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
