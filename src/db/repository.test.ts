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
  findPriorUnitWindows,
  getSession,
  insertFinding,
  insertFindings,
  insertTransmission,
  insertUnitWindows,
  purgeExpiredSessions,
  type Profile,
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

test(
  'a finding with no profile is rejected, not quietly labelled (by1c.50)',
  { skip },
  async () => {
    const session = await createSession();
    const tx = await insertTransmission({ sessionUuid: session.uuid });

    // The type makes this unreachable from compiled code; the cast reproduces what
    // a future emitter bug would do at runtime. node-postgres binds `undefined` as
    // NULL, and with the column's DEFAULT dropped (db/initdb/70-finding-profile-no-
    // default.sql) NOT NULL rejects it. The alternative — a default that silently
    // labels the row '2025' — would count an ungraded finding into a supplier's
    // contract result, which is the failure mode this guards.
    await assert.rejects(
      () =>
        insertFinding(tx.id, {
          requirement: '1.4',
          severity: 'fail',
          profile: undefined as unknown as Profile,
        }),
      /null value in column "profile"|not-null constraint/i,
    );

    // The multi-row path rejects the same way, and writes nothing at all — the
    // statement is atomic, so the conformant sibling in the same array is rolled
    // back with it rather than landing half a transmission's findings.
    await assert.rejects(
      () =>
        insertFindings(tx.id, [
          { requirement: '1.2', severity: 'pass', profile: '2025' },
          { requirement: '3.2', severity: 'fail', profile: undefined as unknown as Profile },
        ]),
      /null value in column "profile"|not-null constraint/i,
    );

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM finding WHERE transmission_id = $1',
      [tx.id],
    );
    assert.equal(rows[0]?.n, '0', 'nothing was persisted by either rejected insert');

    await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
  },
);

test('insertFinding / insertFindings record rows against a transmission', { skip }, async () => {
  const session = await createSession();
  const tx = await insertTransmission({ sessionUuid: session.uuid });

  const single = await insertFinding(tx.id, {
    requirement: '1.4',
    severity: 'fail',
    detail: 'too big',
    code: 'tx.body_too_large',
    profile: '2025',
  });
  assert.match(single.id, /^[0-9a-f-]{36}$/);
  assert.equal(single.transmission_id, tx.id);
  assert.equal(single.severity, 'fail');
  // Structured signature fields round-trip (4h4.1): code set, schema fields null.
  assert.equal(single.code, 'tx.body_too_large');
  assert.equal(single.keyword, null);
  assert.equal(single.instance_path, null);
  assert.equal(single.param, null);
  // A graded finding carries no advisory observation line (agj.17).
  assert.equal(single.summary, null);
  // Lineage (by1c.5): written explicitly — there is no default in the storage
  // layer, in the input type or in the column (by1c.50).
  assert.equal(single.profile, '2025');

  // An explicit lineage round-trips — the shadow run (by1c.6) writes 'ds013'.
  const shadow = await insertFinding(tx.id, {
    requirement: '5.3.3',
    severity: 'fail',
    profile: 'ds013',
  });
  assert.equal(shadow.profile, 'ds013');

  // The advisory prose split (agj.17): `summary` is the observation line and
  // `detail` the rationale. Written through the multi-row path on purpose — that
  // INSERT binds a FIXED number of params per tuple, so a column added to the
  // list and not to the count binds every row one field out of step, and the
  // rows still land. Only reading a per-row value back catches that.
  const advisory = await insertFinding(tx.id, {
    requirement: 'adv.null_identity',
    severity: 'info',
    summary: '1 of 1 report carries no appliance serial number.',
    detail: 'ASER is the appliance serial number, as assigned by the manufacturer.',
    code: 'adv.null_identity',
    profile: '2025',
  });
  assert.equal(advisory.summary, '1 of 1 report carries no appliance serial number.');
  assert.equal(
    advisory.detail,
    'ASER is the appliance serial number, as assigned by the manufacturer.',
  );

  const many = await insertFindings(tx.id, [
    { requirement: '1.2', severity: 'pass', profile: '2025' },
    {
      requirement: '3.2',
      severity: 'fail',
      detail: 'd',
      pointer: '/data/0',
      keyword: 'required',
      instancePath: '/data/0',
      param: 'EERR',
      profile: 'ds013',
    },
    {
      requirement: 'adv.sample_gap',
      severity: 'info',
      summary: '3 gaps exceed the 900 s period.',
      detail: 'Recording gaps have everyday causes, such as an extended power outage.',
      code: 'adv.sample_gap',
      profile: '2025',
    },
  ]);
  assert.equal(many.length, 3);
  // Per-row summary through the multi-row path: null on the two graded rows, the
  // observation line on the advisory.
  assert.equal(many[0]?.summary, null);
  assert.equal(many[1]?.summary, null);
  assert.equal(many[2]?.summary, '3 gaps exceed the 900 s period.');
  assert.equal(
    many[2]?.detail,
    'Recording gaps have everyday causes, such as an extended power outage.',
  );
  assert.equal(many[2]?.code, 'adv.sample_gap');
  // Per-row lineage in the multi-row INSERT: contract on the first, shadow on
  // the second — proving the column is bound per tuple, not once per statement.
  assert.equal(many[0]?.profile, '2025');
  assert.equal(many[1]?.profile, 'ds013');
  assert.equal(many[1]?.pointer, '/data/0');
  // The schema fail carries its Ajv keyword/instancePath/param and no code.
  assert.equal(many[1]?.keyword, 'required');
  assert.equal(many[1]?.instance_path, '/data/0');
  assert.equal(many[1]?.param, 'EERR');
  assert.equal(many[1]?.code, null);
  // The pass finding carries no structured fields.
  assert.equal(many[0]?.keyword, null);
  assert.equal(many[0]?.code, null);

  // Empty array short-circuits without running SQL.
  assert.deepEqual(await insertFindings(tx.id, []), []);

  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*) AS n FROM finding WHERE transmission_id = $1',
    [tx.id],
  );
  assert.equal(rows[0]?.n, '6', 'all six findings recorded');

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

/** Epoch ms of an instant, for building windows to store. */
function at(iso: string): number {
  return Date.parse(iso);
}

test(
  'unit windows round-trip and findPriorUnitWindows returns only OTHER transmissions (agj.24)',
  { skip },
  async () => {
    const session = await createSession();
    const hashA = createHash('sha256').update('body-A').digest();
    const hashB = createHash('sha256').update('body-B').digest();

    const first = await insertTransmission({
      sessionUuid: session.uuid,
      transferId: 'T-1',
      contentHash: hashA,
      schemaOk: true,
    });
    const second = await insertTransmission({
      sessionUuid: session.uuid,
      transferId: 'T-2',
      contentHash: hashB,
      schemaOk: true,
    });

    await insertUnitWindows(first.id, session.uuid, [
      {
        unitKey: 'aser:sn-1',
        abstMin: at('2026-09-01T00:00:00Z'),
        abstMax: at('2026-09-01T06:00:00Z'),
        recordCount: 24,
      },
      {
        unitKey: 'amid:fridge-2',
        abstMin: at('2026-09-01T00:00:00Z'),
        abstMax: at('2026-09-01T02:00:00Z'),
        recordCount: 8,
      },
    ]);
    await insertUnitWindows(second.id, session.uuid, [
      {
        unitKey: 'aser:sn-1',
        abstMin: at('2026-09-01T05:00:00Z'),
        abstMax: at('2026-09-01T11:00:00Z'),
        recordCount: 24,
      },
    ]);

    // The second POST asks what came before for its own unit: only the first
    // transmission's row, with the bounds and receipt time it needs to describe it.
    const priors = await findPriorUnitWindows(session.uuid, ['aser:sn-1'], {
      excludeContentHash: hashB,
      excludeTransferId: 'T-2',
    });
    assert.equal(priors.length, 1, 'a transmission never sees its own window');
    assert.equal(priors[0]?.transmission_id, first.id);
    assert.equal(priors[0]?.unit_key, 'aser:sn-1');
    assert.equal(priors[0]?.transfer_id, 'T-1');
    assert.equal(priors[0]?.abst_min.getTime(), at('2026-09-01T00:00:00Z'));
    assert.equal(priors[0]?.abst_max.getTime(), at('2026-09-01T06:00:00Z'));
    assert.ok(priors[0]?.received_at instanceof Date, 'received_at joins off transmission');

    // A unit this session never reported on matches nothing…
    assert.deepEqual(
      await findPriorUnitWindows(session.uuid, ['aser:never'], {}),
      [],
      'unknown unit key → no priors',
    );
    // …and no unit keys at all short-circuits without running SQL.
    assert.deepEqual(await findPriorUnitWindows(session.uuid, [], {}), []);

    // Several keys at once, newest transmission first.
    const both = await findPriorUnitWindows(session.uuid, ['aser:sn-1', 'amid:fridge-2'], {});
    assert.equal(both.length, 3, 'every window for either key, both transmissions');
    assert.equal(both[0]?.transmission_id, second.id, 'newest-first');

    // Another session's windows are invisible even under the same unit key.
    const other = await createSession();
    const otherTx = await insertTransmission({ sessionUuid: other.uuid, schemaOk: true });
    await insertUnitWindows(otherTx.id, other.uuid, [
      {
        unitKey: 'aser:sn-1',
        abstMin: at('2026-09-01T00:00:00Z'),
        abstMax: at('2026-09-01T06:00:00Z'),
        recordCount: 24,
      },
    ]);
    assert.deepEqual(
      (await findPriorUnitWindows(session.uuid, ['aser:sn-1'], {})).map((r) => r.transmission_id),
      [second.id, first.id],
      'the lookup stays inside its own session',
    );

    await getPool().query('DELETE FROM session WHERE uuid = ANY($1)', [[session.uuid, other.uuid]]);
  },
);

/**
 * The two exclusions the §1.8-graded repeats need: an exact replay (same content
 * hash) and a re-send under the same transfer id never reach the observation.
 * Both are `IS DISTINCT FROM`, so a prior whose column is NULL survives — a
 * transmission that carried no transfer id is not a re-send of one that did.
 */
test('findPriorUnitWindows excludes same-hash and same-transferId priors', { skip }, async () => {
  const session = await createSession();
  const hash = createHash('sha256').update('same-bytes').digest();

  const replay = await insertTransmission({
    sessionUuid: session.uuid,
    transferId: 'T-1',
    contentHash: hash,
    schemaOk: true,
  });
  const novel = await insertTransmission({
    sessionUuid: session.uuid,
    transferId: 'T-9',
    contentHash: createHash('sha256').update('other-bytes').digest(),
    schemaOk: true,
  });
  const anonymous = await insertTransmission({ sessionUuid: session.uuid, schemaOk: true });

  const window = {
    unitKey: 'aser:sn-1',
    abstMin: at('2026-09-01T00:00:00Z'),
    abstMax: at('2026-09-01T06:00:00Z'),
    recordCount: 24,
  };
  for (const tx of [replay, novel, anonymous]) {
    await insertUnitWindows(tx.id, session.uuid, [window]);
  }

  const ids = async (opts: Parameters<typeof findPriorUnitWindows>[2]): Promise<Set<string>> =>
    new Set(
      (await findPriorUnitWindows(session.uuid, ['aser:sn-1'], opts)).map((r) => r.transmission_id),
    );

  assert.deepEqual(
    await ids({}),
    new Set([replay.id, novel.id, anonymous.id]),
    'no exclusions → every prior window',
  );
  assert.deepEqual(
    await ids({ excludeContentHash: hash }),
    new Set([novel.id, anonymous.id]),
    'the exact replay is dropped; the null-hash row is kept',
  );
  assert.deepEqual(
    await ids({ excludeTransferId: 'T-1' }),
    new Set([novel.id, anonymous.id]),
    'the repeated transfer id is dropped; the null-transferId row is kept',
  );
  assert.deepEqual(
    await ids({ excludeContentHash: hash, excludeTransferId: 'T-9' }),
    new Set([anonymous.id]),
    'both exclusions apply together',
  );

  await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
});

/**
 * The third exclusion, and the one no caller can switch off: a window whose
 * transmission the schema stage rejected is never a prior (agj.26). The ingest
 * route stopped writing those rows, so this is the belt beside that brace —
 * rows left by an older build, or by any future path that persists a window for
 * a body the service did not accept, still stay out of the comparison.
 */
test(
  'findPriorUnitWindows never returns a window from a rejected delivery (agj.26)',
  { skip },
  async () => {
    const session = await createSession();
    const window = {
      unitKey: 'aser:sn-1',
      abstMin: at('2026-09-01T00:00:00Z'),
      abstMax: at('2026-09-01T06:00:00Z'),
      recordCount: 24,
    };

    // One accepted delivery, one the schema stage rejected, and one that never
    // reached the schema stage at all (`schema_ok` NULL — a 400 or a 413).
    const accepted = await insertTransmission({ sessionUuid: session.uuid, schemaOk: true });
    const rejected = await insertTransmission({ sessionUuid: session.uuid, schemaOk: false });
    const ungraded = await insertTransmission({ sessionUuid: session.uuid });
    for (const tx of [accepted, rejected, ungraded]) {
      await insertUnitWindows(tx.id, session.uuid, [window]);
    }

    assert.deepEqual(
      (await findPriorUnitWindows(session.uuid, ['aser:sn-1'], {})).map((r) => r.transmission_id),
      [accepted.id],
      'only the delivery the schema accepted is a prior',
    );

    await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
  },
);

test('unit windows cascade-delete with their transmission (§11 retention)', { skip }, async () => {
  const session = await createSession();
  const tx = await insertTransmission({ sessionUuid: session.uuid });
  await insertUnitWindows(tx.id, session.uuid, [
    {
      unitKey: 'aser:sn-1',
      abstMin: at('2026-09-01T00:00:00Z'),
      abstMax: at('2026-09-01T06:00:00Z'),
      recordCount: 24,
    },
  ]);

  const count = async (): Promise<string | undefined> =>
    (
      await getPool().query<{ n: string }>(
        'SELECT count(*) AS n FROM transmission_unit_window WHERE transmission_id = $1',
        [tx.id],
      )
    ).rows[0]?.n;

  assert.equal(await count(), '1', 'window stored');
  await getPool().query('DELETE FROM transmission WHERE id = $1', [tx.id]);
  assert.equal(await count(), '0', 'window cascade-deleted with its transmission');

  await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
});

test(
  'purgeExpiredSessions deletes sessions inactive >7 days and cascades; recent survives (§11)',
  { skip },
  async () => {
    // OLD session: created_at and last_post_at both >7 days ago. Force the
    // timestamps into the past directly (createSession defaults them to now()).
    const oldSession = await createSession();
    await getPool().query(
      `UPDATE session
          SET created_at = now() - interval '14 days',
              last_post_at = now() - interval '8 days'
        WHERE uuid = $1`,
      [oldSession.uuid],
    );
    const oldTx = await insertTransmission({ sessionUuid: oldSession.uuid });
    await insertFinding(oldTx.id, { requirement: '1.4', severity: 'info', profile: '2025' });

    // OLD session with NO posts: last_post_at NULL, created_at >7 days ago.
    // Exercises the COALESCE fallback to created_at.
    const oldNoPosts = await createSession();
    await getPool().query(
      `UPDATE session SET created_at = now() - interval '20 days' WHERE uuid = $1`,
      [oldNoPosts.uuid],
    );

    // RECENT session: a post 6 days ago (inside the 7-day window) — survives.
    const recentSession = await createSession();
    await getPool().query(
      `UPDATE session
          SET created_at = now() - interval '60 days',
              last_post_at = now() - interval '6 days'
        WHERE uuid = $1`,
      [recentSession.uuid],
    );
    const recentTx = await insertTransmission({ sessionUuid: recentSession.uuid });

    const purged = await purgeExpiredSessions();
    assert.ok(purged >= 2, 'both expired sessions counted as purged');

    // Old sessions gone.
    assert.equal(await getSession(oldSession.uuid), null, 'old (posted) session purged');
    assert.equal(await getSession(oldNoPosts.uuid), null, 'old (no-posts) session purged');

    // Cascade: the old session's transmission and finding are gone too.
    const txRows = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM transmission WHERE id = $1',
      [oldTx.id],
    );
    assert.equal(txRows.rows[0]?.n, '0', 'transmission cascade-deleted');
    const fRows = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM finding WHERE transmission_id = $1',
      [oldTx.id],
    );
    assert.equal(fRows.rows[0]?.n, '0', 'finding cascade-deleted');

    // Recent session (and its transmission) untouched.
    const recent = await getSession(recentSession.uuid);
    assert.ok(recent, 'recent session survives the sweep');
    const recentTxRows = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM transmission WHERE id = $1',
      [recentTx.id],
    );
    assert.equal(recentTxRows.rows[0]?.n, '1', 'recent transmission untouched');

    await getPool().query('DELETE FROM session WHERE uuid = $1', [recentSession.uuid]);
  },
);

test.after(async () => {
  await closePool().catch(() => {});
});
