import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNKNOWN_SOURCE_CODE,
  UNKNOWN_SOURCE_KEY,
  UNKNOWN_SOURCE_LABEL,
  deriveSourceCode,
  deriveSourceView,
  sourceCounts,
} from './source.js';

test('deriveSourceCode: reverse-DNS key keys off the meaningful name', () => {
  // "org" is dropped as a namespace; first 3 alnum of "kano" → KAN.
  assert.equal(deriveSourceCode('org.kano-depot'), 'KAN');
});

test('deriveSourceCode: single token uses its first three letters', () => {
  assert.equal(deriveSourceCode('kano'), 'KAN');
});

test('deriveSourceCode: short single token is padded with X and uppercased', () => {
  assert.equal(deriveSourceCode('ab'), 'ABX');
});

test('deriveSourceCode: short tokens draw on later tokens', () => {
  assert.equal(deriveSourceCode('x.y.z'), 'XYZ');
});

test('deriveSourceCode: namespace not dropped when it is the only token', () => {
  assert.equal(deriveSourceCode('org'), 'ORG');
});

test('deriveSourceCode: deterministic — same key always yields the same code', () => {
  assert.equal(deriveSourceCode('org.kano-depot'), deriveSourceCode('org.kano-depot'));
});

test('deriveSourceCode: empty/whitespace key → unknown bucket code', () => {
  assert.equal(deriveSourceCode(''), UNKNOWN_SOURCE_CODE);
  assert.equal(deriveSourceCode('   '), UNKNOWN_SOURCE_CODE);
});

test('deriveSourceView: real key produces source/code/label triple', () => {
  assert.deepEqual(deriveSourceView('org.kano-depot'), {
    source: 'org.kano-depot',
    sourceCode: 'KAN',
    sourceLabel: 'org.kano-depot',
  });
});

test('deriveSourceView: trims surrounding whitespace from the key + label', () => {
  assert.deepEqual(deriveSourceView('  kano  '), {
    source: 'kano',
    sourceCode: 'KAN',
    sourceLabel: 'kano',
  });
});

test('deriveSourceView: null/undefined/blank → the single stable unknown bucket', () => {
  const unknown = {
    source: UNKNOWN_SOURCE_KEY,
    sourceCode: UNKNOWN_SOURCE_CODE,
    sourceLabel: UNKNOWN_SOURCE_LABEL,
  };
  assert.deepEqual(deriveSourceView(null), unknown);
  assert.deepEqual(deriveSourceView(undefined), unknown);
  assert.deepEqual(deriveSourceView(''), unknown);
  assert.deepEqual(deriveSourceView('   '), unknown);
});

test('sourceCounts: empty set → no options', () => {
  assert.deepEqual(sourceCounts([]), []);
});

test('sourceCounts: folds per source and sorts by count desc', () => {
  const counts = sourceCounts([
    { transfer_src: 'org.kano-depot' },
    { transfer_src: 'org.kano-depot' },
    { transfer_src: 'org.kano-depot' },
    { transfer_src: 'lab.alpha' },
  ]);
  assert.deepEqual(counts, [
    { source: 'org.kano-depot', sourceCode: 'KAN', sourceLabel: 'org.kano-depot', count: 3 },
    { source: 'lab.alpha', sourceCode: 'LAB', sourceLabel: 'lab.alpha', count: 1 },
  ]);
});

test('sourceCounts: null/blank sources collapse into one unknown bucket', () => {
  const counts = sourceCounts([
    { transfer_src: null },
    { transfer_src: '' },
    { transfer_src: '   ' },
    { transfer_src: 'kano' },
  ]);
  assert.deepEqual(counts, [
    {
      source: UNKNOWN_SOURCE_KEY,
      sourceCode: UNKNOWN_SOURCE_CODE,
      sourceLabel: UNKNOWN_SOURCE_LABEL,
      count: 3,
    },
    { source: 'kano', sourceCode: 'KAN', sourceLabel: 'kano', count: 1 },
  ]);
});

test('sourceCounts: ties broken by source key ascending for stable order', () => {
  const counts = sourceCounts([{ transfer_src: 'zeta' }, { transfer_src: 'alpha' }]);
  assert.deepEqual(
    counts.map((c) => c.source),
    ['alpha', 'zeta'],
  );
});
