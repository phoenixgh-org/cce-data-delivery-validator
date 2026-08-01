/**
 * Body-byte stages (3-6) tests (3bn.4, 3bn.5).
 *
 * Two layers:
 *
 *  1. STAGE-UNIT tests — call a stage's `run()` against a hand-built
 *     {@link PipelineContext}, asserting its outcome + findings. These need no
 *     DB and no HTTP, so they ALWAYS run. They prove the stage logic in
 *     isolation.
 *
 *  2. FULL-FLOW tests — drive the real route via `app.inject` so the stages run
 *     in order and the terminal persist records the outcome. Cases that assert
 *     on persisted rows touch Postgres and are SKIPPED gracefully when no DB is
 *     reachable (skip-guard idiom from src/db/repository.test.ts). To run them:
 *
 *       docker compose up -d postgres
 *       DATABASE_URL=postgresql://cce_validator:cce_validator@localhost:5432/cce_validator \
 *         npm test
 *
 * Two app/route-layer bugs that once blocked the size-413 and real-gzip paths
 * end-to-end are now FIXED and have full-flow coverage below:
 *   - 6y3: Fastify's default bodyLimit (1MB == the §1.4 cap) used to reject an
 *     over-cap body with its OWN 413 before the size stage ran. app.ts now sets
 *     bodyLimit ABOVE the cap, so an oversized-but-bounded body reaches the size
 *     stage → our 413 + 1.4 finding + persisted row.
 *   - do5: route.ts used to persist raw_body as `ctx.rawBody.toString('utf8')`;
 *     the NUL bytes in gzip/binary bodies made Postgres `text` reject the insert
 *     (500). route.ts now stores the decoded (gzip) text, NUL-stripped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { buildApp } from '../../app.js';
import { closePool, getPool } from '../../db/pool.js';
import { createSession, type InsertFindingInput } from '../../db/repository.js';
import type { PipelineContext, StageOutcome } from '../pipeline.js';
import { contentTypeStage } from './content-type.js';
import { encodingStage } from './encoding.js';
import { parseStage } from './parse.js';
import { sizeStage } from './size.js';

// ── stage-unit harness ──────────────────────────────────────────────────────

/** Build a minimal PipelineContext for direct stage testing (no DB/HTTP). */
function makeCtx(overrides: Partial<PipelineContext> & { rawBody: Buffer }): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'test-session',
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
    contentType: null,
    contentEncoding: null,
    parseOk: null,
    schemaOk: null,
    ...overrides,
  };
}

function hasFinding(
  findings: InsertFindingInput[],
  requirement: string,
  severity: string,
): boolean {
  return findings.some((f) => f.requirement === requirement && f.severity === severity);
}

/** The stable signature `code` of the (requirement, severity) finding, if any (4h4.1). */
function findingCode(
  findings: InsertFindingInput[],
  requirement: string,
  severity: string,
): string | null | undefined {
  return findings.find((f) => f.requirement === requirement && f.severity === severity)?.code;
}

async function runStage(
  stage: { run(c: PipelineContext): Promise<StageOutcome> | StageOutcome },
  ctx: PipelineContext,
) {
  return stage.run(ctx);
}

// ── stage-unit: size (stage 3) ──────────────────────────────────────────────

test('size: body over the 1MB cap → halt 413 with a 1.4 fail finding', async () => {
  // 1MB cap is 1_048_576 bytes; one byte over trips §1.4. This proves the STAGE
  // logic; the end-to-end 413 path is covered by a full-flow test below (6y3).
  const ctx = makeCtx({ rawBody: Buffer.alloc(1_048_577) });
  const outcome = await runStage(sizeStage(), ctx);

  assert.deepEqual(outcome, { kind: 'halt', status: 413 });
  assert.ok(hasFinding(ctx.findings, '1.4', 'fail'), '1.4 fail finding recorded');
  assert.equal(findingCode(ctx.findings, '1.4', 'fail'), 'tx.body_too_large', 'stable code');
});

test('size: body at exactly the 1MB cap → continue with a 1.4 pass finding', async () => {
  const ctx = makeCtx({ rawBody: Buffer.alloc(1_048_576) });
  const outcome = await runStage(sizeStage(), ctx);

  assert.equal(outcome.kind, 'continue');
  assert.ok(hasFinding(ctx.findings, '1.4', 'pass'), '1.4 pass finding recorded');
});

// ── stage-unit: content-type (stage 4) ──────────────────────────────────────

test('content-type: exact application/json; charset=utf-8 → continue, 1.2 pass', async () => {
  const ctx = makeCtx({ rawBody: Buffer.alloc(0), contentType: 'application/json; charset=utf-8' });
  const outcome = await runStage(contentTypeStage(), ctx);
  assert.equal(outcome.kind, 'continue');
  assert.ok(hasFinding(ctx.findings, '1.2', 'pass'));
});

test('content-type: bare application/json (no charset) → continue, 1.2 fail', async () => {
  const ctx = makeCtx({ rawBody: Buffer.alloc(0), contentType: 'application/json' });
  const outcome = await runStage(contentTypeStage(), ctx);
  assert.equal(outcome.kind, 'continue', 'never halts (415 optional)');
  assert.ok(hasFinding(ctx.findings, '1.2', 'fail'));
  assert.equal(findingCode(ctx.findings, '1.2', 'fail'), 'tx.missing_charset', 'charset code');
});

test('content-type: missing / wrong media type → continue, 1.2 fail', async () => {
  for (const ct of [null, 'text/plain', 'application/xml; charset=utf-8']) {
    const ctx = makeCtx({ rawBody: Buffer.alloc(0), contentType: ct });
    const outcome = await runStage(contentTypeStage(), ctx);
    assert.equal(outcome.kind, 'continue');
    assert.ok(hasFinding(ctx.findings, '1.2', 'fail'), `1.2 fail for ${ct}`);
    assert.equal(
      findingCode(ctx.findings, '1.2', 'fail'),
      'tx.bad_media_type',
      `bad-media-type code for ${ct}`,
    );
  }
});

// ── stage-unit: encoding (stage 5) ──────────────────────────────────────────

test('encoding: no Content-Encoding → continue clean, no decoded body', async () => {
  const ctx = makeCtx({ rawBody: Buffer.from('{}'), contentEncoding: null });
  const outcome = await runStage(encodingStage(), ctx);
  assert.equal(outcome.kind, 'continue');
  assert.equal(ctx.findings.length, 0, 'no encoding → no finding');
});

test('encoding: valid single-layer gzip → continue, 1.6 pass, decoded handed to parse', async () => {
  const json = '{"meta":{"transferId":"T-gz"}}';
  const ctx = makeCtx({ rawBody: gzipSync(Buffer.from(json)), contentEncoding: 'gzip' });

  const encOutcome = await runStage(encodingStage(), ctx);
  assert.equal(encOutcome.kind, 'continue');
  assert.ok(hasFinding(ctx.findings, '1.6', 'pass'));

  // Stage 6 must read the DECODED bytes via the handoff, not the gzip wire bytes.
  const parseOutcome = await runStage(parseStage(), ctx);
  assert.equal(parseOutcome.kind, 'continue');
  assert.equal(ctx.parseOk, true);
  assert.deepEqual(ctx.parsedBody, { meta: { transferId: 'T-gz' } });
});

test('encoding: gzip header on non-gzip bytes → halt 400, 1.6 fail', async () => {
  const ctx = makeCtx({ rawBody: Buffer.from('{"meta":{}}'), contentEncoding: 'gzip' });
  const outcome = await runStage(encodingStage(), ctx);
  assert.deepEqual(outcome, { kind: 'halt', status: 400 });
  assert.ok(hasFinding(ctx.findings, '1.6', 'fail'));
  assert.equal(
    findingCode(ctx.findings, '1.6', 'fail'),
    'tx.undecodable_body',
    'undecodable-body code',
  );
});

test('encoding: double-encoded gzip (gzip-of-gzip) → halt 400, 1.6 fail', async () => {
  const doubled = gzipSync(gzipSync(Buffer.from('{"meta":{}}')));
  const ctx = makeCtx({ rawBody: doubled, contentEncoding: 'gzip' });
  const outcome = await runStage(encodingStage(), ctx);
  assert.deepEqual(outcome, { kind: 'halt', status: 400 });
  assert.ok(hasFinding(ctx.findings, '1.6', 'fail'), 'illegal layering flagged');
  assert.equal(
    findingCode(ctx.findings, '1.6', 'fail'),
    'tx.double_encoded',
    'double-encoded code',
  );
});

test('encoding: unsupported encoding token → halt 400, 1.6 fail', async () => {
  const ctx = makeCtx({ rawBody: Buffer.from('{}'), contentEncoding: 'br' });
  const outcome = await runStage(encodingStage(), ctx);
  assert.deepEqual(outcome, { kind: 'halt', status: 400 });
  assert.ok(hasFinding(ctx.findings, '1.6', 'fail'));
  assert.equal(
    findingCode(ctx.findings, '1.6', 'fail'),
    'tx.unsupported_encoding',
    'unsupported-encoding code',
  );
});

test('encoding: zip-bomb over the 1MB decoded cap → halt 400, 1.6 fail', async () => {
  // ~2MB of zeros compresses tiny but would exceed the maxOutputLength cap.
  const bomb = gzipSync(Buffer.alloc(2 * 1_048_576, 0x20));
  const ctx = makeCtx({ rawBody: bomb, contentEncoding: 'gzip' });
  const outcome = await runStage(encodingStage(), ctx);
  assert.deepEqual(outcome, { kind: 'halt', status: 400 }, 'zip-bomb rejected');
  assert.ok(hasFinding(ctx.findings, '1.6', 'fail'));
});

// ── stage-unit: parse (stage 6) ─────────────────────────────────────────────

test('parse: valid UTF-8 JSON → continue, sets parsedBody + parseOk, 1.1 pass', async () => {
  const ctx = makeCtx({ rawBody: Buffer.from('{"meta":{"transferId":"T-1"}}', 'utf8') });
  const outcome = await runStage(parseStage(), ctx);
  assert.equal(outcome.kind, 'continue');
  assert.equal(ctx.parseOk, true);
  assert.deepEqual(ctx.parsedBody, { meta: { transferId: 'T-1' } });
  assert.ok(hasFinding(ctx.findings, '1.1', 'pass'));
});

test('parse: malformed JSON → halt 400, parseOk false, 1.1 fail', async () => {
  const ctx = makeCtx({ rawBody: Buffer.from('{"meta":{ broken', 'utf8') });
  const outcome = await runStage(parseStage(), ctx);
  assert.deepEqual(outcome, { kind: 'halt', status: 400 });
  assert.equal(ctx.parseOk, false);
  assert.ok(hasFinding(ctx.findings, '1.1', 'fail'));
  assert.equal(findingCode(ctx.findings, '1.1', 'fail'), 'tx.parse_failed', 'parse-failed code');
});

test('parse: invalid UTF-8 bytes → halt 400, parseOk false, 1.1 fail', async () => {
  // 0xff 0xfe is not a valid UTF-8 sequence → fatal TextDecoder throws (§1.1).
  const ctx = makeCtx({ rawBody: Buffer.from([0xff, 0xfe, 0x7b, 0x7d]) });
  const outcome = await runStage(parseStage(), ctx);
  assert.deepEqual(outcome, { kind: 'halt', status: 400 });
  assert.equal(ctx.parseOk, false);
  assert.ok(hasFinding(ctx.findings, '1.1', 'fail'));
});

// ── full-flow (DB-skip-guarded): paths reachable end-to-end today ───────────

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

const JSON_UTF8 = 'application/json; charset=utf-8';

/** Mint a session and POST `payload` to its ingest URL with the given headers. */
async function postToSession(
  payload: Buffer,
  headers: Record<string, string>,
): Promise<{
  statusCode: number;
  body: { transmissionId: string | null; status: number; findings: number };
  sessionUuid: string;
}> {
  const session = await createSession();
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({ method: 'POST', url: `/i/${session.uuid}`, headers, payload });
    return {
      statusCode: res.statusCode,
      body: res.json() as { transmissionId: string | null; status: number; findings: number },
      sessionUuid: session.uuid,
    };
  } finally {
    await app.close();
  }
}

/** All (requirement, severity) findings recorded for a session's transmission. */
async function findingsFor(sessionUuid: string) {
  const { rows } = await getPool().query<{ requirement: string; severity: string }>(
    `SELECT f.requirement, f.severity FROM finding f
     JOIN transmission t ON t.id = f.transmission_id
     WHERE t.session_uuid = $1`,
    [sessionUuid],
  );
  return rows;
}

test(
  'full-flow: wrong Content-Type → proceeds past stage 4 (not halted), 1.2 finding recorded',
  { skip },
  async () => {
    // text/plain mismatches §1.2 but must NOT halt — the schema-valid JSON body
    // still parses, validates, and reaches downstream success (200). The body must
    // be genuinely valid now that stage 7 is live, else it would 422 on schema, not
    // on content-type, defeating what this test proves.
    const payload = Buffer.from(
      JSON.stringify({
        meta: {
          schemaVersion: '0.8.1',
          transferType: 'rtm',
          transferId: 'T-ct',
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
      'utf8',
    );
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(payload, { 'content-type': 'text/plain' });
      sessionUuid = out.sessionUuid;

      assert.equal(out.statusCode, 200, 'content-type mismatch does not short-circuit');

      const findings = await findingsFor(sessionUuid);
      assert.ok(hasFinding(findings, '1.2', 'fail'), '1.2 fail recorded for wrong Content-Type');
      // Proof we proceeded PAST stage 4: the parse stage (6) ran and passed.
      assert.ok(hasFinding(findings, '1.1', 'pass'), 'parse stage ran after content-type');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test(
  'full-flow: Content-Encoding gzip on non-gzip bytes → 400 with a 1.6 finding',
  { skip },
  async () => {
    // Plain JSON (no NUL) labelled gzip: won't gunzip → §1.6 fail + 400. The
    // REAL-gzip happy path (which used to 500 in persist, do5) is covered by its
    // own full-flow test below.
    const notGzip = Buffer.from('{"meta":{}}', 'utf8');
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(notGzip, {
        'content-type': JSON_UTF8,
        'content-encoding': 'gzip',
      });
      sessionUuid = out.sessionUuid;

      assert.equal(out.statusCode, 400);
      assert.ok(hasFinding(await findingsFor(sessionUuid), '1.6', 'fail'), '1.6 fail recorded');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test(
  'full-flow: malformed JSON → 400, raw_body persisted, parse_ok = false',
  { skip },
  async () => {
    const malformed = Buffer.from('{"meta":{ broken', 'utf8');
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(malformed, { 'content-type': JSON_UTF8 });
      sessionUuid = out.sessionUuid;

      assert.equal(out.statusCode, 400);
      assert.match(out.body.transmissionId ?? '', /^[0-9a-f-]{36}$/, 'row persisted despite 400');

      const { rows } = await getPool().query<{
        http_status: number;
        raw_body: string | null;
        parse_ok: boolean | null;
      }>(`SELECT http_status, raw_body, parse_ok FROM transmission WHERE session_uuid = $1`, [
        sessionUuid,
      ]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.http_status, 400);
      assert.equal(rows[0]?.parse_ok, false, 'parse_ok recorded false');
      assert.ok(rows[0]?.raw_body, 'raw_body retained (non-null) so a bad payload drills down');
      assert.equal(rows[0]?.raw_body, malformed.toString('utf8'), 'exact wire bytes retained');

      assert.ok(hasFinding(await findingsFor(sessionUuid), '1.1', 'fail'), '1.1 fail recorded');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test(
  'full-flow: oversized body (> 1MB) → our 413 + 1.4 finding + persisted row (6y3)',
  { skip },
  async () => {
    // One byte over the §1.4 cap, but UNDER Fastify's raised bodyLimit (2 MiB),
    // so it REACHES the size stage instead of getting Fastify's generic 413. The
    // body content is irrelevant — the size stage (stage 3) halts before parse.
    const oversized = Buffer.alloc(1_048_577, 0x61); // 'a' * (1MB + 1)
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(oversized, { 'content-type': JSON_UTF8 });
      sessionUuid = out.sessionUuid;

      assert.equal(out.statusCode, 413, 'our teaching 413, not Fastify generic');
      // Our response body shape (not Fastify's {statusCode,code,error,message}).
      assert.match(out.body.transmissionId ?? '', /^[0-9a-f-]{36}$/, 'row persisted on 413');

      const { rows } = await getPool().query<{ http_status: number; wire_bytes: string }>(
        `SELECT http_status, wire_bytes FROM transmission WHERE session_uuid = $1`,
        [sessionUuid],
      );
      assert.equal(rows.length, 1, 'exactly one row recorded');
      assert.equal(rows[0]?.http_status, 413);
      assert.equal(rows[0]?.wire_bytes, String(oversized.length), 'wire bytes measured pre-decode');
      assert.ok(hasFinding(await findingsFor(sessionUuid), '1.4', 'fail'), '1.4 fail recorded');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test(
  'full-flow: real gzip body → 200, decoded text persisted in raw_body, no 500 (do5)',
  { skip },
  async () => {
    // A schema-valid 0.8.1 payload, gzipped on the wire. The NUL bytes in the gzip
    // stream once made the raw_body text insert 500; route.ts now stores the
    // DECODED, NUL-stripped text. Whole flow must reach 200 with schema_ok=true.
    const json = JSON.stringify({
      meta: {
        schemaVersion: '0.8.1',
        transferType: 'rtm',
        transferId: 'T-gz-flow',
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
    });
    const gzipped = gzipSync(Buffer.from(json, 'utf8'));
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(gzipped, {
        'content-type': JSON_UTF8,
        'content-encoding': 'gzip',
      });
      sessionUuid = out.sessionUuid;

      assert.equal(out.statusCode, 200, 'valid gzip happy path reaches 200, not 500');
      assert.match(out.body.transmissionId ?? '', /^[0-9a-f-]{36}$/, 'row persisted');

      const { rows } = await getPool().query<{
        http_status: number;
        content_encoding: string | null;
        wire_bytes: string;
        raw_body: string | null;
        schema_ok: boolean | null;
      }>(
        `SELECT http_status, content_encoding, wire_bytes, raw_body, schema_ok
         FROM transmission WHERE session_uuid = $1`,
        [sessionUuid],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.http_status, 200);
      assert.equal(rows[0]?.content_encoding, 'gzip', 'wire encoding recorded');
      assert.equal(rows[0]?.wire_bytes, String(gzipped.length), 'wire bytes = compressed length');
      assert.equal(rows[0]?.schema_ok, true, 'decoded body validated clean');
      // raw_body is the DECODED, NUL-free JSON text (drill-down view), not gzip.
      assert.equal(rows[0]?.raw_body, json, 'raw_body holds decoded JSON text');
      assert.equal(
        rows[0]?.raw_body?.includes(String.fromCharCode(0)),
        false,
        'no NUL bytes stored',
      );

      assert.ok(hasFinding(await findingsFor(sessionUuid), '1.6', 'pass'), '1.6 pass recorded');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    }
  },
);

test.after(async () => {
  await closePool().catch(() => {});
});
