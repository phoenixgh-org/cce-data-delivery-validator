/**
 * §1.3 opt-in auth endpoint tests — `POST/DELETE /api/sessions/:uuid/auth` (5bs.4).
 *
 * Covers the API CONTRACT the dashboard's method picker consumes: the optional
 * `method` body field ('header' | 'basic' | 'bearer'), its back-compat default
 * (absent → `header`), its rejection of an unrecognised value, and the per-method
 * 201 body carrying the show-once plaintext (§12).
 *
 * Enabling writes to `session`, so these are SKIPPED gracefully when no Postgres
 * is reachable (the repo-wide skip-guard idiom). Note that a `bearer` enable also
 * exercises the widened `auth_method` CHECK from db/initdb/50-session-auth-bearer.sql
 * — against a database that predates that file the UPDATE raises 23514, so a
 * failure here is the reminder to apply it (see the file header for the psql
 * one-liner).
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgresql://cce_validator:cce_validator@localhost:5432/cce_validator \
 *     npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closePool, getPool } from '../db/pool.js';
import { createSession, getSession } from '../db/repository.js';

async function dbReachable(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    await closePool().catch(() => {});
    return false;
  }
}

const reachable = await dbReachable();
const skip = reachable ? false : 'no Postgres reachable (DATABASE_URL/PG* unset or DB down)';

interface EnableBody {
  uuid: string;
  auth_enabled: boolean;
  auth_method: string;
  auth_header_name?: string;
  username?: string;
  token?: string;
  password?: string;
}

/**
 * POST the opt-in endpoint for a freshly-minted session and hand the response +
 * the stored row to `assertions`, cleaning the session up afterwards.
 */
async function withEnable(
  body: unknown | undefined,
  assertions: (res: { statusCode: number; json: () => unknown }, uuid: string) => Promise<void>,
): Promise<void> {
  const session = await createSession();
  const app = buildApp({ logger: false });
  await app.ready();
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.uuid}/auth`,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    });
    await assertions(res, session.uuid);
  } finally {
    await app.close();
    await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
  }
}

test('POST …/auth with no body → 201, defaults to the header method (back-compat)', { skip }, () =>
  withEnable(undefined, async (res, uuid) => {
    assert.equal(res.statusCode, 201);
    const body = res.json() as EnableBody;
    assert.equal(body.auth_enabled, true);
    assert.equal(body.auth_method, 'header');
    assert.equal(body.auth_header_name, 'X-CCE-Token');
    assert.ok((body.token ?? '').length > 0, 'show-once token returned');
    const stored = await getSession(uuid);
    assert.equal(stored?.auth_method, 'header');
    assert.notEqual(stored?.auth_secret_hash, body.token, 'stores a hash, never the plaintext');
  }),
);

test('POST …/auth {} → 201, header method (empty object is a valid body)', { skip }, () =>
  withEnable({}, async (res) => {
    assert.equal(res.statusCode, 201);
    assert.equal((res.json() as EnableBody).auth_method, 'header');
  }),
);

test('POST …/auth {method:"basic"} → 201 with username + password', { skip }, () =>
  withEnable({ method: 'basic', username: 'supplier-x' }, async (res, uuid) => {
    assert.equal(res.statusCode, 201);
    const body = res.json() as EnableBody;
    assert.equal(body.auth_method, 'basic');
    assert.equal(body.username, 'supplier-x');
    assert.ok((body.password ?? '').length > 0, 'show-once password returned');
    assert.equal((await getSession(uuid))?.auth_method, 'basic');
  }),
);

test('POST …/auth {method:"bearer"} → 201 with a token bound to Authorization', { skip }, () =>
  withEnable({ method: 'bearer' }, async (res, uuid) => {
    assert.equal(res.statusCode, 201);
    const body = res.json() as EnableBody;
    assert.equal(body.auth_method, 'bearer');
    assert.equal(body.auth_header_name, 'Authorization', 'bearer always rides in Authorization');
    assert.ok((body.token ?? '').length > 0, 'show-once token returned');
    assert.equal(body.password, undefined, 'bearer has no password half');
    const stored = await getSession(uuid);
    assert.equal(stored?.auth_method, 'bearer', 'persisted (the widened CHECK admits it)');
    assert.notEqual(stored?.auth_secret_hash, body.token, 'stores a hash, never the plaintext');
  }),
);

test('POST …/auth rejects an unrecognised method with 400 (no silent fallback)', { skip }, () =>
  withEnable({ method: 'digest' }, async (res, uuid) => {
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string; allowed: string[] };
    assert.equal(body.error, 'invalid_method');
    assert.deepEqual(body.allowed, ['header', 'basic', 'bearer']);
    const stored = await getSession(uuid);
    assert.equal(stored?.auth_enabled, false, 'a rejected method leaves auth untouched');
    assert.equal(stored?.auth_method, null);
  }),
);

test('POST …/auth rejects a non-string method with 400', { skip }, () =>
  withEnable({ method: 3 }, async (res) => {
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, 'invalid_method');
  }),
);

test('POST …/auth rejects an unparseable JSON body with 400', { skip }, async () => {
  const session = await createSession();
  const app = buildApp({ logger: false });
  await app.ready();
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.uuid}/auth`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, 'invalid_json');
  } finally {
    await app.close();
    await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
  }
});

test('POST …/auth on an unknown session → 404', { skip }, async () => {
  const app = buildApp({ logger: false });
  await app.ready();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/00000000-0000-0000-0000-000000000000/auth',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ method: 'bearer' }),
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('DELETE …/auth clears a bearer credential', { skip }, async () => {
  const session = await createSession();
  const app = buildApp({ logger: false });
  await app.ready();
  try {
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.uuid}/auth`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ method: 'bearer' }),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.uuid}/auth`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { auth_enabled: boolean; auth_method: string | null };
    assert.equal(body.auth_enabled, false);
    assert.equal(body.auth_method, null);
    const stored = await getSession(session.uuid);
    assert.equal(stored?.auth_secret_hash, null, 'the stored hash is wiped');
  } finally {
    await app.close();
    await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
  }
});
