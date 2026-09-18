/**
 * The grading lens (tfnv.4) — parsing, the fold, and the matrix it folds onto.
 *
 * What is pinned here is what the wire cannot be trusted to show on its own:
 *
 *   1. AN UNKNOWN LENS IS AN ERROR, an absent one is the contract package. The
 *      scope parameters fall back rather than 400; this one must not, because
 *      serving the contract package to a reader who asked for another answers a
 *      question they did not ask.
 *   2. THE FOLD IS THE IDENTITY UNDER THE CONTRACT LENS. The default response is
 *      asserted byte-for-byte elsewhere; here it is asserted as a property of the
 *      fold itself, so it cannot become an accident of the fixture.
 *   3. THE THREE RULES OF THE DRAFT FOLD: the clause map carries a contract
 *      finding forward, §3.2 is NOT carried (the draft re-runs it), and a §3.1
 *      custom-object finding lands on 5.3.5 rather than 5.3.3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPLIANCE_MATRIX } from './compliance-matrix.js';
import { ACCEPTED_LENSES, clauseUnderLens, foldUnderLens, lensMatrix, parseLens } from './lens.js';
import type { LensFinding } from './lens.js';
import { CUSTOM_SCHEMA_CODES } from '../ingest/stages/semantic/custom-schema.js';
import type { Profile } from '../schema-registry.js';

const CONTRACT: Profile = '2025';
const DRAFT: Profile = 'ds013';

/** One finding, defaulted so each case states only what it varies. */
function f(over: Partial<LensFinding> & { requirement: string }): LensFinding {
  return { severity: 'fail', profile: CONTRACT, outdated: false, code: null, ...over };
}

// ── parseLens ───────────────────────────────────────────────────────────────

test('an absent lens is the contract package', () => {
  assert.equal(parseLens(undefined), CONTRACT);
  assert.equal(parseLens(null), CONTRACT);
  // A control that has not been set serializes as an empty value; that is the
  // same "no choice made" the missing parameter is, not a choice we cannot serve.
  assert.equal(parseLens(''), CONTRACT);
});

test('every registered lineage is an accepted lens', () => {
  assert.deepEqual([...ACCEPTED_LENSES], ['2025', 'ds013']);
  for (const lens of ACCEPTED_LENSES) assert.equal(parseLens(lens), lens);
});

test('an unknown lens is null — the route turns that into a 400', () => {
  assert.equal(parseLens('ds01.3'), null, 'a near miss is still a miss');
  assert.equal(parseLens('2026'), null);
  assert.equal(parseLens(3), null, 'a non-string is not a package id');
  assert.equal(parseLens(['2025']), null, 'nor is a repeated query parameter');
});

test('the accepted set is a parameter, so a narrowed registry narrows the lens', () => {
  assert.equal(parseLens('ds013', ['2025']), null);
  assert.equal(parseLens('2025', ['2025']), '2025');
});

// ── clauseUnderLens ─────────────────────────────────────────────────────────

test('a contract requirement folds onto its forward clause', () => {
  assert.equal(clauseUnderLens('1.4'), '5.1.5');
  assert.equal(clauseUnderLens('3.1'), '5.3.3');
  assert.equal(clauseUnderLens('4.3'), '5.4.1', 'a merged clause takes all its members');
});

test('§3.2 folds onto nothing: the draft re-runs it rather than re-tagging it', () => {
  // 5.3.2 exists and is fed — by the shadow validator's own findings, which say
  // what Annex 4 decided. A 2025 schema failure is not evidence about Annex 4.
  assert.equal(clauseUnderLens('3.2'), null);
});

test('the §3.1 custom-object check folds onto 5.3.5, pass and fail alike', () => {
  assert.equal(clauseUnderLens('3.1', CUSTOM_SCHEMA_CODES.fail), '5.3.5');
  assert.equal(clauseUnderLens('3.1', CUSTOM_SCHEMA_CODES.pass), '5.3.5');
  // Everything else filed under §3.1 — the data-object naming note — stays on the
  // clause the map names.
  assert.equal(clauseUnderLens('3.1', null), '5.3.3');
});

test('a requirement the map does not carry folds onto nothing', () => {
  assert.equal(clauseUnderLens('adv.null_padding'), null);
  assert.equal(clauseUnderLens('9.9'), null);
});

// ── foldUnderLens: the contract package ─────────────────────────────────────

test('under the contract lens the fold counts contract findings by their own id', () => {
  const { counts, outdated } = foldUnderLens(
    [
      f({ requirement: '1.4' }),
      f({ requirement: '1.4', severity: 'pass' }),
      f({ requirement: '3.2', severity: 'info', outdated: true }),
    ],
    CONTRACT,
    CONTRACT,
  );
  assert.deepEqual(counts['1.4'], { pass: 1, fail: 1, info: 0 });
  assert.deepEqual(counts['3.2'], { pass: 0, fail: 0, info: 1 });
  assert.deepEqual(outdated, { '3.2': 1 });
});

test('under the contract lens a draft finding is counted nowhere', () => {
  const { counts } = foldUnderLens([f({ requirement: '5.3.2', profile: DRAFT })], CONTRACT);
  assert.deepEqual(counts, {}, 'a draft clause id never reaches a §7 row');
});

// ── foldUnderLens: the draft package ────────────────────────────────────────

test('under the draft lens a contract failure is counted on its forward clause', () => {
  const { counts } = foldUnderLens([f({ requirement: '1.4' })], DRAFT, CONTRACT);
  assert.deepEqual(counts['5.1.5'], { pass: 0, fail: 1, info: 0 });
  assert.equal(counts['1.4'], undefined, 'and not on the 2025 id it is stored under');
});

test('under the draft lens the two lineages land on the same clause', () => {
  // 1.1 and 1.2 merge into 5.1.3; a draft finding numbered 5.1.3 joins them.
  const { counts } = foldUnderLens(
    [
      f({ requirement: '1.1', severity: 'pass' }),
      f({ requirement: '1.2', severity: 'pass' }),
      f({ requirement: '5.1.3', profile: DRAFT }),
    ],
    DRAFT,
    CONTRACT,
  );
  assert.deepEqual(counts['5.1.3'], { pass: 2, fail: 1, info: 0 });
});

test('a §3.2 contract failure does NOT reach 5.3.2 — only the draft run does', () => {
  const { counts } = foldUnderLens(
    [
      f({ requirement: '3.2', code: 'tx.schema_invalid' }),
      f({ requirement: '5.3.2', severity: 'pass', profile: DRAFT }),
    ],
    DRAFT,
    CONTRACT,
  );
  assert.deepEqual(
    counts['5.3.2'],
    { pass: 1, fail: 0, info: 0 },
    'the clause reports what Annex 4 decided, which is that the body passed',
  );
});

test('the custom-object check feeds 5.3.5, and the rest of §3.1 feeds 5.3.3', () => {
  const { counts } = foldUnderLens(
    [
      f({ requirement: '3.1', code: CUSTOM_SCHEMA_CODES.fail }),
      f({ requirement: '3.1', severity: 'info', code: null }),
    ],
    DRAFT,
    CONTRACT,
  );
  assert.deepEqual(counts['5.3.5'], { pass: 0, fail: 1, info: 0 });
  assert.deepEqual(counts['5.3.3'], { pass: 0, fail: 0, info: 1 });
});

test('the outdated modifier folds onto the same clause as the finding', () => {
  const { counts, outdated } = foldUnderLens(
    [f({ requirement: '1.8', severity: 'info', outdated: true })],
    DRAFT,
    CONTRACT,
  );
  assert.deepEqual(counts['5.1.9'], { pass: 0, fail: 0, info: 1 });
  assert.deepEqual(outdated, { '5.1.9': 1 });
});

test('an advisory is counted under neither package', () => {
  const { counts } = foldUnderLens(
    [f({ requirement: 'adv.null_padding', severity: 'info', code: 'adv.null_padding' })],
    DRAFT,
    CONTRACT,
  );
  assert.deepEqual(counts, {});
});

// ── lensMatrix ──────────────────────────────────────────────────────────────

test('the contract lens renders the §7 matrix, with no DS01.3 fields on its rows', () => {
  const matrix = lensMatrix(CONTRACT, CONTRACT);
  assert.equal(matrix, COMPLIANCE_MATRIX, 'the same 27 rows, not a copy of them');
  for (const row of matrix) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['classes', 'requirement', 'summary'],
      `${row.requirement}: the default response gains no field from the lens`,
    );
  }
});

test('the draft lens renders the DS01.3 clauses, keyed by clause id', () => {
  const matrix = lensMatrix(DRAFT, CONTRACT);
  assert.equal(matrix.length, 27, '21 clauses with 2025 members plus the 6 DS01.3 adds');
  const byId = new Map(matrix.map((row) => [row.requirement, row]));

  const merged = byId.get('5.1.3');
  assert.deepEqual(merged?.members, ['1.1', '1.2']);
  assert.equal(merged?.graded, true);

  const tightened = byId.get('5.3.2');
  assert.equal(tightened?.tightened, true, '§3.2 → 5.3.2 changes what conformance means');

  // The two DS01.3 fields answer two questions: `graded` reports whether live
  // counts feed the row, and an empty `members` is what makes a row new in the
  // draft. 5.3.5 is the one row where the answers differ — DS01.3 adds it, and the
  // §3.1 custom-object check feeds it (tfnv.14).
  const custom = byId.get('5.3.5');
  assert.deepEqual(custom?.members, []);
  assert.equal(custom?.graded, true);
  assert.deepEqual(custom?.classes, ['verified']);
});
