/**
 * The verdict pair's tooltip (by1c.12) — the only text a supplier gets for the
 * two neutral dots at the end of a transmission row.
 *
 * What is pinned here is meaning the dots cannot carry on their own:
 *
 *   1. THE WORDS ARE THE VOCABULARY'S. "2025" and "DS01.3" come from
 *      src/web/profiles.ts and the contract half is keyed off CONTRACT_PROFILE,
 *      so a lineage is never named by a literal at the call site (by1c.11).
 *   2. A NULL SHADOW VERDICT IS NOT A FAILURE. The shadow lineage not running on
 *      a transmission must read as "not graded", never as a grade — the tooltip
 *      is the only place that distinction is visible once the second dot is
 *      dropped.
 *   3. THE COUNT IS SHADOW FAILURES, AND ONLY WHEN THERE ARE SOME. A "(0
 *      findings)" parenthetical on a shadow fail would be a number that
 *      contradicts itself.
 *
 * Pure functions only — no React renderer, no DOM. The module is JSX-bearing and
 * evaluates under esbuild's classic transform, hence the global React binding
 * plus the dynamic import; see Setup.test.ts for the full explanation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

(globalThis as unknown as { React: typeof React }).React = React;

const { verdictPairTitle } = await import('./VerdictDot.js');

test('the tooltip names both lineages, with the shadow fail count', () => {
  assert.equal(
    verdictPairTitle({
      contract: 'pass',
      shadow: 'fail',
      shadowProfile: 'ds013',
      findingsCount: 2,
    }),
    '2025: pass · DS01.3: fail (2 findings)',
  );
  // One failure reads in the singular.
  assert.equal(
    verdictPairTitle({
      contract: 'fail',
      shadow: 'fail',
      shadowProfile: 'ds013',
      findingsCount: 1,
    }),
    '2025: fail · DS01.3: fail (1 finding)',
  );
});

test('a zero count drops the parenthetical rather than printing "(0 findings)"', () => {
  assert.equal(
    verdictPairTitle({
      contract: 'pass',
      shadow: 'fail',
      shadowProfile: 'ds013',
      findingsCount: 0,
    }),
    '2025: pass · DS01.3: fail',
  );
  // An omitted count behaves the same way.
  assert.equal(
    verdictPairTitle({ contract: 'pass', shadow: 'pass', shadowProfile: 'ds013' }),
    '2025: pass · DS01.3: pass',
  );
});

test('a shadow lineage that never ran reads as not graded, not as a fail', () => {
  const expected = 'DS01.3: not graded (unknown schema version)';
  assert.equal(
    verdictPairTitle({ contract: 'pass', shadow: null, shadowProfile: 'ds013' }),
    expected,
  );
  // The web mirror types the verdicts map as Partial, so an ABSENT key means the
  // same thing as a null one and must not read differently (by1c.9).
  assert.equal(
    verdictPairTitle({ contract: 'pass', shadow: undefined, shadowProfile: 'ds013' }),
    expected,
  );
});

test('with no shadow lineage registered the tooltip is the contract half alone', () => {
  assert.equal(
    verdictPairTitle({ contract: 'fail', shadow: undefined, shadowProfile: null }),
    '2025: fail',
  );
});
