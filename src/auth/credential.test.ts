/**
 * §1.3 credential generation + verification unit tests (ct4.1).
 *
 * Pure: no DB, no HTTP. Exercises BOTH methods (`header`, `basic`) through the
 * single source of truth — generate, then verify the show-once plaintext against
 * the persisted `{auth_method, auth_header_name, auth_secret_hash}`, plus the
 * wrong/missing/malformed branches. Mirrors the hand-built-input idiom of the
 * stage-unit tests (e.g. src/ingest/stages/semantic/duplicate.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateCredential, verifyCredential, type StoredSessionAuth } from './credential.js';

/** Turn a {@link generateCredential} result into the stored-session shape a verify reads. */
function asEnabledSession(store: {
  auth_method: 'header' | 'basic';
  auth_header_name: string;
  auth_secret_hash: string;
}): StoredSessionAuth {
  return { auth_enabled: true, ...store };
}

const basicAuthHeader = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('generate(header): stores hash not plaintext, returns a token', () => {
  const cred = generateCredential('header');
  assert.equal(cred.store.auth_method, 'header');
  assert.equal(cred.store.auth_header_name, 'X-CCE-Token', 'default header name');
  assert.ok(cred.plaintext.length > 0, 'returns a show-once token');
  assert.notEqual(cred.store.auth_secret_hash, cred.plaintext, 'persists a hash, not plaintext');
  assert.match(cred.store.auth_secret_hash, /^[0-9a-f]+:[0-9a-f]+$/, 'stored as salt:hash hex');
});

test('generate(header): honours a custom header name', () => {
  const cred = generateCredential('header', { headerName: 'X-Supplier-Auth' });
  assert.equal(cred.store.auth_header_name, 'X-Supplier-Auth');
});

test('verify(header): correct token → true', () => {
  const cred = generateCredential('header');
  const session = asEnabledSession(cred.store);
  assert.equal(verifyCredential({ headerValue: cred.plaintext }, session), true);
});

test('verify(header): wrong token → false', () => {
  const cred = generateCredential('header');
  const session = asEnabledSession(cred.store);
  assert.equal(verifyCredential({ headerValue: 'not-the-token' }, session), false);
});

test('verify(header): missing header value → false', () => {
  const cred = generateCredential('header');
  const session = asEnabledSession(cred.store);
  assert.equal(verifyCredential({}, session), false);
  assert.equal(verifyCredential({ headerValue: '' }, session), false);
});

test('generate(basic): stores hash, returns username + password', () => {
  const cred = generateCredential('basic', { username: 'supplier-x' });
  assert.equal(cred.store.auth_method, 'basic');
  assert.equal(cred.store.auth_header_name, 'supplier-x', 'username persisted as header_name');
  assert.equal(cred.username, 'supplier-x');
  assert.ok(cred.plaintext.length > 0, 'returns a show-once password');
  assert.notEqual(cred.store.auth_secret_hash, cred.plaintext, 'persists a hash, not plaintext');
});

test('generate(basic): default username when none given', () => {
  const cred = generateCredential('basic');
  assert.equal(cred.store.auth_header_name, 'cce');
});

test('verify(basic): correct user + password → true', () => {
  const cred = generateCredential('basic', { username: 'supplier-x' });
  const session = asEnabledSession(cred.store);
  const authorization = basicAuthHeader('supplier-x', cred.plaintext);
  assert.equal(verifyCredential({ authorization }, session), true);
});

test('verify(basic): wrong password → false', () => {
  const cred = generateCredential('basic', { username: 'supplier-x' });
  const session = asEnabledSession(cred.store);
  const authorization = basicAuthHeader('supplier-x', 'wrong-password');
  assert.equal(verifyCredential({ authorization }, session), false);
});

test('verify(basic): wrong username (right password) → false', () => {
  const cred = generateCredential('basic', { username: 'supplier-x' });
  const session = asEnabledSession(cred.store);
  const authorization = basicAuthHeader('someone-else', cred.plaintext);
  assert.equal(verifyCredential({ authorization }, session), false);
});

test('verify(basic): missing / malformed Authorization → false', () => {
  const cred = generateCredential('basic', { username: 'supplier-x' });
  const session = asEnabledSession(cred.store);
  assert.equal(verifyCredential({}, session), false, 'no header');
  assert.equal(verifyCredential({ authorization: 'Bearer xyz' }, session), false, 'wrong scheme');
  assert.equal(
    verifyCredential({ authorization: 'Basic !!!not-base64-with-colon' }, session),
    false,
    'no colon after decode',
  );
});

test('verify: disabled session always → false even with the right secret', () => {
  const cred = generateCredential('header');
  const session: StoredSessionAuth = { auth_enabled: false, ...cred.store };
  assert.equal(verifyCredential({ headerValue: cred.plaintext }, session), false);
});

test('verify: unconfigured session (null fields) → false', () => {
  const session: StoredSessionAuth = {
    auth_enabled: true,
    auth_method: null,
    auth_header_name: null,
    auth_secret_hash: null,
  };
  assert.equal(verifyCredential({ headerValue: 'anything' }, session), false);
});

test('each generation uses a fresh salt (same plaintext → different stored hash)', () => {
  const a = generateCredential('header');
  const b = generateCredential('header');
  // Even if the random plaintexts collided, distinct salts would diverge the hash.
  assert.notEqual(a.store.auth_secret_hash, b.store.auth_secret_hash);
});

test('cross-session secrets do not verify against the wrong session', () => {
  const a = generateCredential('header');
  const b = generateCredential('header');
  assert.equal(
    verifyCredential({ headerValue: a.plaintext }, asEnabledSession(b.store)),
    false,
    "session A's token must not pass session B",
  );
});
