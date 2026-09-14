/**
 * The profile vocabulary (by1c.11) — the words, not the markup.
 *
 * What is pinned here is the handoff's BINDING vocabulary, which no type can
 * hold: a supplier bound to a 2025 LTA must never be told the version their
 * contract requires is stale, so "(contract)" follows `CONTRACT_PROFILE` rather
 * than living on the '2025' key, and no lineage is ever named "old", "new",
 * "current", "latest", "v1" or "v2".
 *
 * Pure functions on the Node runner, like advisories.test.ts: profiles.ts pulls
 * in no JSX-bearing sibling, so this file needs neither the React shim nor the
 * dynamic import Setup.test.ts / TransmissionsCard.test.ts explain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_PROFILE, type Profile, type ShadowProvenance } from './api.js';
import {
  PROFILE_NAME,
  formatDraftDate,
  gradingLegend,
  profileLabel,
  shadowLegend,
} from './profiles.js';

/** The DS01.3 shadow entry as the session read serves it — an unpublished draft. */
const draftShadow: ShadowProvenance = {
  version: '1',
  sha256: 'a'.repeat(64),
  draftDate: '2026-09-08',
};

/** A published shadow entry: version and hash alone, no date to call it a draft. */
const publishedShadow: ShadowProvenance = { version: '0.9.0', sha256: 'b'.repeat(64) };

/** Every registered lineage, read off the vocabulary rather than listed by hand. */
const ALL_PROFILES = Object.keys(PROFILE_NAME) as Profile[];

test('the "(contract)" suffix follows CONTRACT_PROFILE, not the "2025" key', () => {
  assert.equal(profileLabel(CONTRACT_PROFILE), `${PROFILE_NAME[CONTRACT_PROFILE]} (contract)`);
  for (const profile of ALL_PROFILES) {
    if (profile === CONTRACT_PROFILE) continue;
    assert.equal(profileLabel(profile), PROFILE_NAME[profile]);
  }
});

test('no lineage label uses a forbidden relative word', () => {
  const forbidden = ['old', 'new', 'current', 'latest', 'v1', 'v2'];
  const labels = ALL_PROFILES.map(profileLabel).concat(
    shadowLegend(draftShadow, 'ds013') ?? '',
    shadowLegend(publishedShadow, 'ds013') ?? '',
  );
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

test('a draft shadow entry is named as a draft, dated', () => {
  assert.equal(shadowLegend(draftShadow, 'ds013'), 'DS01.3 draft Sep 8');
});

test('a published shadow entry is named by version, never called a draft', () => {
  assert.equal(shadowLegend(publishedShadow, 'ds013'), 'DS01.3 0.9.0');
});

test('no shadow lineage means no shadow label at all', () => {
  assert.equal(shadowLegend(null, null), null);
  assert.equal(shadowLegend(null, 'ds013'), null);
  assert.equal(shadowLegend(draftShadow, null), null);
});

test('the grading legend names the contract, and the shadow half only when there is one', () => {
  const withShadow = gradingLegend('ds013', draftShadow);
  assert.equal(withShadow.contract, profileLabel(CONTRACT_PROFILE));
  assert.deepEqual(withShadow.shadow, { name: 'DS01.3 draft', detail: 'Sep 8' });

  const contractOnly = gradingLegend(null, null);
  assert.equal(contractOnly.contract, profileLabel(CONTRACT_PROFILE));
  assert.equal(contractOnly.shadow, null);
});
