/**
 * The DS01.3 clause reference table (tfnv.9) — the keys and the two house rules,
 * not the prose.
 *
 * Three things can go wrong here and none of them is a type error. The table can
 * drift from the matrix it serves, and a clause with no entry silently loses its
 * drill-down text; a lookup can shadow the 2025 table if the two key spaces ever
 * overlap; and guidance can acquire a session statistic, which is a lie against
 * real traffic rather than a wording slip (the rationale is in
 * `requirementReference.ts`'s header). Each is asserted below.
 *
 * What is NOT asserted is the clause text itself. It is a transcription of an
 * unpublished draft, so a test restating it would only restate the transcription
 * — the check that matters is the diff against the draft, which a reviewer does
 * by hand when the draft is re-pinned.
 *
 * Pure data on the Node runner: no React shim, like advisories.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DS013_MATRIX } from '../../api/matrix-ds013.js';
import { DS013_REFERENCE, DS013_REFERENCE_SOURCE } from './ds013Reference.js';
import { REQUIREMENT_REFERENCE, getRequirementReference } from './requirementReference.js';

test('every DS01.3 matrix row has an entry, and the table has nothing else', () => {
  const matrix = DS013_MATRIX.map((row) => row.clause).sort();
  const table = Object.keys(DS013_REFERENCE).sort();
  assert.deepEqual(table, matrix);
  assert.equal(table.length, 27);
});

test('every entry carries clause text and guidance', () => {
  for (const [clause, ref] of Object.entries(DS013_REFERENCE)) {
    // No allowed empties: the 29-Jul-2026 draft supplies text for all 27 rows.
    // A clause whose numbering could not be settled would be listed here with
    // its bd note, per tfnv.9's stop rule; none is.
    assert.ok(ref.text.trim().length > 0, `${clause} has no clause text`);
    assert.ok(ref.guidance.trim().length > 0, `${clause} has no guidance`);
  }
});

test('guidance carries no session statistics', () => {
  // The prototype's lies, by shape: "4 of your transmissions omitted charset",
  // "5 transmissions failed validation", "every request authenticated".
  const statistics = [/\d+\s+of\s+your\b/i, /\b\d+\s+transmissions?\b/i, /\bevery request\b/i];
  for (const [clause, ref] of Object.entries(DS013_REFERENCE)) {
    for (const pattern of statistics) {
      assert.ok(!pattern.test(ref.guidance), `${clause} guidance reads as a session statistic`);
    }
  }
});

test('the two key spaces never collide', () => {
  const contract = new Set(Object.keys(REQUIREMENT_REFERENCE));
  for (const clause of Object.keys(DS013_REFERENCE)) {
    assert.ok(!contract.has(clause), `${clause} is claimed by both tables`);
  }
});

test('a lookup reaches either table, and the 2025 entry still wins its own id', () => {
  const draft = getRequirementReference('5.3.2');
  assert.equal(draft, DS013_REFERENCE['5.3.2']);
  assert.ok(draft !== undefined && draft.text.includes('Annex 4'));

  const contract = getRequirementReference('3.2');
  assert.equal(contract, REQUIREMENT_REFERENCE['3.2']);
  assert.ok(contract !== undefined && contract.text.includes('Attachment 1'));

  assert.equal(getRequirementReference('9.9'), undefined);
});

test('the source header names the draft revision it was transcribed from', () => {
  assert.equal(DS013_REFERENCE_SOURCE.revision, '29-Jul-2026');
  assert.match(DS013_REFERENCE_SOURCE.note, /unpublished|preview/i);
  assert.match(DS013_REFERENCE_SOURCE.note, /DS01\.3/);
});
