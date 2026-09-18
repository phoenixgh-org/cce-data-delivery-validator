/**
 * The other half of the lens-serialisation property (tfnv.17): the reads
 * serialize `lens` only when they are given one, and the Dashboard gives them
 * one only when the selected package is not the contract in force.
 *
 * `{}` is not cosmetic here. An options object carrying `lens: '2025'` would
 * change every default request URL on the dashboard — to a URL the server
 * answers identically, but one no prior bite pinned — so the distinction between
 * an absent key and a key holding the contract value is the thing under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_PROFILE } from './api.js';
import { lensOpt } from './lensQuery.js';

test('the contract package supplies no lens key at all', () => {
  const opts = lensOpt(CONTRACT_PROFILE, CONTRACT_PROFILE);
  assert.deepEqual(opts, {});
  assert.equal('lens' in opts, false);
});

test('any other package supplies its own id', () => {
  assert.deepEqual(lensOpt('ds013', CONTRACT_PROFILE), { lens: 'ds013' });
});

test('the contract is the parameter, not this module (the flip point moves)', () => {
  // The day the contract in force becomes the draft package, the same function
  // omits ds013 and names 2025 — nothing here is keyed to a literal lineage.
  assert.deepEqual(lensOpt('ds013', 'ds013'), {});
  assert.deepEqual(lensOpt('2025', 'ds013'), { lens: '2025' });
});
