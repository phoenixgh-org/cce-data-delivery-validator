import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DS013_TITLE, FORWARD, NEW_IN_DS013, TIGHTENED } from './clause-map.js';
import { COMPLIANCE_MATRIX } from './compliance-matrix.js';
import { DS013_MATRIX, type Ds013MatrixRow } from './matrix-ds013.js';

function row(clause: string): Ds013MatrixRow {
  const found = DS013_MATRIX.find((r) => r.clause === clause);
  assert.ok(found, `no DS01.3 row for ${clause}`);
  return found;
}

test('the matrix is 21 graded clauses plus 6 informational ones', () => {
  assert.equal(DS013_MATRIX.length, 27);
  assert.equal(DS013_MATRIX.filter((r) => r.graded).length, 21);
  assert.equal(DS013_MATRIX.filter((r) => !r.graded).length, 6);
});

test('every FORWARD value appears exactly once, as a graded row', () => {
  // The join that keeps the derivation honest: re-pointing a 2025 requirement at
  // a clause the matrix does not carry fails here.
  const graded = DS013_MATRIX.filter((r) => r.graded).map((r) => r.clause);
  assert.deepEqual([...graded].sort(), [...new Set(Object.values(FORWARD))].sort());
  assert.equal(new Set(graded).size, graded.length);
});

test('every NEW_IN_DS013 clause appears exactly once, as an ungraded row', () => {
  const informational = DS013_MATRIX.filter((r) => !r.graded).map((r) => r.clause);
  assert.deepEqual([...informational].sort(), [...NEW_IN_DS013].sort());
  for (const clause of NEW_IN_DS013) {
    const r = row(clause);
    assert.deepEqual(r.members, [], `${clause} has no 2025 equivalent, so it has no members`);
    assert.equal(
      r.tightened,
      false,
      `${clause} has no 2025 equivalent, so it cannot have tightened`,
    );
    assert.equal(r.classes.length, 1, `${clause} carries exactly one decided class`);
  }
});

test('every 2025 matrix requirement is a member of exactly one DS01.3 row', () => {
  const seen = new Map<string, string>();
  for (const r of DS013_MATRIX) {
    for (const member of r.members) {
      const already = seen.get(member);
      assert.equal(already, undefined, `${member} is a member of both ${already} and ${r.clause}`);
      seen.set(member, r.clause);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), COMPLIANCE_MATRIX.map((m) => m.requirement).sort());
});

test('every row has a title from DS013_TITLE', () => {
  for (const r of DS013_MATRIX) {
    assert.equal(r.summary, DS013_TITLE[r.clause], `${r.clause} does not carry its title`);
    assert.ok(r.summary, `no DS013_TITLE for ${r.clause}`);
  }
});

test('rows are in DS01.3 document order, numerically by segment', () => {
  const clauses = DS013_MATRIX.map((r) => r.clause);
  // 5.1.9 before 5.1.10: a plain string sort would get this wrong.
  assert.ok(clauses.indexOf('5.1.9') < clauses.indexOf('5.1.10'));
  assert.equal(clauses[0], '5.1.1');
  assert.equal(clauses[clauses.length - 1], '5.4.7');
  const sorted = [...clauses].sort((a, b) => {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  assert.deepEqual(clauses, sorted);
});

test('members are the 2025 ids in document order', () => {
  assert.deepEqual(row('5.1.3').members, ['1.1', '1.2']);
  assert.deepEqual(row('5.4.1').members, ['4.1', '4.2', '4.3']);
  assert.deepEqual(row('5.4.2').members, ['4.4', '4.5']);
  assert.deepEqual(row('5.4.4').members, ['5.1', '5.2', '5.3']);
  assert.deepEqual(row('5.1.6').members, ['1.4']);
});

test('tightened rows are exactly what TIGHTENED maps forward to', () => {
  const expected = [...TIGHTENED].map((req) => FORWARD[req]).sort();
  const actual = DS013_MATRIX.filter((r) => r.tightened)
    .map((r) => r.clause)
    .sort();
  assert.deepEqual(actual, expected);
  // Pinned so a silent edit to either source shows up here: 1.8 → 5.1.10,
  // 3.1 → 5.3.3, 3.2 → 5.3.2, 4.3 → 5.4.1.
  assert.deepEqual(actual, ['5.1.10', '5.3.2', '5.3.3', '5.4.1']);
});

test('a merged clause inherits the union of its member classes', () => {
  // 1.1 is ['verified', 'enforced'] and 1.2 is ['verified']; the union keeps
  // first-seen order, so the primary class stays verified.
  assert.deepEqual(row('5.1.3').classes, ['verified', 'enforced']);
  assert.equal(row('5.1.3').classes[0], 'verified');
  // 4.4 is ['active-only', 'attestation'] and 4.5 is ['active-only'].
  assert.deepEqual(row('5.4.2').classes, ['active-only', 'attestation']);
  // Members that all carry the same single class collapse to that one class.
  assert.deepEqual(row('5.4.1').classes, ['active-only']);
  assert.deepEqual(row('5.4.4').classes, ['active-only']);
});

test('an unmerged clause carries its single member classes unchanged', () => {
  for (const r of DS013_MATRIX) {
    if (r.members.length !== 1) continue;
    const source = COMPLIANCE_MATRIX.find((m) => m.requirement === r.members[0]);
    assert.ok(source);
    assert.deepEqual(
      r.classes,
      source.classes,
      `${r.clause} changed ${source.requirement}'s class`,
    );
  }
});

test('the new clauses carry the decided classes', () => {
  // DECIDED 2026-09-17: the "New in DS01.3" group is not uniformly ungradeable.
  assert.deepEqual(row('5.1.1').classes, ['attestation']);
  assert.deepEqual(row('5.1.2').classes, ['enforced']);
  assert.deepEqual(row('5.1.11').classes, ['attestation']);
  assert.deepEqual(row('5.1.12').classes, ['none']);
  assert.deepEqual(row('5.3.1').classes, ['attestation']);
  assert.deepEqual(row('5.3.5').classes, ['verified']);
});
