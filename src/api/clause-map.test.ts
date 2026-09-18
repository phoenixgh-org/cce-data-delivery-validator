import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPLIANCE_MATRIX } from './compliance-matrix.js';
import { DS013_TITLE, FORWARD, NEW_IN_DS013, TIGHTENED, forwardClause } from './clause-map.js';

test('every matrix requirement has a forward mapping', () => {
  // The join that keeps the map honest: adding a matrix row without a DS01.3
  // clause fails here rather than silently dropping the "· also 5.x.x" suffix.
  for (const row of COMPLIANCE_MATRIX) {
    assert.ok(
      forwardClause(row.requirement),
      `requirement ${row.requirement} has no FORWARD entry`,
    );
  }
});

test('FORWARD carries no ids the matrix does not have', () => {
  const matrixIds = new Set(COMPLIANCE_MATRIX.map((r) => r.requirement));
  for (const req of Object.keys(FORWARD)) {
    assert.ok(matrixIds.has(req), `FORWARD has ${req}, which is not a matrix requirement`);
  }
});

test('TIGHTENED is a subset of the FORWARD keys', () => {
  for (const req of TIGHTENED) {
    assert.ok(req in FORWARD, `TIGHTENED has ${req}, which is not a FORWARD key`);
  }
});

test('NEW_IN_DS013 clauses are not reachable through FORWARD', () => {
  // A clause with a 2025 equivalent is by definition not new in DS01.3.
  const mapped = new Set(Object.values(FORWARD));
  for (const clause of NEW_IN_DS013) {
    assert.ok(!mapped.has(clause), `${clause} is both a FORWARD value and NEW_IN_DS013`);
  }
});

test('every reachable DS01.3 clause has a title', () => {
  for (const clause of [...Object.values(FORWARD), ...NEW_IN_DS013]) {
    assert.ok(DS013_TITLE[clause], `no DS013_TITLE for ${clause}`);
  }
});

test('forwardClause returns null for an advisory id', () => {
  assert.equal(forwardClause('adv.date_format'), null);
});

test('forwardClause returns null for an unknown id', () => {
  assert.equal(forwardClause('9.9'), null);
  assert.equal(forwardClause(''), null);
  // Not fooled by inherited Object properties.
  assert.equal(forwardClause('toString'), null);
});

test('forwardClause returns the mapped clause', () => {
  assert.equal(forwardClause('3.2'), '5.3.2');
  assert.equal(forwardClause('1.8'), '5.1.9');
});
