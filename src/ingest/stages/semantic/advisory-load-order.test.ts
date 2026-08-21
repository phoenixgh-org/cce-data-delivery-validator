/**
 * THE LOAD ORDER THAT USED TO THROW (igw).
 *
 * advisory.ts imports every check module to build `ADVISORY_CHECKS`; the checks
 * used to import {@link advisory} back from advisory.ts, which is an ESM cycle.
 * Under the order an importer reaching a CHECK MODULE FIRST produces, a check
 * written in the house `export const …Check: SemanticCheck =` idiom was still in
 * its temporal dead zone when advisory.ts's module body ran, and the array threw
 * at load. Only a hoisted function declaration survived it, so the idiom was
 * load-bearing and comments were the only guard.
 *
 * Moving the constructor into the leaf advisory-finding.ts removed the cycle, so
 * both orders are now fine. This file pins that: it is a SEPARATE test file
 * because module evaluation happens once per process, so the order can only be
 * established by being the first thing the process loads. The imports are
 * dynamic (rather than static) so the order is written in the test body, where a
 * lint rule that sorts import statements cannot silently reverse it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a check module loaded FIRST still registers in ADVISORY_CHECKS', async () => {
  // Order is the whole point: the check module, then the registry.
  const { nullIdentityCheck } = await import('./null-identity.js');
  const { nullPaddingCheck } = await import('./null-padding.js');
  const { ADVISORY_CHECKS } = await import('./advisory.js');

  assert.ok(
    ADVISORY_CHECKS.includes(nullIdentityCheck),
    'the const-idiom check did not reach the registry',
  );
  assert.ok(ADVISORY_CHECKS.includes(nullPaddingCheck));
  assert.ok(
    ADVISORY_CHECKS.every((check) => typeof check === 'function'),
    'a registry entry was undefined at the time the array was built',
  );
});

test('the constructor is reachable from the leaf and from the registry alike', async () => {
  // Existing importers keep reaching for `semantic/advisory.js`; the re-export is
  // what lets them, and it must be the same function the checks call.
  const leaf = await import('./advisory-finding.js');
  const registry = await import('./advisory.js');
  assert.equal(registry.advisory, leaf.advisory);
  assert.equal(registry.isAdvisoryId, leaf.isAdvisoryId);
  assert.equal(registry.ADVISORY_PREFIX, leaf.ADVISORY_PREFIX);
});
