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

const { gradingLegendTitle, unitsTitle } = await import('./FilterBar.js');

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

/**
 * The CCE-unit tooltip (p98). The count above the list is the one number on this
 * dashboard a supplier could mistake for a statement about their fleet, so what
 * is pinned here is the disclaimer, not the decoration:
 *
 *   1. IT NAMES THE IDENTIFIER PER LINEAGE, so "units" cannot be read as loggers
 *      or as sources — both are different counts of the same traffic.
 *   2. IT SAYS WHAT THE NUMBER IS NOT. DESIGN §7: a passive receiver can only
 *      count equipment that REPORTED. The words "coverage" and "fleet size"
 *      appear nowhere.
 *   3. THE UNIDENTIFIED SENTENCE APPEARS ONLY WHEN IT IS TRUE, and agrees in
 *      number — reports that named no appliance are in the tx count but in no
 *      unit, and without the sentence the two numbers look inconsistent.
 */
test('the unit tooltip names the identifier for each lineage and refuses fleet coverage', () => {
  const title = unitsTitle(0);
  assert.equal(
    title,
    'Distinct appliances reported on in this scope — AMID for RTMD reports, ' +
      'manufacturer + serial (AMFR/ASER) for EMS reports. Counts what was received, ' +
      'not the fleet.',
  );
  for (const word of ['coverage', 'fleet size', 'logger', 'source']) {
    assert.ok(!title.toLowerCase().includes(word), `must not say "${word}"`);
  }
});

test('the unidentified sentence is added only when some report named no appliance', () => {
  assert.ok(!unitsTitle(0).includes('no appliance identifier'));
  assert.ok(unitsTitle(1).startsWith(unitsTitle(0)));
  assert.ok(unitsTitle(3).endsWith(' 3 reports carried no appliance identifier.'));
});

test('the unidentified sentence agrees in number', () => {
  assert.ok(unitsTitle(1).endsWith(' 1 report carried no appliance identifier.'));
  assert.ok(unitsTitle(2).endsWith(' 2 reports carried no appliance identifier.'));
});
