/**
 * Stage 2 (opt-in auth) tests (ct4.2).
 *
 * Two layers, mirroring body-stages.test.ts / schema-stage.test.ts:
 *
 *  1. STAGE-UNIT tests — drive `authStage(db).run()` against a hand-built
 *     {@link PipelineContext} (with stubbed request headers) and an INJECTED fake
 *     `db` whose `getSession` returns a chosen fake {@link SessionRow}. No real DB,
 *     no HTTP — these always run and cover every branch: disabled → continue;
 *     missing session → continue; header/basic/bearer method correct/incorrect/
 *     missing, plus the cross-scheme cases (basic and bearer share the
 *     `Authorization` header). Credentials are produced by the REAL
 *     `generateCredential` so the verify roundtrip is genuine (no hand-faked hash).
 *
 *  2. FULL-FLOW tests — drive the real route via `app.inject` so the stages run in
 *     order and the terminal persist is observable. SKIPPED gracefully when no
 *     Postgres is reachable (skip-guard idiom). They prove a disabled session
 *     ingests unchanged (with a §1.3 INFO note), a correct credential proceeds to
 *     the body stages with a §1.3 PASS, and a wrong/missing credential 401s while
 *     PERSISTING a transmission row + its §1.3 FAIL finding (the graded-failure
 *     carve-out: §1.3 is recorded, not dropped).
 *
 *       docker compose up -d postgres
 *       DATABASE_URL=postgresql://cce_validator:cce_validator@localhost:5432/cce_validator \
 *         npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../app.js';
import { generateCredential, type StoredAuth } from '../../auth/credential.js';
import { closePool, getPool } from '../../db/pool.js';
import { createSession, enableAuth, type Queryable, type SessionRow } from '../../db/repository.js';
import type { PipelineContext, StageOutcome } from '../pipeline.js';
import { authStage } from './auth.js';

// ── stage-unit harness ──────────────────────────────────────────────────────

const SESSION_UUID = '00000000-0000-0000-0000-000000000001';

/** Build a minimal PipelineContext with the given request headers. */
function makeCtx(headers: Record<string, string | string[]>): PipelineContext {
  return {
    request: { headers } as unknown as PipelineContext['request'],
    sessionUuid: SESSION_UUID,
    rawBody: Buffer.alloc(0),
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
    contentType: null,
    contentEncoding: null,
    parseOk: null,
    schemaOk: null,
  };
}

/** A fake Queryable whose `query` returns `session` (or no rows when null). */
function fakeDb(session: SessionRow | null): Queryable {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (async () => ({ rows: session ? [session] : [] })) as any,
  };
}

/** Build a SessionRow with the given auth columns (defaults: auth disabled). */
function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    uuid: SESSION_UUID,
    created_at: new Date(),
    last_post_at: null,
    auth_enabled: false,
    auth_method: null,
    auth_header_name: null,
    auth_secret_hash: null,
    ...overrides,
  };
}

/** Map a freshly-generated StoredAuth into an enabled SessionRow. */
function enabledRow(store: StoredAuth): SessionRow {
  return sessionRow({
    auth_enabled: true,
    auth_method: store.auth_method,
    auth_header_name: store.auth_header_name,
    auth_secret_hash: store.auth_secret_hash,
  });
}

async function runAuth(ctx: PipelineContext, session: SessionRow | null): Promise<StageOutcome> {
  return authStage(fakeDb(session)).run(ctx);
}

// ── stage-unit: disabled / missing → continue ───────────────────────────────

test('auth: disabled session → continue (zero-friction default), no header needed', async () => {
  const outcome = await runAuth(makeCtx({}), sessionRow({ auth_enabled: false }));
  assert.deepEqual(outcome, { kind: 'continue' });
});

test('auth: session no longer present → continue (stage 0 owns the 404)', async () => {
  const outcome = await runAuth(makeCtx({}), null);
  assert.deepEqual(outcome, { kind: 'continue' });
});

// ── stage-unit: header method ────────────────────────────────────────────────

test('auth: header method, correct token in configured header → continue', async () => {
  const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
  const ctx = makeCtx({ 'x-cce-token': cred.plaintext });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'continue' });
});

test('auth: header method reads the header case-insensitively', async () => {
  const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
  // Fastify lowercases header names; the configured name may be mixed-case.
  const ctx = makeCtx({ 'x-cce-token': cred.plaintext });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'continue' });
});

test('auth: header method, wrong token → halt 401', async () => {
  const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
  const ctx = makeCtx({ 'x-cce-token': 'not-the-token' });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

test('auth: header method, missing header → halt 401', async () => {
  const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
  const ctx = makeCtx({});
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

test('auth: header method, value sent as repeated header → first value used', async () => {
  const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
  const ctx = makeCtx({ 'x-cce-token': [cred.plaintext, 'second'] });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'continue' });
});

// ── stage-unit: basic method ─────────────────────────────────────────────────

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

test('auth: basic method, correct user+password → continue', async () => {
  const cred = generateCredential('basic', { username: 'supplier' });
  const ctx = makeCtx({ authorization: basicHeader('supplier', cred.plaintext) });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'continue' });
});

test('auth: basic method, wrong password → halt 401', async () => {
  const cred = generateCredential('basic', { username: 'supplier' });
  const ctx = makeCtx({ authorization: basicHeader('supplier', 'wrong-pass') });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

test('auth: basic method, wrong username → halt 401', async () => {
  const cred = generateCredential('basic', { username: 'supplier' });
  const ctx = makeCtx({ authorization: basicHeader('intruder', cred.plaintext) });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

test('auth: basic method, missing Authorization header → halt 401', async () => {
  const cred = generateCredential('basic', { username: 'supplier' });
  const ctx = makeCtx({});
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

// ── stage-unit: bearer method (RFC 6750, 5bs.4) ──────────────────────────────

test('auth: bearer method, correct token → continue', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({ authorization: `Bearer ${cred.plaintext}` });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'continue' });
});

test('auth: bearer method, lowercase scheme → continue (RFC 9110 case-insensitive)', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({ authorization: `bearer ${cred.plaintext}` });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'continue' });
});

test('auth: bearer method, wrong token → halt 401', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({ authorization: 'Bearer not-the-token' });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

test('auth: bearer method, missing Authorization header → halt 401', async () => {
  const cred = generateCredential('bearer');
  const outcome = await runAuth(makeCtx({}), enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

test('auth: bearer method, right secret under the Basic scheme → halt 401', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({ authorization: basicHeader('cce', cred.plaintext) });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

test('auth: basic method, right secret under the Bearer scheme → halt 401', async () => {
  const cred = generateCredential('basic', { username: 'supplier' });
  const ctx = makeCtx({ authorization: `Bearer ${cred.plaintext}` });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
});

// ── stage-unit: §1.3 findings recorded on every path ─────────────────────────

test('auth: disabled session → records a §1.3 INFO finding (auth off)', async () => {
  const ctx = makeCtx({});
  await runAuth(ctx, sessionRow({ auth_enabled: false }));
  assert.equal(ctx.findings.length, 1);
  assert.equal(ctx.findings[0]?.requirement, '1.3');
  assert.equal(ctx.findings[0]?.severity, 'info');
});

test('auth: missing session → no finding (stage 0 owns the 404)', async () => {
  const ctx = makeCtx({});
  await runAuth(ctx, null);
  assert.equal(ctx.findings.length, 0);
});

test('auth: header method, correct token → §1.3 PASS finding names the header', async () => {
  const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
  const ctx = makeCtx({ 'x-cce-token': cred.plaintext });
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.requirement, '1.3');
  assert.equal(ctx.findings[0]?.severity, 'pass');
  assert.match(ctx.findings[0]?.detail ?? '', /Successful authorization via X-CCE-Token header/);
});

test('auth: header method, missing header → §1.3 FAIL (no header detected) + halt', async () => {
  const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
  const ctx = makeCtx({});
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(ctx.findings[0]?.detail ?? '', /no X-CCE-Token header detected/);
});

test('auth: header method, wrong token → §1.3 FAIL (incorrect token) + halt', async () => {
  const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
  const ctx = makeCtx({ 'x-cce-token': 'not-the-token' });
  const outcome = await runAuth(ctx, enabledRow(cred.store));
  assert.deepEqual(outcome, { kind: 'halt', status: 401 });
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(ctx.findings[0]?.detail ?? '', /incorrect token transmitted in X-CCE-Token header/);
});

test('auth: basic method, missing Authorization → §1.3 FAIL (no Authorization header)', async () => {
  const cred = generateCredential('basic', { username: 'supplier' });
  const ctx = makeCtx({});
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(ctx.findings[0]?.detail ?? '', /no Authorization header detected/);
});

test('auth: basic method, wrong password → §1.3 FAIL (incorrect token in Authorization)', async () => {
  const cred = generateCredential('basic', { username: 'supplier' });
  const ctx = makeCtx({ authorization: basicHeader('supplier', 'wrong-pass') });
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(
    ctx.findings[0]?.detail ?? '',
    /incorrect token transmitted in Authorization header/,
  );
});

test('auth: bearer method, correct token → §1.3 PASS names the Bearer scheme', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({ authorization: `Bearer ${cred.plaintext}` });
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.severity, 'pass');
  assert.match(
    ctx.findings[0]?.detail ?? '',
    /Successful authorization via Authorization header \(Bearer scheme\)/,
  );
});

test('auth: bearer method, missing Authorization → §1.3 FAIL (no header detected)', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({});
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(ctx.findings[0]?.detail ?? '', /no Authorization header detected/);
});

test('auth: bearer method, wrong token → §1.3 FAIL (incorrect token)', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({ authorization: 'Bearer not-the-token' });
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(
    ctx.findings[0]?.detail ?? '',
    /incorrect token transmitted in Authorization header/,
  );
});

test('auth: bearer method, Basic scheme presented → §1.3 FAIL names the scheme mismatch', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({ authorization: basicHeader('cce', cred.plaintext) });
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(
    ctx.findings[0]?.detail ?? '',
    /used the "basic" scheme; Bearer was expected/,
    'a scheme mismatch is reported as such, not as an incorrect token',
  );
});

test('auth: basic method, Bearer scheme presented → §1.3 FAIL names the scheme mismatch', async () => {
  const cred = generateCredential('basic', { username: 'supplier' });
  const ctx = makeCtx({ authorization: `Bearer ${cred.plaintext}` });
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(ctx.findings[0]?.detail ?? '', /used the "bearer" scheme; Basic was expected/);
});

test('auth: bearer method, unparseable Authorization → §1.3 FAIL (malformed)', async () => {
  const cred = generateCredential('bearer');
  const ctx = makeCtx({ authorization: 'just-a-token-no-scheme' });
  await runAuth(ctx, enabledRow(cred.store));
  assert.equal(ctx.findings[0]?.severity, 'fail');
  assert.match(ctx.findings[0]?.detail ?? '', /malformed Authorization header/);
});

// ── full-flow (DB-skip-guarded) ─────────────────────────────────────────────

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

const JSON_UTF8 = 'application/json; charset=utf-8';

/**
 * A genuinely-valid RTM transmission (so a passing auth reaches a 2xx). The
 * default version is the one the pre-existing tests below were written against;
 * callers pass a registered version explicitly.
 */
function validPayload(schemaVersion = '0.8.0'): Buffer {
  return Buffer.from(
    JSON.stringify({
      meta: {
        schemaVersion,
        transferType: 'rtm',
        transferId: 'T-auth-1',
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
          records: [{ ABST: '20200115T040554Z', ALRM: 'HEAT', BEMD: 14.3, EERR: 'none', TVC: 3.2 }],
        },
      ],
    }),
    'utf8',
  );
}

/** Count transmission rows persisted for a session. */
async function rowCount(sessionUuid: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM transmission WHERE session_uuid = $1`,
    [sessionUuid],
  );
  return Number(rows[0]?.n ?? '0');
}

test(
  'full-flow: auth-disabled session ingests unchanged (no credential, reaches body stages)',
  { skip },
  async () => {
    const session = await createSession();
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: { 'content-type': JSON_UTF8 },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 200, 'disabled auth → reaches body stages, 200');
      assert.equal(await rowCount(session.uuid), 1, 'a transmission row was persisted');
    } finally {
      await app.close();
      await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
    }
  },
);

test(
  'full-flow: enabled + correct header token → proceeds to body stages (row persisted)',
  { skip },
  async () => {
    const session = await createSession();
    const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
    await enableAuth(session.uuid, {
      authMethod: cred.store.auth_method,
      authHeaderName: cred.store.auth_header_name,
      authSecretHash: cred.store.auth_secret_hash,
    });
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: { 'content-type': JSON_UTF8, 'x-cce-token': cred.plaintext },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 200, 'correct token → reaches body stages, 200');
      assert.equal(await rowCount(session.uuid), 1, 'a transmission row was persisted');
    } finally {
      await app.close();
      await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
    }
  },
);

type ResponseBody = {
  transmissionId: string | null;
  findingDetails: { requirement: string; severity: string; detail?: string | null }[];
};

test(
  'full-flow: enabled + incorrect token → 401 PERSISTS a row + §1.3 FAIL finding',
  { skip },
  async () => {
    const session = await createSession();
    const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
    await enableAuth(session.uuid, {
      authMethod: cred.store.auth_method,
      authHeaderName: cred.store.auth_header_name,
      authSecretHash: cred.store.auth_secret_hash,
    });
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: { 'content-type': JSON_UTF8, 'x-cce-token': 'wrong-token' },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 401, 'incorrect token → 401');
      const body = res.json() as ResponseBody;
      assert.match(body.transmissionId ?? '', /^[0-9a-f-]{36}$/, 'a row was persisted');
      assert.equal(await rowCount(session.uuid), 1, 'enabled-401 persists a transmission row');
      const f = body.findingDetails.find((d) => d.requirement === '1.3');
      assert.equal(f?.severity, 'fail', '§1.3 graded as fail');
      assert.match(f?.detail ?? '', /incorrect token transmitted in X-CCE-Token header/);
    } finally {
      await app.close();
      await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
    }
  },
);

test(
  'full-flow: enabled + missing credential → 401 PERSISTS a row + §1.3 FAIL (no header)',
  { skip },
  async () => {
    const session = await createSession();
    const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
    await enableAuth(session.uuid, {
      authMethod: cred.store.auth_method,
      authHeaderName: cred.store.auth_header_name,
      authSecretHash: cred.store.auth_secret_hash,
    });
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: { 'content-type': JSON_UTF8 },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 401, 'missing credential → 401');
      const body = res.json() as ResponseBody;
      assert.equal(await rowCount(session.uuid), 1, 'enabled-401 persists a transmission row');
      const f = body.findingDetails.find((d) => d.requirement === '1.3');
      assert.equal(f?.severity, 'fail', '§1.3 graded as fail');
      assert.match(f?.detail ?? '', /no X-CCE-Token header detected/);
    } finally {
      await app.close();
      await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
    }
  },
);

test(
  'full-flow: bearer session accepts `Authorization: Bearer <token>` (exercises the widened CHECK)',
  { skip },
  async () => {
    const session = await createSession();
    const cred = generateCredential('bearer');
    // Also proves db/initdb/50-session-auth-bearer.sql is applied: without the
    // widened auth_method CHECK this UPDATE raises 23514.
    await enableAuth(session.uuid, {
      authMethod: cred.store.auth_method,
      authHeaderName: cred.store.auth_header_name,
      authSecretHash: cred.store.auth_secret_hash,
    });
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: { 'content-type': JSON_UTF8, authorization: `Bearer ${cred.plaintext}` },
        payload: validPayload('0.8.1'),
      });
      assert.equal(res.statusCode, 200, 'correct bearer token → reaches body stages, 200');
      const body = res.json() as ResponseBody;
      const f = body.findingDetails.find((d) => d.requirement === '1.3');
      assert.equal(f?.severity, 'pass', '§1.3 graded as pass');
      assert.match(f?.detail ?? '', /Successful authorization via Authorization header/);
      assert.equal(await rowCount(session.uuid), 1, 'a transmission row was persisted');
    } finally {
      await app.close();
      await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
    }
  },
);

test(
  'full-flow: bearer session 401s a wrong token and PERSISTS the §1.3 FAIL',
  { skip },
  async () => {
    const session = await createSession();
    const cred = generateCredential('bearer');
    await enableAuth(session.uuid, {
      authMethod: cred.store.auth_method,
      authHeaderName: cred.store.auth_header_name,
      authSecretHash: cred.store.auth_secret_hash,
    });
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const wrong = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: { 'content-type': JSON_UTF8, authorization: 'Bearer wrong-token' },
        payload: validPayload('0.8.1'),
      });
      assert.equal(wrong.statusCode, 401, 'wrong bearer token → 401');
      const body = wrong.json() as ResponseBody;
      const f = body.findingDetails.find((d) => d.requirement === '1.3');
      assert.equal(f?.severity, 'fail');
      assert.match(f?.detail ?? '', /incorrect token transmitted in Authorization header/);

      const missing = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: { 'content-type': JSON_UTF8 },
        payload: validPayload('0.8.1'),
      });
      assert.equal(missing.statusCode, 401, 'no credential → 401');

      const wrongScheme = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: {
          'content-type': JSON_UTF8,
          authorization: `Basic ${Buffer.from(`cce:${cred.plaintext}`).toString('base64')}`,
        },
        payload: validPayload('0.8.1'),
      });
      assert.equal(wrongScheme.statusCode, 401, 'right secret, wrong scheme → 401');

      assert.equal(await rowCount(session.uuid), 3, 'each enabled-401 persists a row');
    } finally {
      await app.close();
      await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
    }
  },
);

test(
  'full-flow: enabled + correct token → §1.3 PASS finding in the response',
  { skip },
  async () => {
    const session = await createSession();
    const cred = generateCredential('header', { headerName: 'X-CCE-Token' });
    await enableAuth(session.uuid, {
      authMethod: cred.store.auth_method,
      authHeaderName: cred.store.auth_header_name,
      authSecretHash: cred.store.auth_secret_hash,
    });
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers: { 'content-type': JSON_UTF8, 'x-cce-token': cred.plaintext },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 200, 'correct token → 200');
      const body = res.json() as ResponseBody;
      const f = body.findingDetails.find((d) => d.requirement === '1.3');
      assert.equal(f?.severity, 'pass', '§1.3 graded as pass');
      assert.match(f?.detail ?? '', /Successful authorization via X-CCE-Token header/);
    } finally {
      await app.close();
      await getPool().query('DELETE FROM session WHERE uuid = $1', [session.uuid]);
    }
  },
);
