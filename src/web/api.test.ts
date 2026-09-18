/**
 * The two reads' query serialisation (tfnv.17).
 *
 * The lens bite (tfnv.4/tfnv.5) claimed that a dashboard sitting on the contract
 * package asks for exactly the URLs it asked for before the lens existed, and
 * that `lens` reaches the server only when a caller names a package. Both halves
 * were argued in a commit message and pinned nowhere, in a bite whose acceptance
 * criterion was "the default lens renders identically to before". The literals
 * below are that pin: the default query strings are asserted whole, so a key
 * added, renamed or re-ordered fails here rather than reaching a supplier's
 * browser.
 *
 * Pure functions on the Node runner, like scopeCopy.test.ts: the builders are
 * split out of the fetching functions precisely so no `fetch` stub stands
 * between the test and the rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionQuery, transmissionsQuery } from './api.js';

test('a default session read serializes scope only — no lens', () => {
  // What the Dashboard sends on first paint: window/source at their defaults and
  // the contract package, which supplies no `lens` key at all.
  assert.equal(sessionQuery({ window: 'all', source: 'all' }), 'window=all&source=all');
  assert.equal(sessionQuery(), '');
  assert.equal(sessionQuery({}), '');
});

test('a session read under a named package appends lens last', () => {
  assert.equal(
    sessionQuery({ window: 'all', source: 'all', lens: 'ds013' }),
    'window=all&source=all&lens=ds013',
  );
  assert.equal(sessionQuery({ lens: 'ds013' }), 'lens=ds013');
  assert.equal(sessionQuery({ lens: '2025' }), 'lens=2025');
});

test('a default transmissions read serializes scope only — no lens, no filters', () => {
  // The Dashboard's page-1 opts with nothing filtered and no signature selected:
  // `failuresOnly: false` and an undefined `signatureKey` are both omitted.
  assert.equal(
    transmissionsQuery({
      window: 'all',
      source: 'all',
      failuresOnly: false,
      signatureKey: undefined,
    }),
    'window=all&source=all',
  );
  assert.equal(transmissionsQuery(), '');
});

test('a transmissions read under a named package carries lens ahead of the filters', () => {
  assert.equal(
    transmissionsQuery({ window: 'all', source: 'all', failuresOnly: false, lens: 'ds013' }),
    'window=all&source=all&lens=ds013',
  );
  assert.equal(
    transmissionsQuery({
      window: '24h',
      source: 'sim',
      failuresOnly: true,
      signatureKey: 'sig-1',
      cursor: 'c-2',
      limit: 50,
      lens: 'ds013',
    }),
    'window=24h&source=sim&lens=ds013&failuresOnly=true&signatureKey=sig-1&cursor=c-2&limit=50',
  );
});

test('empty and falsy list options are omitted rather than sent blank', () => {
  // The omissions the list read has always made: an empty signature key or cursor
  // is "no filter", not a filter on the empty string.
  assert.equal(transmissionsQuery({ signatureKey: '', cursor: '' }), '');
  assert.equal(transmissionsQuery({ failuresOnly: false }), '');
  assert.equal(transmissionsQuery({ limit: 0 }), 'limit=0');
});
