/**
 * The readiness strip's copy and reason budget (by1c.13).
 *
 * The strip makes a claim about traffic that is CONFORMANT TODAY, which is the
 * one place on this dashboard where a careless sentence would read as a defect
 * against an obligation in force. What is pinned here is exactly that meaning:
 *
 *   1. THREE ABSENCES, TWO OUTCOMES. No shadow lineage registered, and no
 *      readiness computed, both mean there is nothing to preview — hidden. A
 *      scope with no contract-passing transmissions is hidden too: "0 of 0 would
 *      still pass" is a readiness claim about nothing. But `undefined` readiness
 *      is the summary read still in flight, and that is a SKELETON, not a hide —
 *      the two absences must not collapse into one branch.
 *   2. THE NUMERATOR IS THE BOLD HALF. `passingBoth` of `passingContract`, in
 *      that order; and when they are equal the strip stops being a table of
 *      reasons and becomes one line, because there are no reasons left to list.
 *   3. THREE REASONS, THEN A COUNT OF WHAT IS HELD BACK. The toggle's label has
 *      to survive expansion, so it is built from the total rather than from the
 *      hidden count.
 *   4. THE VOCABULARY. "DS01.3" comes from src/web/profiles.ts, and no variant
 *      of the copy calls either lineage old, new, stale, current or latest
 *      (by1c.11).
 *
 * Pure functions only — no React renderer, no DOM. The module is JSX-bearing and
 * evaluates under esbuild's classic transform, hence the global React binding
 * plus the dynamic import; see Setup.test.ts for the full explanation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import type { Readiness, Signature } from '../api.js';

(globalThis as unknown as { React: typeof React }).React = React;

const { readinessCopy, visibleReasons, reasonsToggleLabel, SKELETON_ROWS } =
  await import('./ReadinessStrip.js');

/**
 * A shadow-lineage fail signature. `readiness` no longer carries these (tfnv.4
 * took `reasons` off the wire — the DS01.3 lens's rows are the reasons now), so
 * they are fed straight to the two list helpers, which is all they ever needed.
 * tfnv.8 retires the strip and these helpers with it.
 */
function reason(key: string, req: string, title: string, txCount: number): Signature {
  return {
    key,
    req,
    profile: 'ds013',
    title,
    kind: 'schema',
    sev: 'fail',
    count: txCount,
    txCount,
    sourceCount: 1,
    first: '2026-09-01T00:00:00.000Z',
    last: '2026-09-02T00:00:00.000Z',
    examplePointer: null,
  };
}

/**
 * The readiness object as the wire carries it since tfnv.4: two counts. The third
 * argument is kept at the call sites, and ignored, so each case still reads as
 * "these numbers, with reasons behind them" — the copy under test depends on the
 * counts alone.
 */
function readiness(passingContract: number, passingBoth: number, _reasons: Signature[]): Readiness {
  return { passingContract, passingBoth };
}

const FIVE = [
  reason('ds013|5.3.2|required|/data/*|LSER', '5.3.2', 'RTM logger identity missing', 44),
  reason('ds013|5.3.3|pattern|/meta/transferredAt|', '5.3.3', 'transferredAt has an offset', 19),
  reason('ds013|5.1.10|check|dup|', '5.1.10', 'Duplicate transferId, now a shall', 12),
  reason('ds013|5.3.2|required|/data/*|LMOD', '5.3.2', 'Logger model missing', 8),
  reason('ds013|5.3.2|required|/data/*|LPQS', '5.3.2', 'PQS code missing', 3),
];

test('no shadow lineage hides the strip, whatever the readiness says', () => {
  assert.deepEqual(readinessCopy(readiness(10, 4, FIVE), null), { kind: 'hidden' });
  // Even the in-flight case: with no shadow lineage there is nothing to load.
  assert.deepEqual(readinessCopy(undefined, null), { kind: 'hidden' });
});

test('no readiness computed hides the strip', () => {
  assert.deepEqual(readinessCopy(null, 'ds013'), { kind: 'hidden' });
});

test('no contract-passing transmissions hides the strip', () => {
  assert.deepEqual(readinessCopy(readiness(0, 0, []), 'ds013'), { kind: 'hidden' });
});

test('readiness still in flight is a skeleton, not a hide', () => {
  const copy = readinessCopy(undefined, 'ds013');
  assert.equal(copy.kind, 'skeleton');
  assert.equal(copy.kind === 'skeleton' && copy.title, 'DS01.3 DRAFT readiness');
  assert.equal(copy.kind === 'skeleton' && copy.eyebrow, 'shadow-graded');
  // The placeholder is the height of a full, collapsed reason list, so nothing
  // shifts when the numbers arrive.
  assert.equal(SKELETON_ROWS, 3);
});

test('100% collapses to one line naming the count once', () => {
  assert.deepEqual(readinessCopy(readiness(212, 212, []), 'ds013'), {
    kind: 'collapsed',
    line: 'DS01.3 DRAFT readiness · all 212 passing tx would still pass',
  });
});

test('the header reads passingBoth of passingContract, numerator first', () => {
  const copy = readinessCopy(readiness(212, 141, FIVE), 'ds013');
  assert.equal(copy.kind, 'header');
  if (copy.kind !== 'header') return;
  assert.equal(copy.title, 'DS01.3 DRAFT readiness');
  assert.equal(copy.eyebrow, 'shadow-graded');
  assert.equal(copy.count, 141);
  assert.equal(copy.rest, ' of 212 passing tx would still pass');
  // The count is the bold half; joined, the sentence is the wireframe's.
  assert.equal(`${copy.count}${copy.rest}`, '141 of 212 passing tx would still pass');
});

test('none of the passing traffic surviving is still a header, not a collapse', () => {
  const copy = readinessCopy(readiness(1, 0, FIVE), 'ds013');
  assert.equal(copy.kind, 'header');
  assert.equal(copy.kind === 'header' && copy.count, 0);
  assert.equal(copy.kind === 'header' && copy.rest, ' of 1 passing tx would still pass');
});

test('three reasons show, the rest are counted', () => {
  const { shown, hiddenCount } = visibleReasons(FIVE, false);
  assert.deepEqual(
    shown.map((s) => s.req),
    ['5.3.2', '5.3.3', '5.1.10'],
  );
  assert.equal(hiddenCount, 2);
  assert.equal(reasonsToggleLabel(FIVE.length, false), '+2 more reasons ▸');
});

test('expanding shows every reason and nothing is left held back', () => {
  const { shown, hiddenCount } = visibleReasons(FIVE, true);
  assert.equal(shown.length, 5);
  assert.equal(hiddenCount, 0);
  // The label has to survive expansion, so it is built from the total.
  assert.equal(reasonsToggleLabel(FIVE.length, true), 'fewer reasons ◂');
});

test('three or fewer reasons get no toggle at all', () => {
  const three = FIVE.slice(0, 3);
  const { shown, hiddenCount } = visibleReasons(three, false);
  assert.equal(shown.length, 3);
  assert.equal(hiddenCount, 0);
  assert.equal(reasonsToggleLabel(three.length, false), null);
  assert.equal(reasonsToggleLabel(0, false), null);
});

test('the reasons are taken in the order the server sent them, txCount descending', () => {
  // Reasons arrive txCount descending (they did from the server, and a caller
  // that revives this list must keep that order); the strip must not re-order,
  // or the "top 3" would stop being the most widespread three.
  const { shown } = visibleReasons(FIVE, false);
  assert.deepEqual(
    shown.map((s) => s.txCount),
    [44, 19, 12],
  );
});

test('no variant of the copy calls a lineage old, new, stale, current or latest', () => {
  const variants = [
    readinessCopy(undefined, 'ds013'),
    readinessCopy(readiness(212, 212, []), 'ds013'),
    readinessCopy(readiness(212, 141, FIVE), 'ds013'),
  ];
  const words = /\b(old|older|outdated|new|newer|stale|current|latest|v1|v2)\b/i;
  for (const copy of variants) {
    const text = Object.values(copy)
      .filter((v) => typeof v === 'string')
      .join(' ');
    assert.equal(words.test(text), false, `forbidden vocabulary in: ${text}`);
    // And the lineage is named from PROFILE_NAME, not spelled out here.
    assert.equal(text.includes('DS01.3'), true);
  }
  assert.equal(words.test(reasonsToggleLabel(5, false) ?? ''), false);
});
