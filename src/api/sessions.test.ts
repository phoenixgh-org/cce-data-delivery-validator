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
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../app.js';
import { SchemaRegistry } from '../schema-registry.js';
import { closePool, getPool } from '../db/pool.js';
import { createSession, insertFinding, insertTransmission } from '../db/repository.js';
import { advisory } from '../ingest/stages/semantic/advisory.js';
import { sigKey } from './signatures.js';
import type { SignatureFinding } from './signatures.js';

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
      await insertFinding(older.id, {
        requirement: '1.4',
        severity: 'fail',
        detail: 'too big',
        code: 'tx.body_too_large',
      });

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
          findings: Array<{
            requirement: string;
            severity: string;
            keyword: string | null;
            instancePath: string | null;
            param: string | null;
            code: string | null;
          }>;
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
        {
          requirement: '1.2',
          severity: 'pass',
          detail: null,
          pointer: null,
          outdated: false,
          keyword: null,
          instancePath: null,
          param: null,
          code: null,
        },
      ]);
      assert.deepEqual(body.transmissions[1]?.findings, [
        {
          requirement: '1.4',
          severity: 'fail',
          detail: 'too big',
          pointer: null,
          outdated: false,
          keyword: null,
          instancePath: null,
          param: null,
          code: 'tx.body_too_large',
        },
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

/**
 * beads 3cq: the dashboard's schema-provenance line used to be a hardcoded
 * literal and once shipped a hash of nothing. It now renders THIS field, so the
 * response must carry the registered set with the hash the registry computed
 * over the vendored bytes at boot — asserted against a re-hash of those bytes,
 * never against a constant copied from the source (which is the bug returning).
 */
test(
  'GET /api/sessions/:uuid → schemas carry the registry-computed sha256 (3cq)',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    const session = await createSession();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/sessions/${session.uuid}` });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { schemas: Array<{ version: string; sha256: string }> };

      const registry = SchemaRegistry.load();
      assert.deepEqual(
        body.schemas,
        registry.provenance().map((p) => ({ version: p.version, sha256: p.sha256 })),
        'the response reports exactly the registered set',
      );
      assert.ok(body.schemas.length > 0, 'at least one schema is registered');

      for (const { version, sha256 } of body.schemas) {
        assert.match(sha256, /^[0-9a-f]{64}$/, `${version}: full lowercase-hex sha256`);
        const bytes = readFileSync(
          fileURLToPath(new URL(`../schemas/cce-interop-${version}.json`, import.meta.url)),
        );
        assert.equal(
          sha256,
          createHash('sha256').update(bytes).digest('hex'),
          `${version}: served hash is the hash of the vendored bytes`,
        );
      }
    } finally {
      await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
      await app.close();
    }
  },
);

test(
  'GET /api/sessions/:uuid → a §3.2 info(outdated) finding reports pass-outdated, not untested',
  { skip },
  async () => {
    // f2m: compliance-matrix.test.ts unit-tests deriveStatus, but the ONLY thing
    // that turns a real session's findings into its `outdatedByRequirement` input
    // is the tally line in sessions.ts. This is the end-to-end proof of 2kx's
    // user-visible claim — "a session using only an older-but-valid schema
    // version no longer displays as untested" — over the real DB → endpoint path.
    //
    // The finding is SEEDED rather than produced by a POST, which keeps this
    // test independent of the registry's SHAPE. A live payload can produce it —
    // 0.8.0 is registered as the outdated cohort again (798d12e, bd 8qa.4), and
    // src/ingest/stages/schema-stage.test.ts drives that path against the app's
    // own registry — but what is under test here is the tally line in
    // sessions.ts, not which versions the registry happens to carry, so the
    // fixture states the finding directly. The seed mirrors exactly what
    // src/ingest/stages/schema.ts emits on that path: severity 'info' (never a
    // pass, never a fail), `outdated` true, code 'tx.outdated_schema'.
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      const tx = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 120,
        contentType: 'application/json; charset=utf-8',
        httpStatus: 200,
        body: { meta: { transferId: 'T-outdated' } },
        rawBody: '{"meta":{"transferId":"T-outdated"}}',
        parseOk: true,
        schemaOk: true,
      });
      await insertFinding(tx.id, {
        requirement: '3.2',
        severity: 'info',
        outdated: true,
        detail: 'accepted, but validated against an OUTDATED schema (§3.2)',
        code: 'tx.outdated_schema',
      });

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(res.statusCode, 200);

      const body = res.json() as {
        transmissions: Array<{ findings: Array<{ outdated: boolean }> }>;
        summary: Array<{
          requirement: string;
          status: string;
          outdated: number;
          counts: { pass: number; fail: number; info: number };
        }>;
        rollup: { passing: number; failing: number; untested: number };
      };

      // The flag survives the FindingView projection the tally reads from.
      assert.equal(body.transmissions[0]?.findings[0]?.outdated, true, 'outdated reaches the wire');

      const row = body.summary.find((r) => r.requirement === '3.2');
      assert.ok(row, '§3.2 row present');
      assert.equal(row.status, 'pass-outdated', 'info+outdated grades pass-outdated, not untested');
      assert.equal(row.outdated, 1, 'the outdated tally counted the finding');
      assert.equal(row.counts.pass, 0, 'no pass finding was invented');
      assert.equal(row.counts.info, 1, 'the finding is still counted as info');

      // scope.ts rollup() folds pass-outdated into `passing` — the row must not
      // vanish from all three scorecard buckets.
      assert.equal(body.rollup.passing, 1, 'pass-outdated counts as passing in the rollup');
      assert.equal(body.rollup.failing, 0);
    } finally {
      if (uuid) {
        await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      }
      await app.close();
    }
  },
);

test(
  'GET /api/sessions/:uuid → per-tx findings ordered ascending by §-number (numeric, not lexical)',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      const tx = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 100,
        contentType: 'application/json; charset=utf-8',
        httpStatus: 200,
        body: { meta: { transferId: 'T-order' } },
        rawBody: '{"meta":{"transferId":"T-order"}}',
        parseOk: true,
        schemaOk: true,
      });

      // Insert OUT of section order, including a two-digit minor (1.10) so a plain
      // string sort (which ranks "1.10" < "1.2") would be visibly wrong.
      await insertFinding(tx.id, { requirement: '3.2', severity: 'pass' });
      await insertFinding(tx.id, { requirement: '1.10', severity: 'info' });
      await insertFinding(tx.id, { requirement: '1.2', severity: 'pass' });
      await insertFinding(tx.id, { requirement: '2.1', severity: 'fail' });

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        transmissions: Array<{ findings: Array<{ requirement: string }> }>;
      };

      const order = body.transmissions[0]?.findings.map((f) => f.requirement);
      assert.deepEqual(order, ['1.2', '1.10', '2.1', '3.2'], 'ascending by section number');
    } finally {
      if (uuid) {
        await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      }
      await app.close();
    }
  },
);

test('DELETE /api/sessions/:uuid/data → 404 for an unknown uuid', { skip }, async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${randomUUID()}/data` });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'not_found');
  } finally {
    await app.close();
  }
});

test(
  'DELETE /api/sessions/:uuid/data → wipes transmissions + findings, keeps the session alive',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      const tx = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 100,
        httpStatus: 200,
        body: { meta: { transferId: 'T-del' } },
        rawBody: '{"meta":{"transferId":"T-del"}}',
        parseOk: true,
        schemaOk: true,
      });
      await insertFinding(tx.id, { requirement: '1.2', severity: 'pass' });

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${uuid}/data` });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { uuid, deleted: { transmissions: 1 } });

      // Transmissions + findings gone (finding cascades off the transmission).
      const txRows = await getPool().query<{ n: string }>(
        'SELECT count(*) AS n FROM transmission WHERE session_uuid = $1',
        [uuid],
      );
      assert.equal(txRows.rows[0]?.n, '0', 'transmissions deleted');
      const fRows = await getPool().query<{ n: string }>(
        'SELECT count(*) AS n FROM finding WHERE transmission_id = $1',
        [tx.id],
      );
      assert.equal(fRows.rows[0]?.n, '0', 'findings cascade-deleted');

      // Session row survives, so the ingest URL keeps working.
      const sessionRows = await getPool().query<{ n: string }>(
        'SELECT count(*) AS n FROM session WHERE uuid = $1',
        [uuid],
      );
      assert.equal(sessionRows.rows[0]?.n, '1', 'session row kept alive');

      // The dashboard read now returns the empty state for the same endpoint.
      const after = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(after.statusCode, 200);
      assert.equal((after.json() as { transmissions: unknown[] }).transmissions.length, 0);

      // Re-deleting is an idempotent no-op (0 rows), still 200.
      const again = await app.inject({ method: 'DELETE', url: `/api/sessions/${uuid}/data` });
      assert.equal(again.statusCode, 200);
      assert.deepEqual(again.json(), { uuid, deleted: { transmissions: 0 } });
    } finally {
      if (uuid) {
        await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      }
      await app.close();
    }
  },
);

// ── GET /api/sessions/:uuid/transmissions (4h4.5 paginated/filterable list) ──

/** Insert a tx, then stamp its received_at so window/cursor ordering is exact. */
async function insertTxAt(uuid: string, receivedAtIso: string, transferSrc: string | null) {
  const tx = await insertTransmission({
    sessionUuid: uuid,
    wireBytes: 100,
    httpStatus: 200,
    transferSrc,
    body: { meta: {} },
    rawBody: '{"meta":{}}',
    parseOk: true,
    schemaOk: true,
  });
  await getPool().query('UPDATE transmission SET received_at = $2 WHERE id = $1', [
    tx.id,
    receivedAtIso,
  ]);
  return tx.id;
}

interface ListResp {
  transmissions: Array<{
    id: string;
    received_at: string;
    source: string;
    sourceCode: string;
    sourceLabel: string;
    findings: Array<{
      requirement: string;
      severity: string;
      keyword: string | null;
      instancePath: string | null;
      param: string | null;
      code: string | null;
      detail: string | null;
    }>;
  }>;
  scoped: number;
  nextCursor: string | null;
  hasMore: boolean;
}

test('GET …/transmissions → 404 for an unknown uuid', { skip }, async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${randomUUID()}/transmissions`,
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { error: string }).error, 'not_found');
  } finally {
    await app.close();
  }
});

test(
  'GET …/transmissions → reverse-chron page with inlined findings + cursor pagination',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      // 5 tx, 1 minute apart; t4 newest. Stamp deterministic timestamps.
      const base = Date.parse('2026-06-17T12:00:00.000Z');
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push(await insertTxAt(uuid, new Date(base + i * 60_000).toISOString(), 'org.kano'));
      }

      // Page 1 (limit 2): newest two (t4, t3), hasMore, a nextCursor.
      const p1 = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?limit=2`,
      });
      assert.equal(p1.statusCode, 200);
      const b1 = p1.json() as ListResp;
      assert.equal(b1.scoped, 5, 'scoped = all 5 (no filters)');
      assert.deepEqual(
        b1.transmissions.map((t) => t.id),
        [ids[4], ids[3]],
        'newest-first',
      );
      assert.equal(b1.hasMore, true);
      assert.ok(b1.nextCursor, 'nextCursor present when more pages remain');
      // Source dimension present on each row.
      assert.equal(b1.transmissions[0]?.source, 'org.kano');
      assert.equal(b1.transmissions[0]?.sourceCode, 'KAN');

      // Page 2: follow the cursor → t2, t1.
      const p2 = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?limit=2&cursor=${b1.nextCursor}`,
      });
      const b2 = p2.json() as ListResp;
      assert.deepEqual(
        b2.transmissions.map((t) => t.id),
        [ids[2], ids[1]],
        'second page continues reverse-chron',
      );
      assert.equal(b2.hasMore, true);

      // Page 3: the last row, no more.
      const p3 = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?limit=2&cursor=${b2.nextCursor}`,
      });
      const b3 = p3.json() as ListResp;
      assert.deepEqual(
        b3.transmissions.map((t) => t.id),
        [ids[0]],
        'final row',
      );
      assert.equal(b3.hasMore, false);
      assert.equal(b3.nextCursor, null, 'no nextCursor on the last page');
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

test(
  'GET …/transmissions → window bounds the candidate set; failuresOnly + source filter',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      const now = Date.now();
      // Within 15m (5m ago), with a FAIL, src "  org.kano " (untrimmed).
      const recentFail = await insertTxAt(
        uuid,
        new Date(now - 5 * 60_000).toISOString(),
        '  org.kano ',
      );
      await insertFinding(recentFail, { requirement: '1.4', severity: 'fail', code: 'tx.x' });
      // Within 15m, PASS only, unknown source (null).
      const recentPass = await insertTxAt(uuid, new Date(now - 6 * 60_000).toISOString(), null);
      await insertFinding(recentPass, { requirement: '1.2', severity: 'pass' });
      // OUTSIDE 15m (40m ago), fail — must be excluded by the window bound.
      const oldFail = await insertTxAt(uuid, new Date(now - 40 * 60_000).toISOString(), 'org.kano');
      await insertFinding(oldFail, { requirement: '1.4', severity: 'fail', code: 'tx.x' });

      // window=15m → only the two recent tx are candidates.
      const w = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?window=15m`,
      });
      const bw = w.json() as ListResp;
      assert.equal(bw.scoped, 2, 'old tx excluded by the 15m window bound');
      assert.ok(!bw.transmissions.some((t) => t.id === oldFail));

      // failuresOnly → only the recent fail.
      const f = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?window=15m&failuresOnly=true`,
      });
      const bf = f.json() as ListResp;
      assert.deepEqual(
        bf.transmissions.map((t) => t.id),
        [recentFail],
      );
      assert.equal(bf.scoped, 1);

      // source filter: the TRIMMED key matches (deriveSourceView trims transfer_src).
      const s = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?window=15m&source=org.kano`,
      });
      const bs = s.json() as ListResp;
      assert.deepEqual(
        bs.transmissions.map((t) => t.id),
        [recentFail],
        'trimmed key matches',
      );

      // unknown bucket (source=empty key) selects the null-source tx.
      const u = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?window=15m&source=`,
      });
      const bu = u.json() as ListResp;
      assert.deepEqual(
        bu.transmissions.map((t) => t.id),
        [recentPass],
        'unknown bucket selected',
      );
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

test(
  'GET …/transmissions → signatureKey filter EQUALS txMatchesSig/sigKey on a fixture',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      // Two tx share one schema signature (same keyword+path+param, different
      // array index — generalized away); a third carries an unrelated check code.
      const schemaFinding = (instancePath: string): SignatureFinding => ({
        requirement: '3.2',
        severity: 'fail',
        detail: null,
        pointer: null,
        outdated: false,
        keyword: 'required',
        instancePath,
        param: 'ABST',
        code: null,
      });

      const txA = await insertTxAt(uuid, new Date(Date.now() - 3 * 60_000).toISOString(), 'src');
      await insertFinding(txA, {
        requirement: '3.2',
        severity: 'fail',
        keyword: 'required',
        instancePath: '/data/0',
        param: 'ABST',
      });
      const txB = await insertTxAt(uuid, new Date(Date.now() - 2 * 60_000).toISOString(), 'src');
      await insertFinding(txB, {
        requirement: '3.2',
        severity: 'fail',
        keyword: 'required',
        instancePath: '/data/7', // different index → SAME generalized sigKey as txA
        param: 'ABST',
      });
      const txC = await insertTxAt(uuid, new Date(Date.now() - 1 * 60_000).toISOString(), 'src');
      await insertFinding(txC, { requirement: '1.4', severity: 'fail', code: 'tx.body_too_large' });

      // The expected key comes from signatures.ts sigKey — NOT a re-impl here.
      const key = sigKey(schemaFinding('/data/*'));

      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?signatureKey=${encodeURIComponent(key)}`,
      });
      const body = res.json() as ListResp;
      // Exactly txA + txB match the signature; txC (different sig) excluded.
      assert.deepEqual(
        body.transmissions.map((t) => t.id).sort(),
        [txA, txB].sort(),
        'signatureKey membership equals txMatchesSig/sigKey',
      );
      assert.equal(body.scoped, 2, 'scoped denominator is post-signatureKey-filter');
      // Findings are inlined per row for the docked detail pane.
      assert.ok(body.transmissions[0]?.findings.length >= 1, 'findings inlined per row');
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

test(
  'GET …/transmissions → signatureKey selects an OUTDATED-schema info finding (§3.2 soft issue)',
  { skip },
  async () => {
    // Guards the outdated soft-issue path: the §3.2 outdated-but-valid finding is
    // severity=info + outdated=true, which isIssue() counts and txMatchesSig must
    // match — even though it is NOT a 'fail'. A regression that dropped the
    // info+outdated branch would silently exclude these tx from a signatureKey
    // cross-filter; this pins it.
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      // The outdated-schema signature keys off `code` (no schema keyword):
      // sigKey = '3.2|tx.outdated_schema'. Built from signatures.ts sigKey, NOT a
      // re-impl.
      const outdatedFinding: SignatureFinding = {
        requirement: '3.2',
        severity: 'info',
        detail: null,
        pointer: null,
        outdated: true,
        keyword: null,
        instancePath: null,
        param: null,
        code: 'tx.outdated_schema',
      };
      const key = sigKey(outdatedFinding);

      // txHit carries the info+outdated finding; txMiss carries a plain info
      // finding (outdated=false → NOT an issue → excluded).
      const txHit = await insertTxAt(uuid, new Date(Date.now() - 2 * 60_000).toISOString(), 'src');
      await insertFinding(txHit, {
        requirement: '3.2',
        severity: 'info',
        outdated: true,
        code: 'tx.outdated_schema',
      });
      const txMiss = await insertTxAt(uuid, new Date(Date.now() - 1 * 60_000).toISOString(), 'src');
      await insertFinding(txMiss, {
        requirement: '3.2',
        severity: 'info',
        outdated: false,
        code: 'tx.outdated_schema',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?signatureKey=${encodeURIComponent(key)}`,
      });
      const body = res.json() as ListResp;
      assert.deepEqual(
        body.transmissions.map((t) => t.id),
        [txHit],
        'signatureKey selects the outdated-schema info tx (info+outdated isIssue), excludes the non-outdated info tx',
      );
      assert.equal(body.scoped, 1, 'scoped denominator counts only the outdated soft-issue tx');
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

/* ── Advisories: the round trip, and matrix immunity through the REAL read path
 * (pwd / bva slice A) ────────────────────────────────────────────────────────
 *
 * src/api/compliance-matrix.test.ts pins the pure join. This pins the whole
 * path a supplier actually sees: an advisory built by the emission helper is
 * persisted as an ordinary `finding` row (NO DDL — `finding.requirement` is
 * plain `text`), read back through GET /api/sessions/:uuid, and shown to leave
 * every scope-relative aggregate in that response untouched — the 27-row §7
 * summary, the gradeable rollup, the pass trend and the scope totals alike.
 *
 * The session is seeded 100% CONFORMANT first (a pass on all ten gradeable §7
 * rows), because that is pwd's acceptance sentence: a supplier at 100% must
 * still be able to carry advisories. */

/** The ten gradeable §7 rows (primary class ✅ verified or 🟡 heuristic). */
const GRADEABLE_REQUIREMENTS = [
  '1.1',
  '1.2',
  '1.3',
  '1.4',
  '1.6',
  '1.8',
  '2.1',
  '3.1',
  '3.2',
  '3.4',
];

test(
  'GET /api/sessions/:uuid → advisories round-trip and move NOTHING in the §7 read path',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      const tx = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 4096,
        contentType: 'application/json; charset=utf-8',
        httpStatus: 200,
        body: { meta: { transferId: 'T-adv' } },
        rawBody: '{"meta":{"transferId":"T-adv"}}',
        parseOk: true,
        schemaOk: true,
      });

      // A fully conformant supplier: every gradeable row green.
      for (const requirement of GRADEABLE_REQUIREMENTS) {
        await insertFinding(tx.id, { requirement, severity: 'pass' });
      }

      interface AdvResp {
        transmissions: Array<{
          findings: Array<{
            requirement: string;
            severity: string;
            detail: string | null;
            pointer: string | null;
            outdated: boolean;
            code: string | null;
          }>;
        }>;
        summary: Array<{ requirement: string; status: string; counts: unknown; outdated: number }>;
        rollup: unknown;
        trend: unknown;
        scoped: unknown;
        signatures: unknown[];
      }

      const first = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(first.statusCode, 200);
      const before = first.json() as AdvResp;

      assert.deepEqual(
        before.rollup,
        { total: 27, gradeable: 10, passing: 10, failing: 0, untested: 0 },
        'the seeded session really is 100% conformant',
      );

      // Now raise advisories on that same transmission, built ONLY through the
      // emission helper — the shape under test is the one production emits.
      const advisories = [
        advisory({
          id: 'adv.null_identity',
          // Verbatim current output of the ems branch of nullIdentityCheck (1o64):
          // the advisory reads ASER alone there, and never claims the report names
          // no appliance at all.
          detail:
            '1 of 1 report in this transmission carries no appliance serial number — ASER is ' +
            "null. ASER is the serial number the appliance's manufacturer assigned, and " +
            'nothing else on an ems-report stands in for it: an ems-report has no AMID ' +
            'property, AID is an asset identifier a programme assigns, and ESER and LSER name ' +
            'the monitoring device and the logger rather than the appliance they watch. The ' +
            '480 records under it arrive complete and fully conformant, and the country ' +
            "receiving them cannot tie those readings to the appliance by its manufacturer's " +
            'serial number.',
          pointer: '/data/0',
        }),
        advisory({
          id: 'adv.null_padding',
          detail:
            'TCON was null in all 480 records of this transmission — if the equipment has ' +
            'no condenser sensor, omitting the property communicates that more clearly ' +
            'than sending null, and costs you bytes against the 1 MB limit',
          pointer: '/data/0/records/0/TCON',
        }),
      ];
      for (const f of advisories) await insertFinding(tx.id, f);

      const second = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(second.statusCode, 200);
      const after = second.json() as AdvResp;

      // ── THE PIN: every verdict-bearing aggregate is unchanged. ──────────────
      assert.deepEqual(after.summary, before.summary, 'the §7 matrix moved');
      assert.deepEqual(after.rollup, before.rollup, 'the gradeable rollup moved');
      assert.deepEqual(after.trend, before.trend, 'the pass-rate trend moved');
      assert.deepEqual(after.scoped, before.scoped, 'the scope totals moved');
      assert.deepEqual(after.signatures, before.signatures, 'an advisory entered the issue list');
      assert.deepEqual(after.signatures, [], 'a conformant session has no distinct issues');

      // ── the round trip itself: the advisories came back intact. ─────────────
      const returned = after.transmissions[0]?.findings.filter((f) =>
        f.requirement.startsWith('adv.'),
      );
      assert.equal(returned?.length, 2, 'both advisories persisted and read back');
      for (const f of returned ?? []) {
        assert.equal(f.severity, 'info', 'advisories are always info');
        assert.equal(f.code, f.requirement, 'code carries the same adv.* id');
        assert.equal(f.outdated, false, 'never outdated — an advisory is not a defect');
        assert.ok(f.pointer?.startsWith('/data/0'), 'pointer survives for the drill-down');
        assert.ok((f.detail?.length ?? 0) > 0, 'the observation travels with the finding');
      }
      // No advisory leaked into the §7 findings, and none was dropped.
      assert.equal(after.transmissions[0]?.findings.length, GRADEABLE_REQUIREMENTS.length + 2);
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

test.after(async () => {
  await closePool().catch(() => {});
});
