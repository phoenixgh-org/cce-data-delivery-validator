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
