/**
 * CCE identity tests (agj.24) — PURE, no DB.
 *
 * `unitKey`'s own rule is already held from the dashboard side by
 * `src/api/scope.test.ts` (the p98 cases under "distinct CCE units"), which still
 * imports it through `unitTotals` and is unchanged by the move. What is proved
 * here is the identity seam itself and the new window reader: which reports and
 * which records contribute a window, and which are skipped because there is
 * nothing comparable to store.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUnitWindows, identifier, unitKey } from './unit-key.js';

/** One record at the given compact ABST instant. */
function rec(abst: unknown): Record<string, unknown> {
  return { ABST: abst, TVC: 4.2 };
}

/** Epoch ms of a compact ABST string, for asserting against. */
function at(iso: string): number {
  return Date.parse(iso);
}

// ── the identity rule (p98) ─────────────────────────────────────────────────

test('unitKey prefers ASER, falls back to AMID, and prefixes the namespace', () => {
  assert.equal(unitKey({ ASER: 'sn-1' }), 'aser:sn-1');
  assert.equal(unitKey({ AMID: 'fridge-1' }), 'amid:fridge-1');
  // Both present: ASER wins, because the two are different kinds of name.
  assert.equal(unitKey({ ASER: 'sn-1', AMID: 'fridge-1' }), 'aser:sn-1');
  // A present-but-null ASER is the ordinary rtmd shape, not an edge case.
  assert.equal(unitKey({ ASER: null, AMID: 'fridge-1' }), 'amid:fridge-1');
  assert.equal(unitKey({ AMFR: 'Alpha' }), null, 'neither identifier → no key');
});

test('identifier trims but does not case-fold, and rejects blanks and non-strings', () => {
  assert.equal(identifier('  sn-1 '), 'sn-1');
  assert.equal(identifier('AB'), 'AB', '"AB" is not "ab"');
  assert.equal(identifier('   '), null);
  assert.equal(identifier(''), null);
  assert.equal(identifier(null), null);
  assert.equal(identifier(7), null);
});

// ── computeUnitWindows ──────────────────────────────────────────────────────

test('computeUnitWindows returns one window per identified report', () => {
  const windows = computeUnitWindows({
    meta: { transferType: 'ems' },
    data: [
      {
        ASER: 'sn-1',
        records: [rec('20260901T000000Z'), rec('20260901T060000Z'), rec('20260901T030000Z')],
      },
      { AMID: 'fridge-2', records: [rec('20260902T120000Z'), rec('20260902T130000Z')] },
    ],
  });

  assert.deepEqual(windows, [
    {
      unitKey: 'aser:sn-1',
      abstMin: at('2026-09-01T00:00:00Z'),
      abstMax: at('2026-09-01T06:00:00Z'),
      recordCount: 3,
    },
    {
      unitKey: 'amid:fridge-2',
      abstMin: at('2026-09-02T12:00:00Z'),
      abstMax: at('2026-09-02T13:00:00Z'),
      recordCount: 2,
    },
  ]);
});

/**
 * Records this service cannot read do not widen the window and are not counted.
 * `parseAbst` is the same reader §3.4 grades cadence with, so an ABST rejected
 * here is one the interval check could not read either — treating it as a bound
 * would invent a window edge out of an unreadable string.
 */
test('computeUnitWindows skips records whose ABST is absent, null or unparseable', () => {
  const windows = computeUnitWindows({
    data: [
      {
        ASER: 'sn-1',
        records: [
          rec('20260901T000000Z'),
          rec('2026-09-01T23:00:00Z'), // ISO with separators: not the compact ABST form
          rec(null),
          rec(undefined),
          { TVC: 4.2 }, // no ABST at all
          rec(20260901),
          rec('20260901T010000.500Z'), // sub-second resolution parses
        ],
      },
    ],
  });

  assert.deepEqual(windows, [
    {
      unitKey: 'aser:sn-1',
      abstMin: at('2026-09-01T00:00:00Z'),
      abstMax: at('2026-09-01T01:00:00.500Z'),
      recordCount: 2,
    },
  ]);
});

test('computeUnitWindows skips a report with no appliance identifier', () => {
  const windows = computeUnitWindows({
    data: [
      { AMFR: 'Alpha', records: [rec('20260901T000000Z')] },
      { ASER: '   ', records: [rec('20260901T000000Z')] },
      { ASER: 'sn-1', records: [rec('20260901T000000Z')] },
    ],
  });

  assert.deepEqual(
    windows.map((w) => w.unitKey),
    ['aser:sn-1'],
  );
});

test('computeUnitWindows skips a report whose records yield no window', () => {
  assert.deepEqual(
    computeUnitWindows({
      data: [
        { ASER: 'sn-1', records: [] },
        { ASER: 'sn-2', records: [rec('not-a-timestamp')] },
        { ASER: 'sn-3' }, // no records array
        { ASER: 'sn-4', records: 'nope' },
      ],
    }),
    [],
  );
});

test('computeUnitWindows yields a degenerate window for a single record', () => {
  assert.deepEqual(
    computeUnitWindows({ data: [{ ASER: 'sn-1', records: [rec('20260901T000000Z')] }] }),
    [
      {
        unitKey: 'aser:sn-1',
        abstMin: at('2026-09-01T00:00:00Z'),
        abstMax: at('2026-09-01T00:00:00Z'),
        recordCount: 1,
      },
    ],
  );
});

/** One window per unit per transmission — the table's primary key demands it. */
test('computeUnitWindows merges two reports for the same appliance', () => {
  assert.deepEqual(
    computeUnitWindows({
      data: [
        { ASER: 'sn-1', records: [rec('20260901T000000Z'), rec('20260901T010000Z')] },
        { ASER: 'sn-1', records: [rec('20260901T090000Z')] },
      ],
    }),
    [
      {
        unitKey: 'aser:sn-1',
        abstMin: at('2026-09-01T00:00:00Z'),
        abstMax: at('2026-09-01T09:00:00Z'),
        recordCount: 3,
      },
    ],
  );
});

test('computeUnitWindows returns [] for a body that is not an object with an array data', () => {
  assert.deepEqual(computeUnitWindows(null), []);
  assert.deepEqual(computeUnitWindows(undefined), []);
  assert.deepEqual(computeUnitWindows('{"data":[]}'), []);
  assert.deepEqual(computeUnitWindows(42), []);
  assert.deepEqual(computeUnitWindows([{ ASER: 'sn-1' }]), [], 'a bare array is not a body');
  assert.deepEqual(computeUnitWindows({}), []);
  assert.deepEqual(computeUnitWindows({ data: null }), []);
  assert.deepEqual(computeUnitWindows({ data: { '0': { ASER: 'sn-1' } } }), []);
  assert.deepEqual(computeUnitWindows({ data: ['not-a-report', 7, null] }), []);
});
