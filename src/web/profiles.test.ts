/**
 * The profile vocabulary (by1c.11) — the words, not the markup.
 *
 * What is pinned here is the handoff's BINDING vocabulary, which no type can
 * hold: a supplier bound to a 2025 LTA must never be told the version their
 * contract requires is stale, so no lineage is ever named "old", "new",
 * "current", "latest", "v1" or "v2". The names themselves are the lens's
 * (tfnv.1): "UNICEF Q1 2025" and "DS01.3 DRAFT".
 *
 * Pure functions on the Node runner, like advisories.test.ts: profiles.ts pulls
 * in no JSX-bearing sibling, so this file needs neither the React shim nor the
 * dynamic import Setup.test.ts / TransmissionsCard.test.ts explain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILE_VOCABULARY as SERVER_VOCABULARY } from '../profile-vocabulary.js';
import type { Profile } from './api.js';
import {
  PROFILE_NAME,
  PROFILE_VOCABULARY,
  formatDraftDate,
  formatDraftDateLong,
} from './profiles.js';

/** Every registered lineage, read off the vocabulary rather than listed by hand. */
const ALL_PROFILES = Object.keys(PROFILE_NAME) as Profile[];

test('the mirrored vocabulary is the server vocabulary, name for name (by1c.32)', () => {
  // src/profile-vocabulary.ts is the definition and this module re-declares it,
  // because tsconfig.web.json's rootDir is src/web and browser code cannot reach
  // outside it. What that mirror costs is a copy that can drift, and drift is
  // exactly the defect by1c.32 removed: the ingest sentence and the dashboard's
  // provenance line had come to call the same bytes by different names. Web
  // tests are excluded from `typecheck:web`, so importing the server module here
  // — the clauseMap.test.ts pattern — reaches nothing in the bundle.
  assert.deepEqual(PROFILE_VOCABULARY, SERVER_VOCABULARY);
});

test("PROFILE_NAME is the vocabulary's short form, not a third list of names", () => {
  for (const profile of ALL_PROFILES) {
    assert.equal(PROFILE_NAME[profile], PROFILE_VOCABULARY[profile].name, profile);
  }
});

test('no lineage name uses a forbidden relative word', () => {
  // The rule binds the vocabulary itself, so it is asserted over the names every
  // surface composes from rather than over one surface's label.
  const forbidden = ['old', 'new', 'current', 'latest', 'v1', 'v2'];
  const labels = ALL_PROFILES.flatMap((profile) => [
    PROFILE_VOCABULARY[profile].name,
    PROFILE_VOCABULARY[profile].longName,
  ]);
  for (const label of labels) {
    const words = label.toLowerCase().split(/[^a-z0-9.]+/);
    for (const word of forbidden) {
      assert.ok(!words.includes(word), `"${label}" uses the forbidden word "${word}"`);
    }
  }
});

test('a draft date renders as month and day, without a local-timezone shift', () => {
  assert.equal(formatDraftDate('2026-09-08'), 'Sep 8');
  assert.equal(formatDraftDate('2026-01-01'), 'Jan 1');
  assert.equal(formatDraftDate('2026-12-31'), 'Dec 31');
});

test('an unrecognised draft date is shown as the server sent it', () => {
  assert.equal(formatDraftDate('2026-09'), '2026-09');
  assert.equal(formatDraftDate('2026-13-08'), '2026-13-08');
  assert.equal(formatDraftDate(''), '');
});

test('the long form carries the year, and passes an unrecognised date through', () => {
  // The lens banner (tfnv.5) dates an unpublished proposal at the end of a
  // sentence, where a bare "Sep 8" leaves the reader to guess the year.
  assert.equal(formatDraftDateLong('2026-09-08'), 'Sep 8, 2026');
  assert.equal(formatDraftDateLong('2026-01-01'), 'Jan 1, 2026');
  assert.equal(formatDraftDateLong('2026-13-08'), '2026-13-08');
  assert.equal(formatDraftDateLong(''), '');
});
