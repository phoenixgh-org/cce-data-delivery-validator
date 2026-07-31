/**
 * Stage 7 (schema validate) tests (3bn.6).
 *
 * Two layers, mirroring body-stages.test.ts:
 *
 *  1. STAGE-UNIT tests — drive `schemaStage().run()` against a hand-built
 *     {@link PipelineContext} carrying a REAL {@link SchemaRegistry} (loaded from
 *     the vendored bytes). No DB, no HTTP — these always run and prove the
 *     stage's branches: unknown version → 422, invalid body → 422 with one
 *     finding per Ajv error (each with a JSON Pointer), a genuinely-valid
 *     current-version transmission → continue with schemaOk = true + a §3.2 pass,
 *     and a valid-but-outdated version → continue + a §3.2 info(outdated).
 *
 *  2. FULL-FLOW tests — drive the real route via `app.inject` so the stages run
 *     in order and persist records the outcome. SKIPPED gracefully when no DB is
 *     reachable (skip-guard idiom from src/db/repository.test.ts). To run them:
 *
 *       docker compose up -d postgres
 *       DATABASE_URL=postgresql://cce_validator:cce_validator@localhost:5432/cce_validator \
 *         npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../app.js';
import { closePool, getPool } from '../../db/pool.js';
import { createSession, type InsertFindingInput } from '../../db/repository.js';
import { SchemaRegistry } from '../../schema-registry.js';
import type { PipelineContext, StageOutcome } from '../pipeline.js';
import { schemaStage } from './schema.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const JSON_UTF8 = 'application/json; charset=utf-8';

/** A synthetic version, newer than anything real, used only to exercise the
 *  outdated-but-valid path. Deliberately not a plausible real release number. */
const SYNTHETIC_NEWER = '9.9.9';

/**
 * A registry that behaves exactly like the live one but reports
 * {@link SYNTHETIC_NEWER} as its current version, so the REAL current version
 * (0.8.1) resolves as "valid but outdated".
 *
 * Needed because the registry now vendors a single version: with nothing older
 * than current, the §3.2 outdated path has no live case and would otherwise go
 * untested. Delegating to the real registry keeps the actual compiled 0.8.1
 * validator in play — only the currency verdict is synthesized. Restore this to
 * a plain `SchemaRegistry.load()` once two real versions are registered again.
 */
function registryWithNewerCurrent(): SchemaRegistry {
  const real = SchemaRegistry.load();
  const stub: Pick<SchemaRegistry, 'lookup' | 'currentVersion' | 'supportedVersions' | 'get'> = {
    lookup: (raw: string) => real.lookup(raw),
    get: (version: string) => real.get(version),
    supportedVersions: () => [...real.supportedVersions(), SYNTHETIC_NEWER],
    currentVersion: () => SYNTHETIC_NEWER,
  };
  return stub as SchemaRegistry;
}

/** A genuinely-valid RTM transmission on the CURRENT version (verified against the live registry). */
function validPayload(): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-valid-1',
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
  };
}

// ── stage-unit harness ──────────────────────────────────────────────────────

const registry = SchemaRegistry.load();

/** A PipelineContext whose parse stage already ran on `parsedBody`. */
function makeCtx(parsedBody: unknown, reg: SchemaRegistry = registry): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'test-session',
    rawBody: Buffer.from(JSON.stringify(parsedBody)),
    registry: reg,
    findings: [],
    parsedBody,
    meta: {},
    normalizedSchemaVersion: null,
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: true,
    schemaOk: null,
  };
}

function findingsBy(findings: InsertFindingInput[], requirement: string, severity: string) {
  return findings.filter((f) => f.requirement === requirement && f.severity === severity);
}

// ── stage-unit: precondition ────────────────────────────────────────────────

test('schema: no parsed body (parse halted upstream) → continue, schemaOk untouched', () => {
  const ctx = makeCtx(null);
  ctx.parseOk = false;
  const outcome = schemaStage().run(ctx) as StageOutcome;
  assert.equal(outcome.kind, 'continue');
  assert.equal(ctx.schemaOk, null);
  assert.equal(ctx.findings.length, 0);
});

// ── stage-unit: schemaVersion missing ───────────────────────────────────────

test('schema: missing meta.schemaVersion → halt 422, one 3.2 fail, schemaOk false', () => {
  const ctx = makeCtx({ meta: { transferType: 'rtm' }, data: [] });
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.deepEqual(outcome, { kind: 'halt', status: 422 });
  assert.equal(ctx.schemaOk, false);
  const fails = findingsBy(ctx.findings, '3.2', 'fail');
  assert.equal(fails.length, 1, 'one schema-version fail');
  assert.equal(fails[0]?.pointer, '/meta/schemaVersion');
  assert.equal(fails[0]?.code, 'tx.missing_schema_version', 'stable code for signatures');
  // meta.* still lifted from what the supplier sent.
  assert.equal(ctx.meta.transferType, 'rtm');
  assert.equal(ctx.meta.schemaVersion, null);
});

// ── stage-unit: unknown version ─────────────────────────────────────────────

test('schema: unknown schemaVersion → halt 422 with one finding listing supported', () => {
  const ctx = makeCtx({ meta: { schemaVersion: '9.9.9', transferType: 'rtm' }, data: [] });
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.deepEqual(outcome, { kind: 'halt', status: 422 });
  assert.equal(ctx.schemaOk, false);
  const fails = findingsBy(ctx.findings, '3.2', 'fail');
  assert.equal(fails.length, 1, 'a single unsupported-version finding');
  assert.match(fails[0]?.detail ?? '', /supported:/);
  assert.match(fails[0]?.detail ?? '', /0\.8\.1/, 'lists 0.8.1 as supported');
  assert.equal(fails[0]?.pointer, '/meta/schemaVersion');
  assert.equal(fails[0]?.code, 'tx.unsupported_schema_version', 'stable code for signatures');
  assert.equal(ctx.meta.schemaVersion, '9.9.9', 'raw version recorded as sent');
});

test('schema: version given as a full $id URL normalizes + resolves', () => {
  const body = validPayload();
  (body.meta as Record<string, unknown>).schemaVersion =
    'https://schemas.2to8.cc/schemas/cce-interop-0.8.1.json';
  const ctx = makeCtx(body);
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.equal(outcome.kind, 'continue', 'URL form resolves to 0.8.1 and validates');
  assert.equal(ctx.schemaOk, true);
  assert.equal(ctx.normalizedSchemaVersion, '0.8.1');
});

// ── stage-unit: invalid-but-parseable body ──────────────────────────────────

test('schema: parseable-but-invalid body → halt 422, one finding per Ajv error with pointers', () => {
  // Valid JSON, valid known version, but the body violates the schema:
  //   - data is empty (minItems: 1) → a root-level error (instancePath '')
  //   - meta is missing required fields (transferType/transferId/...) → errors
  //     pointing INTO /meta.
  const ctx = makeCtx({ meta: { schemaVersion: '0.8.1' }, data: [] });
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.deepEqual(outcome, { kind: 'halt', status: 422 });
  assert.equal(ctx.schemaOk, false);
  assert.equal(ctx.normalizedSchemaVersion, '0.8.1');

  const fails = findingsBy(ctx.findings, '3.2', 'fail');
  assert.ok(fails.length >= 1, 'at least one fail finding per Ajv error');
  // Every finding carries a string detail; pointers are either null (root) or a
  // JSON Pointer beginning with '/'.
  for (const f of fails) {
    assert.equal(typeof f.detail, 'string');
    if (f.pointer !== null && f.pointer !== undefined) {
      assert.match(f.pointer, /^\//, 'non-root pointer is a JSON Pointer');
    }
  }
  // The missing-required-fields errors point INTO /meta — a non-trivial pointer.
  assert.ok(
    fails.some((f) => f.pointer === '/meta'),
    'a finding pinpoints /meta (missing required transfer fields)',
  );
  // Structured signature fields (4h4.1): each Ajv error carries its keyword +
  // instancePath; transport codes are NOT set on schema findings.
  for (const f of fails) {
    assert.equal(typeof f.keyword, 'string', 'Ajv keyword captured for the signature');
    assert.equal(typeof f.instancePath, 'string', 'Ajv instancePath captured');
    assert.equal(f.code, undefined, 'schema findings sign on keyword, not a code');
  }
  // A `required` error names the missing property as its identifying param.
  const requiredFail = fails.find((f) => f.keyword === 'required');
  assert.ok(requiredFail, 'a required-keyword error is present');
  assert.equal(requiredFail?.instancePath, '/meta', 'required error sits at /meta');
  assert.equal(typeof requiredFail?.param, 'string', 'param is the missing property name');
});

// ── stage-unit: valid payload ───────────────────────────────────────────────

test('schema: genuinely-valid current-version transmission → continue, schemaOk true, 3.2 pass', () => {
  const ctx = makeCtx(validPayload());
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.equal(outcome.kind, 'continue', 'valid payload is not halted');
  assert.equal(ctx.schemaOk, true);
  assert.equal(ctx.normalizedSchemaVersion, '0.8.1');
  assert.equal(findingsBy(ctx.findings, '3.2', 'fail').length, 0, 'no fail findings');
  const passes = findingsBy(ctx.findings, '3.2', 'pass');
  assert.equal(passes.length, 1, 'one pass finding');
  assert.match(passes[0]?.detail ?? '', /sha256/, 'pass cites content-hash provenance');
  assert.notEqual(passes[0]?.outdated, true, 'a current-version pass is not flagged outdated');
  // meta lifted for persistence.
  assert.equal(ctx.meta.transferId, 'T-valid-1');
  assert.equal(ctx.meta.transferType, 'rtm');
  assert.equal(ctx.meta.transferSrc, 'com.example');
  assert.equal(ctx.meta.schemaVersion, '0.8.1');
});

test('schema: valid-but-OUTDATED version → continue, schemaOk true, one 3.2 info(outdated)', () => {
  // A valid 0.8.1 body against a registry whose current version is NEWER, so
  // 0.8.1 resolves as outdated-but-valid: the body is ACCEPTED (continue,
  // schemaOk true) and recorded as a §3.2 info finding flagged `outdated` —
  // never a pass/fail. See registryWithNewerCurrent() for why this is synthetic.
  const ctx = makeCtx(validPayload(), registryWithNewerCurrent());
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.equal(outcome.kind, 'continue', 'outdated-but-valid payload is still accepted');
  assert.equal(ctx.schemaOk, true);
  assert.equal(ctx.normalizedSchemaVersion, '0.8.1');
  assert.equal(
    findingsBy(ctx.findings, '3.2', 'pass').length,
    0,
    'no pass finding for an outdated version',
  );
  assert.equal(findingsBy(ctx.findings, '3.2', 'fail').length, 0, 'outdated is not a fail');
  const infos = findingsBy(ctx.findings, '3.2', 'info');
  assert.equal(infos.length, 1, 'one §3.2 info finding');
  assert.equal(infos[0]?.outdated, true, 'flagged outdated for the dashboard tag');
  assert.equal(infos[0]?.code, 'tx.outdated_schema', 'stable code for the soft signature');
  assert.match(infos[0]?.detail ?? '', /0\.8\.1/, 'names the declared version');
  assert.match(
    infos[0]?.detail ?? '',
    new RegExp(SYNTHETIC_NEWER.replace(/\./g, '\\.')),
    'names the current version to upgrade to',
  );
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

async function postToSession(
  payload: Buffer,
  registry?: SchemaRegistry,
): Promise<{
  statusCode: number;
  body: { transmissionId: string | null; status: number; findings: number };
  sessionUuid: string;
}> {
  const session = await createSession();
  // `registry` overrides the app's own SchemaRegistry.load() — the only way to
  // drive the outdated-but-valid path now that a single version is vendored.
  const app = buildApp({ logger: false, ...(registry ? { registry } : {}) });
  await app.ready();
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/i/${session.uuid}`,
      headers: { 'content-type': JSON_UTF8 },
      payload,
    });
    return {
      statusCode: res.statusCode,
      body: res.json() as { transmissionId: string | null; status: number; findings: number },
      sessionUuid: session.uuid,
    };
  } finally {
    await app.close();
  }
}

/** Read the single transmission row + its findings for a session. */
async function rowFor(sessionUuid: string) {
  const { rows } = await getPool().query<{
    http_status: number;
    schema_ok: boolean | null;
    schema_version: string | null;
  }>(`SELECT http_status, schema_ok, schema_version FROM transmission WHERE session_uuid = $1`, [
    sessionUuid,
  ]);
  return rows;
}

async function findingsFor(sessionUuid: string) {
  const { rows } = await getPool().query<{
    requirement: string;
    severity: string;
    pointer: string | null;
    outdated: boolean;
  }>(
    `SELECT f.requirement, f.severity, f.pointer, f.outdated FROM finding f
     JOIN transmission t ON t.id = f.transmission_id
     WHERE t.session_uuid = $1`,
    [sessionUuid],
  );
  return rows;
}

test(
  'full-flow: unknown schemaVersion → 422, schema_ok false, one supported-listing finding',
  { skip },
  async () => {
    const payload = Buffer.from(
      JSON.stringify({ meta: { schemaVersion: '9.9.9', transferType: 'rtm' }, data: [{}] }),
      'utf8',
    );
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(payload);
      sessionUuid = out.sessionUuid;

      assert.equal(out.statusCode, 422);
      assert.match(out.body.transmissionId ?? '', /^[0-9a-f-]{36}$/, 'row persisted on 422');

      const rows = await rowFor(sessionUuid);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.http_status, 422);
      assert.equal(rows[0]?.schema_ok, false, 'schema_ok persisted false');
      assert.equal(rows[0]?.schema_version, '9.9.9', 'requested version recorded');

      const fails = (await findingsFor(sessionUuid)).filter(
        (f) => f.requirement === '3.2' && f.severity === 'fail',
      );
      assert.equal(fails.length, 1, 'a single unsupported-version finding');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test(
  'full-flow: parseable-but-invalid body → 422, schema_ok false, findings carry pointers',
  { skip },
  async () => {
    const payload = Buffer.from(
      JSON.stringify({ meta: { schemaVersion: '0.8.1' }, data: [] }),
      'utf8',
    );
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(payload);
      sessionUuid = out.sessionUuid;

      assert.equal(out.statusCode, 422);

      const rows = await rowFor(sessionUuid);
      assert.equal(rows[0]?.schema_ok, false, 'schema_ok persisted false');
      assert.equal(rows[0]?.schema_version, '0.8.1', 'normalized version recorded');

      const fails = (await findingsFor(sessionUuid)).filter(
        (f) => f.requirement === '3.2' && f.severity === 'fail',
      );
      assert.ok(fails.length >= 1, 'one finding per Ajv error');
      assert.ok(
        fails.some((f) => typeof f.pointer === 'string' && f.pointer.startsWith('/')),
        'at least one finding carries a non-trivial JSON Pointer',
      );
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test(
  'full-flow: genuinely-valid current-version payload → not 422, schema_ok true persisted',
  { skip },
  async () => {
    const payload = Buffer.from(JSON.stringify(validPayload()), 'utf8');
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(payload);
      sessionUuid = out.sessionUuid;

      assert.notEqual(out.statusCode, 422, 'valid payload is not rejected at stage 7');
      assert.ok(out.statusCode < 300, `reaches success (got ${out.statusCode})`);

      const rows = await rowFor(sessionUuid);
      assert.equal(rows[0]?.schema_ok, true, 'schema_ok persisted true');
      assert.equal(rows[0]?.schema_version, '0.8.1', 'version recorded');

      const passes = (await findingsFor(sessionUuid)).filter(
        (f) => f.requirement === '3.2' && f.severity === 'pass',
      );
      assert.equal(passes.length, 1, 'one schema pass finding recorded');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test(
  'full-flow: valid-but-outdated payload → accepted, schema_ok true, §3.2 info(outdated) persisted',
  { skip },
  async () => {
    // A valid 0.8.1 payload against a registry reporting a NEWER current
    // version, so 0.8.1 grades as outdated-but-valid end to end.
    const payload = Buffer.from(JSON.stringify(validPayload()), 'utf8');
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(payload, registryWithNewerCurrent());
      sessionUuid = out.sessionUuid;

      assert.notEqual(out.statusCode, 422, 'outdated-but-valid payload is still accepted');
      assert.ok(out.statusCode < 300, `reaches success (got ${out.statusCode})`);

      const rows = await rowFor(sessionUuid);
      assert.equal(rows[0]?.schema_ok, true, 'schema_ok persisted true');
      assert.equal(rows[0]?.schema_version, '0.8.1', 'declared (outdated) version recorded');

      const all = await findingsFor(sessionUuid);
      assert.equal(
        all.filter((f) => f.requirement === '3.2' && f.severity === 'pass').length,
        0,
        'no §3.2 pass for an outdated version',
      );
      const infos = all.filter(
        (f) => f.requirement === '3.2' && f.severity === 'info' && f.outdated,
      );
      assert.equal(infos.length, 1, 'one §3.2 info finding flagged outdated');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test.after(async () => {
  await closePool().catch(() => {});
});
