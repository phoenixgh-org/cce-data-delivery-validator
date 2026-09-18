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
import {
  createSession,
  insertFinding,
  insertTransmission,
  type InsertFindingInput,
} from '../db/repository.js';
import { stampProfiles, type Finding } from '../ingest/pipeline.js';
import { advisory } from '../ingest/stages/semantic/advisory.js';
import { sigKey } from './signatures.js';
import type { SignatureFinding } from './signatures.js';

/**
 * Stamp a stage-emitted finding for storage exactly as `src/ingest/route.ts` does
 * (by1c.50). A semantic advisory carries no profile — only the schema stage
 * stamps one — and the repository has no default, so the test goes through the
 * production stamp rather than hard-coding a lineage the route would pick.
 */
function stamped(f: Finding): InsertFindingInput {
  return stampProfiles([f])[0]!;
}

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
        profile: '2025',
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
      await insertFinding(newer.id, { requirement: '1.2', severity: 'pass', profile: '2025' });

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
          summary: null,
          detail: null,
          pointer: null,
          outdated: false,
          keyword: null,
          instancePath: null,
          param: null,
          code: null,
          profile: '2025',
        },
      ]);
      assert.deepEqual(body.transmissions[1]?.findings, [
        {
          requirement: '1.4',
          severity: 'fail',
          // The advisory observation line (agj.17) — null on a graded finding.
          summary: null,
          detail: 'too big',
          pointer: null,
          outdated: false,
          keyword: null,
          instancePath: null,
          param: null,
          code: 'tx.body_too_large',
          profile: '2025',
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
      const body = res.json() as {
        schemas: Array<{ version: string; sha256: string; profile: string; draftDate?: string }>;
      };

      const registry = SchemaRegistry.load();
      // Compared against the provenance list WHOLE — profile and draftDate
      // included — because the dashboard now selects on those: the registered set
      // spans two lineages, and a response that dropped `profile` would leave the
      // Setup panel unable to tell the contract cohort from the shadow draft.
      assert.deepEqual(
        body.schemas,
        JSON.parse(JSON.stringify(registry.provenance())),
        'the response reports exactly the registered set',
      );
      assert.ok(body.schemas.length > 0, 'at least one schema is registered');

      for (const { version, sha256 } of body.schemas) {
        assert.match(sha256, /^[0-9a-f]{64}$/, `${version}: full lowercase-hex sha256`);
        const file =
          version === '1' ? 'pqs-e006-ds01-annex4-1.json' : `cce-interop-${version}.json`;
        const bytes = readFileSync(fileURLToPath(new URL(`../schemas/${file}`, import.meta.url)));
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
        profile: '2025',
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
      await insertFinding(tx.id, { requirement: '3.2', severity: 'pass', profile: '2025' });
      await insertFinding(tx.id, { requirement: '1.10', severity: 'info', profile: '2025' });
      await insertFinding(tx.id, { requirement: '1.2', severity: 'pass', profile: '2025' });
      await insertFinding(tx.id, { requirement: '2.1', severity: 'fail', profile: '2025' });

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
      await insertFinding(tx.id, { requirement: '1.2', severity: 'pass', profile: '2025' });

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
      await insertFinding(recentFail, {
        requirement: '1.4',
        severity: 'fail',
        code: 'tx.x',
        profile: '2025',
      });
      // Within 15m, PASS only, unknown source (null).
      const recentPass = await insertTxAt(uuid, new Date(now - 6 * 60_000).toISOString(), null);
      await insertFinding(recentPass, { requirement: '1.2', severity: 'pass', profile: '2025' });
      // OUTSIDE 15m (40m ago), fail — must be excluded by the window bound.
      const oldFail = await insertTxAt(uuid, new Date(now - 40 * 60_000).toISOString(), 'org.kano');
      await insertFinding(oldFail, {
        requirement: '1.4',
        severity: 'fail',
        code: 'tx.x',
        profile: '2025',
      });

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
        // The contract lineage — the key the ?signatureKey= filter carries (by1c.7).
        profile: '2025',
      });

      const txA = await insertTxAt(uuid, new Date(Date.now() - 3 * 60_000).toISOString(), 'src');
      await insertFinding(txA, {
        requirement: '3.2',
        severity: 'fail',
        keyword: 'required',
        instancePath: '/data/0',
        param: 'ABST',
        profile: '2025',
      });
      const txB = await insertTxAt(uuid, new Date(Date.now() - 2 * 60_000).toISOString(), 'src');
      await insertFinding(txB, {
        requirement: '3.2',
        severity: 'fail',
        keyword: 'required',
        instancePath: '/data/7', // different index → SAME generalized sigKey as txA
        param: 'ABST',
        profile: '2025',
      });
      const txC = await insertTxAt(uuid, new Date(Date.now() - 1 * 60_000).toISOString(), 'src');
      await insertFinding(txC, {
        requirement: '1.4',
        severity: 'fail',
        code: 'tx.body_too_large',
        profile: '2025',
      });

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
      // sigKey = '2025|3.2|tx.outdated_schema'. Built from signatures.ts sigKey,
      // NOT a re-impl.
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
        profile: '2025',
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
        profile: '2025',
      });
      const txMiss = await insertTxAt(uuid, new Date(Date.now() - 1 * 60_000).toISOString(), 'src');
      await insertFinding(txMiss, {
        requirement: '3.2',
        severity: 'info',
        outdated: false,
        code: 'tx.outdated_schema',
        profile: '2025',
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

test(
  'GET …/transmissions → an ADVISORY signatureKey selects a zero-failure tx (failuresOnly false)',
  { skip },
  async () => {
    // The agj.15 acceptance: an advisory key drives the SAME ?signatureKey=
    // cross-filter, and selecting one implies NOTHING about failures — a fully
    // conformant transmission that merely carries an observation is a hit.
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      // The expected key comes from signatures.ts sigKey — NOT a re-impl here.
      const advisoryFinding: SignatureFinding = {
        requirement: 'adv.null_padding',
        severity: 'info',
        detail: null,
        pointer: null,
        outdated: false,
        keyword: null,
        instancePath: null,
        param: null,
        code: 'adv.null_padding',
        // Carried but unused: an advisory key never names a lineage (by1c.7).
        profile: '2025',
      };
      const key = sigKey(advisoryFinding);
      assert.equal(key, 'adv|adv.null_padding', 'advisory keys are adv|<adv.id>');

      // txClean: ZERO failures — a §3.2 pass plus one advisory, built through the
      // production emission helper so the persisted shape is the real one.
      const txClean = await insertTxAt(
        uuid,
        new Date(Date.now() - 3 * 60_000).toISOString(),
        'src',
      );
      await insertFinding(txClean, { requirement: '3.2', severity: 'pass', profile: '2025' });
      await insertFinding(
        txClean,
        stamped(
          advisory({
            id: 'adv.null_padding',
            summary: 'TCON is null in every one of the 480 records that carry it.',
            detail:
              'A property the device never populates is better omitted than sent as null, ' +
              'unless the record schema requires it.',
            pointer: '/data/0/records/0/TCON',
          }),
        ),
      );

      // txOther: a real failure, and a DIFFERENT advisory — matches neither
      // the selected advisory key nor (below) an unrelated one.
      const txOther = await insertTxAt(
        uuid,
        new Date(Date.now() - 2 * 60_000).toISOString(),
        'src',
      );
      await insertFinding(txOther, {
        requirement: '1.4',
        severity: 'fail',
        code: 'tx.body_too_large',
        profile: '2025',
      });
      await insertFinding(
        txOther,
        stamped(
          advisory({
            id: 'adv.sample_gap',
            summary: '1 gap between consecutive readings exceeds the 900 s period.',
            detail: 'Recording gaps have everyday causes, such as an extended power outage.',
            pointer: '/data/0',
          }),
        ),
      );

      const res = await app.inject({
        method: 'GET',
        url:
          `/api/sessions/${uuid}/transmissions?signatureKey=${encodeURIComponent(key)}` +
          '&failuresOnly=false',
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as ListResp;
      assert.deepEqual(
        body.transmissions.map((t) => t.id),
        [txClean],
        'the advisory key selects the zero-failure transmission',
      );
      assert.equal(body.scoped, 1, 'scoped denominator counts the advisory-only tx');
      assert.ok(
        body.transmissions[0]?.findings.some((f) => f.requirement === 'adv.null_padding'),
        'the advisory travels inlined with the row',
      );
      assert.ok(
        !body.transmissions[0]?.findings.some((f) => f.severity === 'fail'),
        'the selected transmission really has no failures',
      );

      // The other advisory selects the other transmission — advisories do not
      // collapse into one another.
      const other = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}/transmissions?signatureKey=${encodeURIComponent('adv|adv.sample_gap')}`,
      });
      assert.deepEqual(
        (other.json() as ListResp).transmissions.map((t) => t.id),
        [txOther],
        'a different advisory key selects a different transmission',
      );

      // failuresOnly=true still means what it says: the advisory-only tx has no
      // failure, so the two filters compose rather than one implying the other.
      const strict = await app.inject({
        method: 'GET',
        url:
          `/api/sessions/${uuid}/transmissions?signatureKey=${encodeURIComponent(key)}` +
          '&failuresOnly=true',
      });
      assert.deepEqual(
        (strict.json() as ListResp).transmissions.map((t) => t.id),
        [],
        'failuresOnly=true excludes the zero-failure advisory tx',
      );
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
 * summary, the gradeable rollup and the scope totals alike.
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
        await insertFinding(tx.id, { requirement, severity: 'pass', profile: '2025' });
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
        scoped: unknown;
        signatures: Array<{ key: string; req: string; kind: string; sev: string; title: string }>;
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
          // The ems branch of nullIdentityCheck as it reads today (1o64, agj.17):
          // the advisory reads ASER alone there, and never claims the report names
          // no appliance at all.
          id: 'adv.null_identity',
          summary: '1 of 1 report carries no appliance serial number — ASER is null.',
          detail:
            'ASER is the appliance serial number, as assigned by the manufacturer. No other ' +
            'ID is an adequate substitute. Without this attribute, the receiving country ' +
            'cannot tie the records to the appliance.',
          pointer: '/data/0',
        }),
        advisory({
          id: 'adv.null_padding',
          summary: 'TCON is null in every one of the 480 records that carry it.',
          detail:
            'A property the device never populates is better omitted than sent as null, ' +
            'unless the record schema requires it.',
          pointer: '/data/0/records/0/TCON',
        }),
      ];
      for (const f of advisories) await insertFinding(tx.id, stamped(f));

      const second = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(second.statusCode, 200);
      const after = second.json() as AdvResp;

      // ── THE PIN: every verdict-bearing aggregate is unchanged. ──────────────
      assert.deepEqual(after.summary, before.summary, 'the §7 matrix moved');
      assert.deepEqual(after.rollup, before.rollup, 'the gradeable rollup moved');
      assert.deepEqual(after.scoped, before.scoped, 'the scope totals moved');
      // `scoped` covers the distinctIssues headline: advisories now fold into the
      // signature set (agj.15) but issueSignatures() keeps them out of that count.
      assert.deepEqual(
        after.signatures.filter((sig) => sig.kind !== 'advisory'),
        before.signatures.filter((sig) => sig.kind !== 'advisory'),
        'an advisory entered the ISSUE half of the signature list',
      );
      assert.deepEqual(
        after.signatures.filter((sig) => sig.kind !== 'advisory'),
        [],
        'a conformant session has no distinct issues',
      );
      assert.equal(before.signatures.length, 0, 'no signatures before the advisories were raised');

      // ── agj.15: the advisories DO ship as signatures, so the dashboard can
      // drive the ?signatureKey= cross-filter from one. Keyed adv|<adv.id>,
      // req '' (no §7 row), sev 'info', title derived from the id.
      const advSigs = after.signatures.filter((sig) => sig.kind === 'advisory');
      assert.deepEqual(
        advSigs.map((sig) => sig.key).sort(),
        ['adv|adv.null_identity', 'adv|adv.null_padding'],
        'both advisories folded into one signature each',
      );
      for (const sig of advSigs) {
        assert.equal(sig.req, '', 'an advisory signature claims no requirement');
        assert.equal(sig.sev, 'info', 'an advisory signature is always info');
        assert.match(sig.title, /^[A-Z]/, 'title is the derived human label, not a raw id');
      }

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

test(
  'GET /api/sessions/:uuid → scoped.units counts distinct CCE units in the scope (p98)',
  { skip },
  async () => {
    // The end-to-end shape of the p98 headline: the two numbers ship on the
    // SUMMARY `scoped` object, they are folded off the stored bodies, and they
    // move with the source filter exactly like every other scope-relative
    // number. No grading input is involved — units are profile-independent.
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;
      const post = async (transferSrc: string, data: unknown[]) => {
        const body = { meta: { transferSrc }, data };
        await insertTransmission({
          sessionUuid: uuid!,
          wireBytes: 100,
          httpStatus: 200,
          transferSrc,
          body,
          rawBody: JSON.stringify(body),
          parseOk: true,
          schemaOk: true,
        });
      };
      // One source: two reports on one appliance plus a second appliance.
      await post('org.kano', [{ AMID: 'fridge-1' }, { AMID: 'fridge-1' }, { AMID: 'fridge-2' }]);
      // Another: an EMS report keyed on ASER, and one that names nothing.
      await post('org.lagos', [{ AMFR: 'Alpha', ASER: 'sn-1' }, { ASER: null }]);

      type UnitResp = { scoped: { units: number; unidentifiedReports: number } };
      const all = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(all.statusCode, 200);
      assert.deepEqual(
        (all.json() as UnitResp).scoped,
        { scoped: 2, withFailures: 0, distinctIssues: 0, units: 3, unidentifiedReports: 1 },
        'three appliances across two transmissions, one report naming none',
      );

      const kano = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuid}?source=org.kano`,
      });
      const scopedKano = (kano.json() as UnitResp).scoped;
      assert.equal(scopedKano.units, 2, 'the unit count follows the source filter');
      assert.equal(scopedKano.unidentifiedReports, 0, 'so does the unidentified count');
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

test(
  'GET /api/sessions/:uuid → distinctIssues counts CONTRACT signatures only (by1c.7)',
  { skip },
  async () => {
    // The shadow run grades the same payload against DS01.3 and writes 'ds013'
    // findings beside the contract ones. They belong in the signature list — a
    // supplier wants to see them — but never in the headline defect count, which
    // grades the obligations in force.
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;
      const tx = await insertTxAt(uuid, new Date().toISOString(), 'org.kano');
      await insertFinding(tx, {
        requirement: '3.2',
        severity: 'fail',
        keyword: 'required',
        instancePath: '/data/0',
        param: 'ABST',
        profile: '2025',
      });
      await insertFinding(tx, {
        requirement: '5.3.2',
        severity: 'fail',
        keyword: 'required',
        instancePath: '/data/0',
        param: 'LSER',
        profile: 'ds013',
      });

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        scoped: { distinctIssues: number };
        signatures: Array<{ key: string; profile: string | null }>;
      };

      // Both lineages fold, disjointly, and each signature says which it is.
      assert.deepEqual(
        body.signatures.map((sig) => sig.key).sort(),
        ['2025|3.2|required|/data/*|ABST', 'ds013|5.3.2|required|/data/*|LSER'],
        'the two lineages fold into two signatures',
      );
      assert.equal(body.scoped.distinctIssues, 1, 'the headline counts the contract defect alone');
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

// ── by1c.9: shadow profile, per-profile verdicts, readiness ─────────────────
//
// The session read now says WHICH LINEAGE it means everywhere it grades: which
// profile is the contract, which one is shadowed, what bytes that shadow is, a
// verdict per lineage on every transmission, and how much of the conformant
// traffic in scope would survive the shadow lineage. These tests pin the three
// cases the dashboard has to render — a service with no shadow registered, a
// transmission that conforms today but not under DS01.3, and one whose declared
// version belongs to no lineage at all — plus the invariant underneath them all:
// a shadow finding moves nothing the supplier is graded on today.

/** The shadow-aware half of the summary read (by1c.9). */
interface ShadowResp {
  session: {
    uuid: string;
    contractProfile: string;
    shadowProfile: string | null;
  };
  transmissions: Array<{
    id: string;
    schema_version: string | null;
    verdicts: Record<string, 'pass' | 'fail' | null>;
    primaryProfile: string | null;
  }>;
  summary: Array<{ requirement: string; counts: FindingCounts; status: string }>;
  signatures: Array<{ key: string; profile: string | null; sev: string }>;
  shadow: { version: string; sha256: string; draftDate?: string } | null;
  readiness: {
    passingContract: number;
    passingBoth: number;
    reasons: Array<{ key: string; profile: string | null; sev: string; txCount: number }>;
  } | null;
}

interface FindingCounts {
  pass: number;
  fail: number;
  info: number;
}

/** A 5.3.2 shadow failure: an Annex 4 required property the payload omits. */
function missingUnderAnnex4(param: string) {
  return {
    requirement: '5.3.2',
    severity: 'fail' as const,
    keyword: 'required',
    instancePath: '/data/0',
    param,
    profile: 'ds013' as const,
    detail: `Annex 4 requires ${param}`,
  };
}

test(
  'GET /api/sessions/:uuid → a contract-passing transmission that fails DS01.3 (by1c.9)',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;

      // Two transmissions, one conformant today and one not. Both would fail the
      // DS01.3 draft, which is exactly the distinction readiness draws.
      const passing = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 100,
        httpStatus: 200,
        schemaVersion: '0.8.1',
        body: { meta: {} },
        rawBody: '{"meta":{}}',
        parseOk: true,
        schemaOk: true,
      });
      await insertFinding(passing.id, { requirement: '1.2', severity: 'pass', profile: '2025' });

      const failing = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 100,
        httpStatus: 422,
        schemaVersion: '0.8.1',
        body: { meta: {} },
        rawBody: '{"meta":{}}',
        parseOk: true,
        schemaOk: false,
      });
      await insertFinding(failing.id, {
        requirement: '3.2',
        severity: 'fail',
        keyword: 'required',
        instancePath: '/data/0',
        param: 'ABST',
        profile: '2025',
      });

      // The contract-only baseline: what the supplier is graded on today.
      const before = (
        await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` })
      ).json() as ShadowResp;
      assert.equal(before.summary.length, 27, 'all 27 §7 rows present');

      // Now the shadow run's findings land beside them, plus an advisory — which
      // is an observation about a conformant payload, never a readiness reason.
      await insertFinding(passing.id, missingUnderAnnex4('LSER'));
      await insertFinding(
        passing.id,
        stamped(
          advisory({
            id: 'adv.null_padding',
            summary: 'TCON is null in every record that carries it.',
            detail:
              'A property the device never populates is better omitted than sent as null, ' +
              'unless the record schema requires it.',
            pointer: '/data/0/records/0/TCON',
          }),
        ),
      );
      await insertFinding(failing.id, missingUnderAnnex4('LMFR'));

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(res.statusCode, 200);
      const body = res.json() as ShadowResp;

      // ── which lineage is which, straight off the registry ───────────────────
      assert.equal(body.session.contractProfile, '2025');
      assert.equal(body.session.shadowProfile, 'ds013');
      const shadowEntry = SchemaRegistry.load().shadowFor('2025');
      assert.deepEqual(body.shadow, {
        version: shadowEntry?.version,
        sha256: shadowEntry?.sha256,
        draftDate: shadowEntry?.draftDate,
      });
      assert.match(body.shadow?.draftDate ?? '', /^\d{4}-\d{2}-\d{2}$/, 'a draft date, not a name');

      // ── a verdict per lineage, keyed by profile id ──────────────────────────
      const byId = new Map(body.transmissions.map((t) => [t.id, t]));
      assert.deepEqual(
        byId.get(passing.id)?.verdicts,
        { '2025': 'pass', ds013: 'fail' },
        'conforms today, would not under DS01.3',
      );
      assert.deepEqual(byId.get(failing.id)?.verdicts, { '2025': 'fail', ds013: 'fail' });
      assert.equal(byId.get(passing.id)?.primaryProfile, '2025', 'a 0.8.1 declaration is 2025');

      // ── the 27-row matrix is UNMOVED by the shadow findings ─────────────────
      assert.deepEqual(body.summary, before.summary, 'a ds013 finding moved a §7 row');
      // The §7 matrix carries its own 5.1/5.2/5.3 retransmission rows, so the
      // point is not that "5.x" is absent — it is that the DS01.3 clause id is,
      // and that the neighbouring 5.3 row did not absorb it.
      assert.equal(
        body.summary.some((row) => row.requirement === '5.3.2'),
        false,
        'a DS01.3 clause id reached the §7 matrix',
      );
      assert.deepEqual(
        body.summary.find((row) => row.requirement === '5.3')?.counts,
        { pass: 0, fail: 0, info: 0 },
        'the §7 5.3 row absorbed a 5.3.2 shadow finding',
      );

      // ── the shadow signatures ride the wire, each naming its lineage ────────
      const shadowSigs = body.signatures.filter((sig) => sig.profile === 'ds013');
      assert.deepEqual(
        shadowSigs.map((sig) => sig.key).sort(),
        ['ds013|5.3.2|required|/data/*|LMFR', 'ds013|5.3.2|required|/data/*|LSER'],
        'both shadow failures fold, profile-prefixed and disjoint from 2025',
      );

      // ── readiness over the scope: one tx conforms today, none would survive ─
      assert.equal(body.readiness?.passingContract, 1);
      assert.equal(body.readiness?.passingBoth, 0);
      assert.deepEqual(
        body.readiness?.reasons.map((r) => r.key),
        ['ds013|5.3.2|required|/data/*|LSER'],
        'only the contract-passing transmission contributes a reason',
      );
      assert.equal(
        body.readiness?.reasons.some((r) => r.key.startsWith('adv|') || r.sev !== 'fail'),
        false,
        'an advisory is never a readiness reason',
      );
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

test(
  'GET /api/sessions/:uuid → a 1.0.0-declaring transmission has no lineage to shadow (by1c.9)',
  { skip },
  async () => {
    // `1.0.0` is a well-formed semver that no lineage registers, so §3.2 rejects
    // it and the shadow validator never runs: the contract verdict is 'fail' and
    // the shadow verdict is null — "not measured", not "would fail".
    const app = makeApp();
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;
      const tx = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 100,
        httpStatus: 422,
        schemaVersion: '1.0.0',
        body: { meta: { schemaVersion: '1.0.0' } },
        rawBody: '{"meta":{"schemaVersion":"1.0.0"}}',
        parseOk: true,
        schemaOk: false,
      });
      await insertFinding(tx.id, {
        requirement: '3.2',
        severity: 'fail',
        code: 'schema.unsupported_version',
        detail: 'unsupported schemaVersion 1.0.0',
        profile: '2025',
      });

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(res.statusCode, 200);
      const body = res.json() as ShadowResp;

      assert.deepEqual(body.transmissions[0]?.verdicts, { '2025': 'fail', ds013: null });
      assert.equal(
        body.transmissions[0]?.primaryProfile,
        null,
        'a version outside both lineages resolves to no primary profile',
      );
      assert.deepEqual(
        body.readiness,
        { passingContract: 0, passingBoth: 0, reasons: [] },
        'nothing conforms today, so there is nothing to be ready with',
      );
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

test(
  'GET /api/sessions/:uuid → a registry with one lineage reports no shadow at all (by1c.9)',
  { skip },
  async () => {
    // The flip-point test: with only the contract lineage registered there is
    // nothing to shadow, and all three shadow surfaces go dark off one null.
    // Built with a synthetic registry rather than by touching the real one —
    // `loadFrom` exists for exactly this (src/schema-registry.ts).
    const app = buildApp({
      logger: false,
      registry: SchemaRegistry.loadFrom([
        {
          version: '0.8.1',
          file: './schemas/cce-interop-0.8.1.json',
          dialect: '2020-12',
          profile: '2025',
        },
      ]),
    });
    await app.ready();
    let uuid: string | undefined;
    try {
      const session = await createSession();
      uuid = session.uuid;
      const tx = await insertTransmission({
        sessionUuid: uuid,
        wireBytes: 100,
        httpStatus: 200,
        schemaVersion: '0.8.1',
        body: { meta: {} },
        rawBody: '{"meta":{}}',
        parseOk: true,
        schemaOk: true,
      });
      await insertFinding(tx.id, { requirement: '1.2', severity: 'pass', profile: '2025' });
      // A stored shadow finding must not conjure a lineage the registry has
      // dropped: the response reports what this service grades against now.
      await insertFinding(tx.id, missingUnderAnnex4('LSER'));

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` });
      assert.equal(res.statusCode, 200);
      const body = res.json() as ShadowResp;

      assert.equal(body.session.shadowProfile, null, 'no second lineage to name');
      assert.equal(body.shadow, null, 'and no bytes to name it by');
      assert.equal(body.readiness, null, 'and nothing to be ready for');
      for (const t of body.transmissions) {
        assert.deepEqual(
          Object.keys(t.verdicts),
          ['2025'],
          'a verdict is reported under registered lineages only',
        );
        assert.equal(t.verdicts.ds013 ?? null, null, 'no shadow verdict is claimed');
      }
    } finally {
      if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
      await app.close();
    }
  },
);

test('GET …/transmissions → list rows carry the same verdicts (by1c.9)', { skip }, async () => {
  // The virtualized list renders its verdict dots off the page it already
  // fetched; if the verdicts shipped only on the summary read, every row would
  // cost a second read of the whole session.
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
      schemaVersion: '0.8.1',
      body: { meta: {} },
      rawBody: '{"meta":{}}',
      parseOk: true,
      schemaOk: true,
    });
    await insertFinding(tx.id, { requirement: '1.2', severity: 'pass', profile: '2025' });
    await insertFinding(tx.id, missingUnderAnnex4('LSER'));

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}/transmissions` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as ShadowResp;
    assert.deepEqual(body.transmissions[0]?.verdicts, { '2025': 'pass', ds013: 'fail' });
    assert.equal(body.transmissions[0]?.primaryProfile, '2025');

    // And the summary read agrees row for row — one projection, two endpoints.
    const summary = (
      await app.inject({ method: 'GET', url: `/api/sessions/${uuid}` })
    ).json() as ShadowResp;
    assert.deepEqual(body.transmissions[0]?.verdicts, summary.transmissions[0]?.verdicts);
  } finally {
    if (uuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [uuid]);
    await app.close();
  }
});

test.after(async () => {
  await closePool().catch(() => {});
});
