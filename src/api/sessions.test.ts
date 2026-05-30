/**
 * Sessions API tests — `POST /api/sessions` (DESIGN.md §5).
 *
 * Minting touches Postgres, so the test is SKIPPED gracefully when no DB is
 * reachable (copying the src/ingest/route.test.ts skip-guard idiom). To run it:
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgresql://cce_validator:cce_validator@localhost:5432/cce_validator \
 *     npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closePool, getPool } from '../db/pool.js';

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

function makeApp() {
  return buildApp({ logger: false });
}

test('POST /api/sessions → 201, mints a session row + relative paths', { skip }, async () => {
  const app = makeApp();
  await app.ready();
  let uuid: string | undefined;
  try {
    const res = await app.inject({ method: 'POST', url: '/api/sessions' });

    assert.equal(res.statusCode, 201);
    const body = res.json() as {
      uuid: string;
      ingestUrl: string;
      dashboardUrl: string;
    };

    // Exactly the three documented fields, with the right shapes.
    assert.deepEqual(
      Object.keys(body).sort(),
      ['dashboardUrl', 'ingestUrl', 'uuid'],
      'body has exactly {uuid, ingestUrl, dashboardUrl}',
    );
    assert.match(body.uuid, /^[0-9a-f-]{36}$/, 'uuid is a v4-shaped UUID');
    assert.equal(body.ingestUrl, `/i/${body.uuid}`, 'ingestUrl is the relative ingest path');
    assert.equal(body.dashboardUrl, `/d/${body.uuid}`, 'dashboardUrl is the relative dash path');

    uuid = body.uuid;

    // A row exists in the session table for that uuid.
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM session WHERE uuid = $1',
      [uuid],
    );
    assert.equal(rows[0]?.n, '1', 'exactly one session row minted');
  } finally {
    if (uuid) {
      await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
    }
    await app.close();
  }
});

test.after(async () => {
  await closePool().catch(() => {});
});
