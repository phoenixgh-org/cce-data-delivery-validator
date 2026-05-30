/**
 * Ingest route full-flow tests (DESIGN.md §6).
 *
 * The 405 (non-POST) case needs no DB — Fastify resolves it without a session
 * lookup short-circuiting first. The 404 and happy-path persist cases touch
 * Postgres, so they are SKIPPED gracefully when no DB is reachable (copying the
 * src/db/repository.test.ts skip-guard idiom). To run the DB cases:
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
import { createSession } from '../db/repository.js';

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

test('GET /i/:uuid → 405, no transmission row (method gate)', async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: `/i/${randomUUID()}` });
    assert.equal(res.statusCode, 405);
    const body = res.json() as { transmissionId: string | null };
    assert.equal(body.transmissionId, null, 'no row persisted for 405');
  } finally {
    await app.close();
  }
});

test('PUT /i/:uuid → 405, no transmission row (method gate)', async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `/i/${randomUUID()}`,
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from('{}'),
    });
    assert.equal(res.statusCode, 405);
  } finally {
    await app.close();
  }
});

test('POST to unknown uuid → 404, no transmission row', { skip }, async () => {
  const app = makeApp();
  await app.ready();
  try {
    const unknown = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: `/i/${unknown}`,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: Buffer.from('{"meta":{}}'),
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { transmissionId: string | null; findings: number };
    assert.equal(body.transmissionId, null, 'no row persisted for 404');

    // Belt-and-suspenders: confirm no transmission row exists for this session.
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM transmission WHERE session_uuid = $1',
      [unknown],
    );
    assert.equal(rows[0]?.n, '0');
  } finally {
    await app.close();
  }
});

test('POST to a valid session → 200, persists a transmission row', { skip }, async () => {
  const app = makeApp();
  await app.ready();
  let sessionUuid: string | undefined;
  try {
    const session = await createSession();
    sessionUuid = session.uuid;

    // A genuinely schema-valid 0.8.0 RTM transmission so the request reaches the
    // happy-path 200 now that stages 6 (parse) and 7 (schema) are live — the old
    // stub-era body (`data:[]`, no schemaVersion) now correctly 422s.
    const payload = Buffer.from(
      JSON.stringify({
        meta: {
          schemaVersion: '0.8.0',
          transferType: 'rtm',
          transferId: 'T-9',
          transferSrc: 'com.example',
          transferredAt: '2024-01-15T04:05:54Z',
        },
        data: [
          {
            AMID: 'appliance-1',
            CID: 'US',
            EDOP: '2021-06-01',
            EMFR: 'EMD_Name',
            EMOD: 'EMD-ModelNo',
            EPQS: 'E006/999',
            ESER: 'EMD-SerialNum',
            EMSV: 'v01.02.123',
            DLST: { TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' } },
            records: [
              { ABST: '20200115T040554Z', ALRM: 'HEAT', BEMD: 14.3, EERR: 'none', TVC: 3.2 },
            ],
          },
        ],
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/i/${session.uuid}`,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      transmissionId: string | null;
      status: number;
      findings: number;
    };
    assert.match(body.transmissionId ?? '', /^[0-9a-f-]{36}$/, 'returns a persisted id');
    assert.equal(body.status, 200);
    assert.equal(typeof body.findings, 'number', 'findings count is a teaching surface');

    // Confirm exactly one transmission row was written for this session, with the
    // happy-path persist columns wired (content_hash, wire_bytes, http_status).
    const { rows } = await getPool().query<{
      id: string;
      wire_bytes: string;
      http_status: number;
      content_hash: Buffer | null;
      raw_body: string | null;
    }>(
      `SELECT id, wire_bytes, http_status, content_hash, raw_body
       FROM transmission WHERE session_uuid = $1`,
      [session.uuid],
    );
    assert.equal(rows.length, 1, 'exactly one row recorded');
    assert.equal(rows[0]?.id, body.transmissionId);
    assert.equal(rows[0]?.wire_bytes, String(payload.length));
    assert.equal(rows[0]?.http_status, 200);
    assert.ok(rows[0]?.content_hash, 'content_hash recorded');
    assert.equal(rows[0]?.raw_body, payload.toString('utf8'), 'raw bytes retained');
  } finally {
    if (sessionUuid) {
      await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
    await app.close();
  }
});

test.after(async () => {
  await closePool().catch(() => {});
});
