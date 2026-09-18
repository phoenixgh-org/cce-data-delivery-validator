/**
 * The CCE-unit tooltip (p98), moved here with its function when FilterBar was
 * retired (vamh.1). The count above the list is the one number on this dashboard
 * a supplier could mistake for a statement about their fleet, so what is pinned
 * here is the disclaimer, not the decoration:
 *
 *   1. IT NAMES THE IDENTIFIER THE COUNT IS KEYED ON, in preference order, so
 *      "units" cannot be read as loggers or as sources — both are different
 *      counts of the same traffic.
 *   2. IT SAYS WHAT THE NUMBER IS NOT. DESIGN §7: a passive receiver can only
 *      count equipment that REPORTED. The words "coverage" and "fleet size"
 *      appear nowhere.
 *   3. THE UNIDENTIFIED SENTENCE APPEARS ONLY WHEN IT IS TRUE, and agrees in
 *      number — reports that named no appliance are in the tx count but in no
 *      unit, and without the sentence the two numbers look inconsistent.
 *
 * Pure functions on the Node runner, like profiles.test.ts: scopeCopy.ts pulls in
 * no JSX-bearing sibling, so this file needs neither the React shim nor the
 * dynamic import Setup.test.ts explains.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unitsTitle } from './scopeCopy.js';

test('the unit tooltip names the identifiers in preference order and refuses fleet coverage', () => {
  const title = unitsTitle(0);
  assert.equal(
    title,
    'Distinct appliances reported on in this scope — the manufacturer serial ' +
      "(ASER) where sent, otherwise the supplier's appliance id (AMID). Counts " +
      'what was received, not the fleet.',
  );
  // ASER is the preferred key (p98, decided 2026-08-04), so it is named first.
  assert.ok(title.indexOf('ASER') < title.indexOf('AMID'), 'ASER is named first');
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
