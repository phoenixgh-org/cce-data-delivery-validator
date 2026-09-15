/**
 * The filter bar's grading legend tooltip (by1c.11, by1c.36).
 *
 * Two claims are pinned here, and they pull in opposite directions on purpose:
 *
 *   1. THE SENTENCE IS THE ONE by1c.11 SPECIFIED, word for word. It is the only
 *      place a supplier is told which lineage the matrix and the pass rate grade
 *      against, so it is quoted here as a literal — a reworded tooltip has to be
 *      a deliberate copy change, not a side effect of an edit elsewhere.
 *   2. THE LINEAGE NAMES ARE THE VOCABULARY'S. The same sentence is rebuilt from
 *      PROFILE_NAME and CONTRACT_PROFILE and must come out identical: on the day
 *      the contract moves, this tooltip has to move with every other surface
 *      rather than keep naming the lineage that used to be in force.
 *
 * A session with no shadow lineage gets the first sentence alone — the tooltip
 * must not describe a verdict column and a readiness strip that are not on the
 * page.
 *
 * Pure functions only — no React renderer, no DOM. The module is JSX-bearing and
 * evaluates under esbuild's classic transform, hence the global React binding
 * plus the dynamic import; see Setup.test.ts for the full explanation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import { CONTRACT_PROFILE } from '../api';
import { PROFILE_NAME } from '../profiles.js';

(globalThis as unknown as { React: typeof React }).React = React;

const { gradingLegendTitle } = await import('./FilterBar.js');

test('the tooltip reads exactly as by1c.11 specified it', () => {
  assert.equal(
    gradingLegendTitle('ds013'),
    'The matrix and pass rate grade against the 2025 requirements. DS01.3 is graded in the ' +
      'shadow and shown in the readiness strip, the second verdict column and the transmission ' +
      'detail.',
  );
});

test('both lineage names come from the vocabulary, not from a literal', () => {
  assert.equal(
    gradingLegendTitle('ds013'),
    `The matrix and pass rate grade against the ${PROFILE_NAME[CONTRACT_PROFILE]} requirements. ` +
      `${PROFILE_NAME['ds013']} is graded in the shadow and shown in the readiness strip, the ` +
      'second verdict column and the transmission detail.',
  );
});

test('with no shadow lineage the tooltip names no shadow surfaces', () => {
  const title = gradingLegendTitle(null);
  assert.equal(
    title,
    `The matrix and pass rate grade against the ${PROFILE_NAME[CONTRACT_PROFILE]} requirements.`,
  );
  assert.ok(!title.includes(PROFILE_NAME['ds013']));
});
