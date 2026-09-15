/**
 * Contract-profile marker tests against a real Postgres (by1c.52).
 *
 * Requires the docker-compose Postgres (or any reachable DB whose schema came
 * from db/initdb, including 80-contract-profile-marker.sql). SKIPPED gracefully
 * when no DB is reachable, so `npm test` stays green without a database:
 *
 *   docker compose up -d postgres
 *   npm run test:db
 *
 * `service_marker` is a SINGLETON, so these tests share one row with anything
 * else running against the same database. Each test therefore captures the row
 * it found and restores it, and never leaves a mismatched profile behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_PROFILE, PROFILES, type Profile } from '../schema-registry.js';
import { getPool, closePool } from './pool.js';
import {
  assertContractProfile,
  contractProfileMismatchMessage,
  isMissingMarkerTable,
  missingMarkerTableMessage,
  readContractMarker,
  writeContractMarker,
} from './contract-marker.js';

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

/** A registered profile that is NOT the contract one — the flip-day case. */
const OTHER_PROFILE: Profile = PROFILES.find((p) => p !== CONTRACT_PROFILE)!;

/** Clear the singleton row. */
async function clearMarker(): Promise<void> {
  await getPool().query('DELETE FROM service_marker');
}

/** Restore whatever the marker held before a test ran. */
async function restoreMarker(original: Profile | null): Promise<void> {
  if (original === null) {
    await clearMarker();
  } else {
    await writeContractMarker(original);
  }
}

test('a fresh database stamps the marker with CONTRACT_PROFILE', { skip }, async () => {
  const original = await readContractMarker();
  try {
    await clearMarker();
    const check = await assertContractProfile();
    assert.equal(check.outcome, 'fresh');
    assert.equal(check.stored, null);
    assert.equal(check.expected, CONTRACT_PROFILE);
    assert.equal(await readContractMarker(), CONTRACT_PROFILE);
  } finally {
    await restoreMarker(original);
  }
});

test('a marker equal to CONTRACT_PROFILE reports match', { skip }, async () => {
  const original = await readContractMarker();
  try {
    await writeContractMarker(CONTRACT_PROFILE);
    const check = await assertContractProfile();
    assert.equal(check.outcome, 'match');
    assert.equal(check.stored, CONTRACT_PROFILE);
    assert.equal(check.expected, CONTRACT_PROFILE);
  } finally {
    await restoreMarker(original);
  }
});

test('a marker from another profile reports mismatch', { skip }, async () => {
  const original = await readContractMarker();
  try {
    await writeContractMarker(OTHER_PROFILE);
    const check = await assertContractProfile();
    assert.equal(check.outcome, 'mismatch');
    assert.equal(check.stored, OTHER_PROFILE);
    assert.equal(check.expected, CONTRACT_PROFILE);
    // The marker is NOT rewritten on mismatch: the database keeps saying what it
    // was written under, so a restart refuses again until the volume is discarded.
    assert.equal(await readContractMarker(), OTHER_PROFILE);
  } finally {
    await restoreMarker(original);
  }
});

test('writeContractMarker upserts rather than accumulating rows', { skip }, async () => {
  const original = await readContractMarker();
  try {
    await writeContractMarker(CONTRACT_PROFILE);
    await writeContractMarker(CONTRACT_PROFILE);
    const { rows } = await getPool().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM service_marker',
    );
    assert.equal(rows[0]!.count, '1');
  } finally {
    await restoreMarker(original);
  }
});

test('the mismatch message names both profiles and the operator action', () => {
  const message = contractProfileMismatchMessage('2025', 'ds013');
  assert.match(message, /last written under contract profile 2025/);
  assert.match(message, /this build runs contract profile ds013/);
  assert.match(message, /docker compose down -v/);
  assert.match(message, /no migration/);
});

test(
  'a database without the marker table reports missing-table, not an error',
  { skip },
  async () => {
    // The volume that predates db/initdb/80-contract-profile-marker.sql (by1c.54).
    // Reproduced by dropping the table inside a transaction that is rolled back,
    // so the real SQLSTATE 42P01 reaches the check and no other test sees the
    // table disappear.
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE service_marker');

      const check = await assertContractProfile(client);
      assert.equal(check.outcome, 'missing-table');
      assert.equal(check.stored, null);
      assert.equal(check.expected, CONTRACT_PROFILE);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    // The rollback put the table back: the guard is readable again.
    await assert.doesNotReject(() => readContractMarker());
  },
);

test('a read failure that is NOT a missing table still propagates', async () => {
  // The fail-open branch in src/index.ts must keep seeing a thrown error for a
  // connection refusal, a timeout or an auth failure — those say nothing about
  // what the database holds, so they must not be reported as a verdict.
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
  });
  const db = {
    query: () => Promise.reject(refused),
  } as unknown as Parameters<typeof assertContractProfile>[0];

  await assert.rejects(() => assertContractProfile(db), /ECONNREFUSED/);
});

test('isMissingMarkerTable selects 42P01 and nothing else', () => {
  assert.equal(isMissingMarkerTable({ code: '42P01' }), true);
  assert.equal(isMissingMarkerTable(Object.assign(new Error('nope'), { code: '42P01' })), true);
  assert.equal(isMissingMarkerTable({ code: '42703' }), false); // undefined_column
  assert.equal(isMissingMarkerTable({ code: 'ECONNREFUSED' }), false);
  assert.equal(isMissingMarkerTable(new Error('no code at all')), false);
  assert.equal(isMissingMarkerTable(null), false);
  assert.equal(isMissingMarkerTable(undefined), false);
  assert.equal(isMissingMarkerTable('42P01'), false);
});

test('the missing-table message names the file to apply and where to read', () => {
  const message = missingMarkerTableMessage();
  assert.match(message, /contract profile marker table is missing/);
  assert.match(message, /db\/initdb\/80-contract-profile-marker\.sql/);
  assert.match(message, /docs\/deployment\.md/);
  assert.match(message, /Upgrading an existing database volume/);
});
