/**
 * The browser's signature key must equal the server's (by1c.14).
 *
 * src/web/signatureKey.ts is a hand-copied mirror of `sigKey` / `generalizePath`
 * in src/api/signatures.ts, and a mirror that drifts fails SILENTLY: the docked
 * detail's shadow rows would build keys that match no signature, so every row
 * would lose its title and its cross-filter and nothing would throw. So this
 * imports BOTH implementations and asserts they agree over a fixture set
 * covering each branch of the key: the advisory namespace, a schema error keyed
 * on an Ajv keyword, a check code, and the detail-string last resort.
 *
 * Importing the server module from a web test is the Setup.test.ts pattern —
 * web tests are excluded from `typecheck:web`, so nothing here is compiled into
 * the bundle. No React shim is needed: signatureKey.ts pulls in no JSX.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generalizePath as serverGeneralizePath, sigKey } from '../api/signatures.js';
import type { SignatureFinding } from '../api/signatures.js';
import { findingSignatureKey, generalizePath } from './signatureKey.js';

/** A finding in the shape BOTH sides accept, defaulted so a case states only its point. */
function finding(over: Partial<SignatureFinding> = {}): SignatureFinding {
  return {
    requirement: '3.2',
    severity: 'fail',
    detail: null,
    pointer: null,
    outdated: false,
    keyword: null,
    instancePath: null,
    param: null,
    code: null,
    profile: '2025',
    ...over,
  };
}

/** One case per branch of the key, plus the shapes the two lineages produce. */
const FIXTURES: Record<string, SignatureFinding> = {
  'schema · required at an indexed path': finding({
    keyword: 'required',
    instancePath: '/data/3/records/11',
    param: 'LSER',
  }),
  'schema · pattern at a fixed path': finding({
    requirement: '5.3.3',
    profile: 'ds013',
    keyword: 'pattern',
    instancePath: '/meta/transferredAt',
    param: 'pattern',
    detail: 'schema violation at /meta/transferredAt: must match pattern (§5.3.3)',
  }),
  'schema · keyword with no param': finding({
    keyword: 'type',
    instancePath: '/data/0/ABST',
    param: null,
  }),
  'schema · keyword at the document root': finding({ keyword: 'type', instancePath: '' }),
  'check · a transport code': finding({
    requirement: '1.1',
    code: 'tx.missing_charset',
    detail: 'Content-Type had no charset',
  }),
  'check · the same code under the shadow lineage': finding({
    requirement: '5.3.2',
    profile: 'ds013',
    code: 'tx.schema_invalid',
  }),
  'detail only · the §1.3 auth fail carries no code': finding({
    requirement: '1.3',
    detail: 'Bearer token did not match',
  }),
  'detail only · nothing to key on at all': finding({ requirement: '4.4' }),
  'advisory · id in the requirement': finding({
    requirement: 'adv.null_padding',
    severity: 'info',
    detail: 'Nulls padded the record',
  }),
  'advisory · id in the code as well': finding({
    requirement: 'adv.null_padding',
    severity: 'info',
    code: 'adv.null_padding',
  }),
};

test('the browser key equals the server key for every finding shape', () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    assert.equal(findingSignatureKey(f), sigKey(f), name);
  }
});

test('the browser generalizePath equals the server one', () => {
  const paths = [
    '',
    '/meta/transferredAt',
    '/data/0',
    '/data/0/records/12/ABST',
    '/data/10/ABST',
    null,
    undefined,
  ];
  for (const p of paths) {
    assert.equal(generalizePath(p), serverGeneralizePath(p), String(p));
  }
});

test('the two lineages key the same defect apart', () => {
  const contract = finding({ keyword: 'required', instancePath: '/data/0', param: 'LSER' });
  const shadow = finding({
    requirement: '5.3.2',
    profile: 'ds013',
    keyword: 'required',
    instancePath: '/data/0',
    param: 'LSER',
  });
  assert.notEqual(findingSignatureKey(contract), findingSignatureKey(shadow));
  assert.equal(findingSignatureKey(shadow), sigKey(shadow));
});
