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
import { randomUUID } from 'node:crypto';

import { buildApp } from '../app.js';
import { closePool, getPool } from '../db/pool.js';
import { createSession, insertFinding, insertTransmission } from '../db/repository.js';

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

test('GET /api/sessions/:uuid → 404 for an unknown uuid', { skip }, async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${randomUUID()}` });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'not_found');
  } finally {
    await app.close();
  }
});

test(
  'GET /api/sessions/:uuid → 200 with reverse-chron transmissions, findings, and §7 summary',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      // Two transmissions; insert "older" first so the second is newest. Findings
      // hang off each: a 1.2 pass on the newest, a 1.4 fail on the older.
      const older = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 100,
        contentType: 'application/json; charset=utf-8',
        httpStatus: 200,
        body: { meta: { transferId: 'T-old' } },
        rawBody: '{"meta":{"transferId":"T-old"}}',
        parseOk: true,
        schemaOk: true,
      });
      await insertFinding(older.id, { requirement: '1.4', severity: 'fail', detail: 'too big' });

      // Tiny gap so received_at ordering is unambiguous for the assertion.
      await new Promise((r) => setTimeout(r, 10));

      const newer = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 200,
        contentType: 'application/json; charset=utf-8',
        httpStatus: 200,
        body: { meta: { transferId: 'T-new' } },
        rawBody: '{"meta":{"transferId":"T-new"}}',
        parseOk: true,
        schemaOk: true,
      });
      await insertFinding(newer.id, { requirement: '1.2', severity: 'pass' });

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(res.statusCode, 200);

      const body = res.json() as {
        session: { uuid: string; auth_enabled: boolean; auth_secret_hash?: unknown };
        transmissions: Array<{
          id: string;
          http_status: number;
          content_type: string;
          wire_bytes: string;
          body: unknown;
          raw_body: string;
          findings: Array<{ requirement: string; severity: string }>;
        }>;
        summary: Array<{ requirement: string; status: string }>;
        expiresAt: string;
      };

      // Metadata, without leaking the secret hash.
      assert.equal(body.session.uuid, uuid);
      assert.equal(body.session.auth_enabled, false);
      assert.ok(!('auth_secret_hash' in body.session), 'never leaks auth_secret_hash');

      // Reverse-chron: newest transmission first, carrying its findings + drill-down.
      assert.equal(body.transmissions.length, 2);
      assert.equal(body.transmissions[0]?.id, newer.id, 'newest first');
      assert.equal(body.transmissions[1]?.id, older.id);
      assert.equal(body.transmissions[0]?.http_status, 200);
      assert.equal(body.transmissions[0]?.content_type, 'application/json; charset=utf-8');
      assert.equal(body.transmissions[0]?.wire_bytes, '200', 'bigint passes through as a string');
      assert.deepEqual(body.transmissions[0]?.body, { meta: { transferId: 'T-new' } });
      assert.equal(body.transmissions[0]?.raw_body, '{"meta":{"transferId":"T-new"}}');
      assert.deepEqual(body.transmissions[0]?.findings, [
        { requirement: '1.2', severity: 'pass', detail: null, pointer: null },
      ]);
      assert.deepEqual(body.transmissions[1]?.findings, [
        { requirement: '1.4', severity: 'fail', detail: 'too big', pointer: null },
      ]);

      // Summary reflects the seeded findings; an unseeded gradeable row is untested.
      const byReq = new Map(body.summary.map((r) => [r.requirement, r.status]));
      assert.equal(byReq.get('1.2'), 'pass', 'seeded pass shows pass');
      assert.equal(byReq.get('1.4'), 'fail', 'seeded fail shows fail');
      assert.equal(
        byReq.get('3.2'),
        'untested',
        'unseeded gradeable row is untested, not a false pass',
      );
      assert.equal(body.summary.length, 27, 'all 27 §7 rows present');

      assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T/, 'expiresAt is an ISO string');
    } finally {
      if (uuid) {
        // Cascade removes this session's transmissions + findings.
        await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      }
      await app.close();
    }
  },
);

test.after(async () => {
  await closePool().catch(() => {});
});
