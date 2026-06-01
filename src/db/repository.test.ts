/**
 * Repository smoke test against a real Postgres.
 *
 * Requires the docker-compose Postgres (or any reachable DB whose schema came
 * from db/initdb). It is SKIPPED gracefully when no DB is reachable, so
 * `npm test` stays green in CI without a database. To run it locally:
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgresql://cce_validator:cce_validator@localhost:5432/cce_validator \
 *     npm test
 *
 * It proves the layer end-to-end: insert a session, read it back, insert a
 * transmission against it, and confirm content_hash is NON-UNIQUE by recording
 * the same hash twice (the §1.8 signal). Each run cleans up its own session
 * (cascade removes its transmissions).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { getPool, closePool } from './pool.js';
import {
  bumpLastPostAt,
  createSession,
  findPriorTransmissions,
  getSession,
  insertFinding,
  insertFindings,
  insertTransmission,
} from './repository.js';

/** Probe the DB once; if unreachable, the whole suite is skipped. */
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

test('the three tables from db/initdb exist', { skip }, async () => {
  const { rows } = await getPool().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('session', 'transmission', 'finding')
     ORDER BY table_name`,
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ['finding', 'session', 'transmission'],
  );
});

test('session round-trips: insert then read back', { skip }, async () => {
  const created = await createSession({ authEnabled: false });
  assert.match(created.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(created.auth_enabled, false);
  assert.equal(created.last_post_at, null);

  const fetched = await getSession(created.uuid);
  assert.ok(fetched, 'session should be readable after insert');
  assert.equal(fetched.uuid, created.uuid);
  assert.equal(fetched.created_at.getTime(), created.created_at.getTime());

  // cleanup (cascades to any transmissions/findings).
  await getPool().query('DELETE FROM session WHERE uuid = $1', [created.uuid]);
});

test('getSession returns null for an unknown uuid', { skip }, async () => {
  assert.equal(await getSession(randomUUID()), null);
});

test('transmission inserts under a session and round-trips jsonb body', { skip }, async () => {
  const session = await createSession();
  const hash = createHash('sha256').update('wire-bytes').digest();
  const tx = await insertTransmission({
    sessionUuid: session.uuid,
    contentHash: hash,
    wireBytes: 1234,
    contentType: 'application/json; charset=utf-8',
    transferId: 'T-1',
    schemaVersion: '0.8.0',
    body: { meta: { transferId: 'T-1' }, data: [{ x: 1 }] },
    rawBody: '{"meta":{"transferId":"T-1"},"data":[{"x":1}]}',
    parseOk: true,
    schemaOk: true,
  });

  assert.match(tx.id, /^[0-9a-f-]{36}$/);
  assert.equal(tx.session_uuid, session.uuid);
  assert.equal(tx.wire_bytes, '1234'); // bigint comes back as a string
  assert.ok(tx.content_hash && tx.content_hash.equals(hash));
  assert.deepEqual(tx.body, { meta: { transferId: 'T-1' }, data: [{ x: 1 }] });
  assert.equal(tx.parse_ok, true);

  await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
});

test(
  'content_hash is NON-UNIQUE: the same hash records twice (§1.8 signal)',
  { skip },
  async () => {
    const session = await createSession();
    const hash = createHash('sha256').update('exact-replay').digest();

    const first = await insertTransmission({ sessionUuid: session.uuid, contentHash: hash });
    const second = await insertTransmission({ sessionUuid: session.uuid, contentHash: hash });
    assert.notEqual(first.id, second.id, 'each POST gets its own row');

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM transmission WHERE session_uuid = $1 AND content_hash = $2',
      [session.uuid, hash],
    );
    assert.equal(rows[0]?.n, '2', 'duplicate is recorded, not collapsed');

    await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
  },
);

test('bumpLastPostAt stamps last_post_at; null for an unknown uuid', { skip }, async () => {
  const session = await createSession();
  assert.equal(session.last_post_at, null, 'null until first POST');

  const stamped = await bumpLastPostAt(session.uuid);
  assert.ok(stamped instanceof Date, 'returns the new timestamp');

  const fetched = await getSession(session.uuid);
  assert.ok(fetched?.last_post_at, 'last_post_at is now set');
  assert.equal(fetched!.last_post_at!.getTime(), stamped!.getTime());

  assert.equal(await bumpLastPostAt(randomUUID()), null, 'null for unknown uuid');

  await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
});

test('insertFinding / insertFindings record rows against a transmission', { skip }, async () => {
  const session = await createSession();
  const tx = await insertTransmission({ sessionUuid: session.uuid });

  const single = await insertFinding(tx.id, {
    requirement: '1.4',
    severity: 'fail',
    detail: 'too big',
  });
  assert.match(single.id, /^[0-9a-f-]{36}$/);
  assert.equal(single.transmission_id, tx.id);
  assert.equal(single.severity, 'fail');

  const many = await insertFindings(tx.id, [
    { requirement: '1.2', severity: 'pass' },
    { requirement: '3.2', severity: 'info', detail: 'd', pointer: '/data/0' },
  ]);
  assert.equal(many.length, 2);
  assert.equal(many[1]?.pointer, '/data/0');

  // Empty array short-circuits without running SQL.
  assert.deepEqual(await insertFindings(tx.id, []), []);

  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*) AS n FROM finding WHERE transmission_id = $1',
    [tx.id],
  );
  assert.equal(rows[0]?.n, '3', 'all three findings recorded');

  await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
});

test(
  'findPriorTransmissions matches prior rows by transferId OR contentHash (§1.8)',
  { skip },
  async () => {
    const session = await createSession();
    const hashA = createHash('sha256').update('bytes-A').digest();
    const hashB = createHash('sha256').update('bytes-B').digest();

    // Two earlier rows: one carrying transferId T-1, one carrying hashA.
    const byTransfer = await insertTransmission({
      sessionUuid: session.uuid,
      transferId: 'T-1',
      contentHash: hashB,
    });
    const byHash = await insertTransmission({
      sessionUuid: session.uuid,
      transferId: 'T-other',
      contentHash: hashA,
    });

    // Match by transferId only.
    const tMatch = await findPriorTransmissions(session.uuid, { transferId: 'T-1' });
    assert.deepEqual(
      tMatch.map((r) => r.id),
      [byTransfer.id],
      'transferId match returns the T-1 row',
    );

    // Match by contentHash only.
    const hMatch = await findPriorTransmissions(session.uuid, { contentHash: hashA });
    assert.deepEqual(
      hMatch.map((r) => r.id),
      [byHash.id],
      'contentHash match returns the hashA row',
    );

    // transferId OR contentHash → both rows (newest-first), deduped by row.
    const both = await findPriorTransmissions(session.uuid, {
      transferId: 'T-1',
      contentHash: hashA,
    });
    assert.equal(both.length, 2, 'OR matches both prior rows');
    assert.deepEqual(new Set(both.map((r) => r.id)), new Set([byTransfer.id, byHash.id]));

    // No selectors → empty (no SQL run).
    assert.deepEqual(await findPriorTransmissions(session.uuid, {}), []);
    // No match → empty.
    assert.deepEqual(await findPriorTransmissions(session.uuid, { transferId: 'nope' }), []);

    await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
  },
);

test.after(async () => {
  await closePool().catch(() => {});
});
