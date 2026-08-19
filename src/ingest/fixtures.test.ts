/**
 * Fixture transmissions as tests (bat.1; DESIGN.md §6, §14.8).
 *
 * One VALID baseline plus one fixture per conditional failure, asserting each
 * yields the §6 status code + the expected findings/response body. The fixtures
 * live in ./fixtures/transmissions.ts; this file wires them to the pipeline.
 *
 * TWO LAYERS (the cdd DB-dependence test strategy):
 *
 *  1. PIPELINE-LEVEL (no DB) — build a real {@link PipelineContext} and run the
 *     §6 body stages (3-8) directly via runPipeline, then shape the response with
 *     buildResponseBody. These need neither Postgres nor HTTP, so they ALWAYS run
 *     (not skip): valid, oversize, bad content-type, double-encoding, unparseable,
 *     schema-invalid. The schema/valid cases use the real SchemaRegistry.load()
 *     (synchronous, DB-free). The semantic stage's findPriorTransmissions dep is a
 *     no-DB stub returning [] (no prior rows) for the cases that reach stage 8.
 *
 *  2. DB-SKIP-GUARDED end-to-end (app.inject) — for cases that genuinely need
 *     persistence. The DUPLICATE case requires a prior row in the session, so it
 *     POSTs twice end-to-end; a valid-baseline 200 and a schema-invalid 422 are
 *     also asserted through the real route. These SKIP cleanly when no Postgres is
 *     reachable (skip-guard idiom from route.test.ts). To run them:
 *
 *       docker compose up -d postgres
 *       DATABASE_URL=postgresql://cce_validator:cce_validator@localhost:5432/cce_validator \
 *         npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closePool, getPool } from '../db/pool.js';
import { createSession } from '../db/repository.js';
import { SchemaRegistry } from '../schema-registry.js';
import {
  buildResponseBody,
  runPipeline,
  type IngestResponseBody,
  type PipelineContext,
  type Stage,
} from './pipeline.js';
import { contentTypeStage } from './stages/content-type.js';
import { encodingStage } from './stages/encoding.js';
import { parseStage } from './stages/parse.js';
import { schemaStage } from './stages/schema.js';
import { semanticStage, type SemanticDeps } from './stages/semantic.js';
import { sizeStage } from './stages/size.js';
import {
  JSON_UTF8,
  cloneValid,
  doubleEncodedBytes,
  duplicateBytes,
  oversizeBytes,
  schemaInvalidBytes,
  toBytes,
  unparseableBytes,
  validBytes,
  validTransmission,
} from './fixtures/transmissions.js';

// ── pipeline-level harness (no DB, no HTTP) ─────────────────────────────────

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

/** No-DB semantic deps: serial (count 1) and no prior transmissions. */
const noDbSemanticDeps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

/**
 * The §6 body stages (3-8) in order — mirrors route.ts `bodyStages`, rebuilt
 * here so the fixtures run against the real stage logic without a DB. (route.ts
 * does not export it; the stage list is the contract under test.)
 */
function bodyStages(): Stage[] {
  return [
    sizeStage(),
    contentTypeStage(),
    encodingStage(),
    parseStage(),
    schemaStage(),
    semanticStage(noDbSemanticDeps),
  ];
}

/** Build a real PipelineContext from raw bytes + headers (no DB/HTTP). */
function makeCtx(
  rawBody: Buffer,
  headers: { contentType?: string | null; contentEncoding?: string | null } = {},
): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'fixture-session',
    rawBody,
    registry,
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
    contentType: headers.contentType ?? null,
    contentEncoding: headers.contentEncoding ?? null,
    parseOk: null,
    schemaOk: null,
  };
}

/** Run the body stages over `ctx` and shape the teaching-surface response body. */
async function runFixture(ctx: PipelineContext): Promise<IngestResponseBody> {
  const result = await runPipeline(ctx, bodyStages());
  // transmissionId is null at pipeline level (persistence is the route's job).
  return buildResponseBody(result.status, result.findings, null);
}

function hasFinding(
  details: IngestResponseBody['findingDetails'],
  requirement: string,
  severity: string,
): boolean {
  return details.some((f) => f.requirement === requirement && f.severity === severity);
}

// ── pipeline-level: the seven cases (the no-DB six) ─────────────────────────

test('fixture valid → 200, no fail findings, accepted message', async () => {
  const ctx = makeCtx(validBytes(), { contentType: JSON_UTF8 });
  const body = await runFixture(ctx);

  assert.equal(body.status, 200);
  assert.equal(body.transmissionId, null);
  assert.match(body.message, /^Accepted \(200\)/);
  // No fail findings on the happy path; every stage records a pass/info.
  assert.equal(
    body.findingDetails.filter((f) => f.severity === 'fail').length,
    0,
    'valid baseline produces zero fail findings',
  );
  assert.ok(hasFinding(body.findingDetails, '3.2', 'pass'), 'schema validated clean');
  assert.equal(body.findings, body.findingDetails.length, 'count matches details');
  assert.deepEqual(body.advisories, [], 'the baseline raises no advisories');
});

/**
 * The baseline with its EDOP sent in another date form — a payload that is FULLY
 * conformant (the schema types EDOP as `["string","null"]` with no `format`, so
 * nothing grades its shape) yet raises `adv.date_format`. Exactly the case the
 * advisory category exists for, and the one 7rv is about.
 */
function advisoryOnlyBytes(): Buffer {
  const payload = cloneValid();
  payload.data[0]!.EDOP = '01/06/2021';
  return toBytes(payload);
}

test('a conformant payload raising an advisory tallies exactly as the baseline (7rv)', async () => {
  const baseline = await runFixture(makeCtx(validBytes(), { contentType: JSON_UTF8 }));
  const advised = await runFixture(makeCtx(advisoryOnlyBytes(), { contentType: JSON_UTF8 }));

  // Precondition: the payload really does raise an advisory, and no fail.
  assert.equal(advised.status, 200);
  assert.equal(advised.advisories.length, 1, 'adv.date_format raised');
  assert.equal(advised.advisories[0]?.requirement, 'adv.date_format');
  assert.equal(
    advised.findingDetails.filter((f) => f.severity === 'fail').length,
    0,
    '100 % conformant: no fail findings',
  );

  // THE CONTRACT: the graded count, the graded echo and the message tally read
  // exactly as they would had the advisory never been raised.
  const graded = (b: IngestResponseBody) =>
    b.findingDetails.map((f) => `${f.requirement}:${f.severity}`);
  assert.equal(advised.findings, baseline.findings, 'advisory does not inflate the count');
  assert.deepEqual(graded(advised), graded(baseline), 'advisory is absent from findingDetails');
  assert.ok(
    advised.message.startsWith(baseline.message),
    `tally must read as the no-advisory one: ${advised.message}`,
  );
  assert.doesNotMatch(baseline.message, /advisor/i);
  // Carried, not dropped: the response says they exist, outside the tally.
  assert.match(advised.message, /1 advisory, not graded and not counted above\.$/);
});

test('fixture oversize → 413, 1.4 fail (size stage)', async () => {
  const ctx = makeCtx(oversizeBytes(), { contentType: JSON_UTF8 });
  const body = await runFixture(ctx);

  assert.equal(body.status, 413);
  assert.match(body.message, /^Rejected \(413\)/);
  assert.ok(hasFinding(body.findingDetails, '1.4', 'fail'), '1.4 fail recorded');
  // Halted at stage 3 → no downstream parse/schema findings.
  assert.ok(!hasFinding(body.findingDetails, '1.1', 'pass'), 'parse stage never ran');
});

test('fixture bad content-type → 200 (finding; never halts) with a 1.2 fail', async () => {
  // text/plain mismatches §1.2 but stage 4 only records a finding and continues;
  // the body is otherwise valid so the run reaches the 200 success. (415 is
  // optional per §6; we assert what the code actually does — it does not halt.)
  const ctx = makeCtx(validBytes(), { contentType: 'text/plain' });
  const body = await runFixture(ctx);

  assert.equal(body.status, 200, 'content-type mismatch does not short-circuit');
  assert.ok(hasFinding(body.findingDetails, '1.2', 'fail'), '1.2 fail recorded');
  // Proof we proceeded past stage 4: parse + schema ran and passed.
  assert.ok(hasFinding(body.findingDetails, '1.1', 'pass'), 'parse ran after content-type');
  assert.ok(hasFinding(body.findingDetails, '3.2', 'pass'), 'schema ran after content-type');
});

test('fixture illegal double-encoding (gzip-of-gzip) → 400, 1.6 fail (encoding stage)', async () => {
  const ctx = makeCtx(doubleEncodedBytes(), {
    contentType: JSON_UTF8,
    contentEncoding: 'gzip',
  });
  const body = await runFixture(ctx);

  assert.equal(body.status, 400);
  assert.match(body.message, /^Rejected \(400\)/);
  assert.ok(hasFinding(body.findingDetails, '1.6', 'fail'), '1.6 fail recorded');
  const detail = body.findingDetails.find((f) => f.requirement === '1.6')?.detail ?? '';
  assert.match(detail, /double-encoding/, 'detail names the illegal double-encoding');
  assert.match(detail, /\(§1\.6\)$/, 'detail ends with its citation');
});

test('fixture unparseable → 400, 1.1 fail (parse stage)', async () => {
  const ctx = makeCtx(unparseableBytes(), { contentType: JSON_UTF8 });
  const body = await runFixture(ctx);

  assert.equal(body.status, 400);
  assert.match(body.message, /^Rejected \(400\)/);
  assert.ok(hasFinding(body.findingDetails, '1.1', 'fail'), '1.1 fail recorded');
  // Schema never runs after a parse halt.
  assert.ok(!hasFinding(body.findingDetails, '3.2', 'pass'), 'schema never ran');
});

test('fixture schema-invalid → 422, 3.2 fail (schema stage)', async () => {
  const ctx = makeCtx(schemaInvalidBytes(), { contentType: JSON_UTF8 });
  const body = await runFixture(ctx);

  assert.equal(body.status, 422);
  assert.match(body.message, /^Rejected \(422\)/);
  assert.ok(hasFinding(body.findingDetails, '3.2', 'fail'), '3.2 fail recorded');
  // Parse passed (the body is valid JSON); schema is what rejected it.
  assert.ok(hasFinding(body.findingDetails, '1.1', 'pass'), 'parse passed before schema');
  const detail = body.findingDetails.find((f) => f.severity === 'fail')?.detail ?? '';
  assert.match(detail, /\(§3\.2\)$/, 'schema fail detail ends with its citation');
});

// ── DB-skip-guarded end-to-end (app.inject): persistence-dependent cases ────

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

test(
  'full-flow: duplicate transferId/content → 2xx + 1.8 fail (semantic stage; needs a prior row)',
  { skip },
  async () => {
    const app = makeApp();
    await app.ready();
    let sessionUuid: string | undefined;
    try {
      const session = await createSession();
      sessionUuid = session.uuid;
      const headers = { 'content-type': JSON_UTF8 };

      // First POST: novel → accepted, 1.8 pass.
      const first = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers,
        payload: duplicateBytes(),
      });
      assert.equal(first.statusCode, 200, 'first transmission accepted');
      const firstBody = first.json() as IngestResponseBody;
      assert.ok(
        hasFinding(firstBody.findingDetails, '1.8', 'pass'),
        'first POST is novel (1.8 pass)',
      );

      // Second POST: byte-identical replay + repeated transferId → 2xx + 1.8 fail.
      const second = await app.inject({
        method: 'POST',
        url: `/i/${session.uuid}`,
        headers,
        payload: duplicateBytes(),
      });
      assert.ok(second.statusCode >= 200 && second.statusCode < 300, 'duplicate still 2xx');
      const secondBody = second.json() as IngestResponseBody;
      assert.ok(
        hasFinding(secondBody.findingDetails, '1.8', 'fail'),
        'duplicate observed → 1.8 fail',
      );
      const dup = secondBody.findingDetails.find((f) => f.requirement === '1.8');
      assert.match(dup?.detail ?? '', /duplicate observed/, 'detail names the duplicate');
      assert.match(dup?.detail ?? '', /§1\.8/, 'detail cites §1.8');
    } finally {
      if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
      await app.close();
    }
  },
);

test('full-flow: valid baseline → 200, persists a row', { skip }, async () => {
  const app = makeApp();
  await app.ready();
  let sessionUuid: string | undefined;
  try {
    const session = await createSession();
    sessionUuid = session.uuid;
    const res = await app.inject({
      method: 'POST',
      url: `/i/${session.uuid}`,
      headers: { 'content-type': JSON_UTF8 },
      payload: validBytes(),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as IngestResponseBody;
    assert.match(body.transmissionId ?? '', /^[0-9a-f-]{36}$/, 'persisted id returned');
    assert.equal(body.status, 200);
  } finally {
    if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    await app.close();
  }
});

test('full-flow: schema-invalid → 422 end-to-end, row persisted', { skip }, async () => {
  const app = makeApp();
  await app.ready();
  let sessionUuid: string | undefined;
  try {
    const session = await createSession();
    sessionUuid = session.uuid;
    const res = await app.inject({
      method: 'POST',
      url: `/i/${session.uuid}`,
      headers: { 'content-type': JSON_UTF8 },
      payload: schemaInvalidBytes(),
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as IngestResponseBody;
    assert.match(body.transmissionId ?? '', /^[0-9a-f-]{36}$/, 'row persisted despite 422');
    assert.ok(hasFinding(body.findingDetails, '3.2', 'fail'), '3.2 fail recorded');
  } finally {
    if (sessionUuid) await getPool().query('DELETE FROM session WHERE uuid = $1', [sessionUuid]);
    await app.close();
  }
});

// `toBytes` / `validTransmission` are re-exported building blocks; reference them
// so the import is used even if a future case drops its sole consumer.
test('fixture serialization is stable (sanity)', () => {
  assert.deepEqual(JSON.parse(toBytes(validTransmission).toString('utf8')), validTransmission);
});

test.after(async () => {
  await closePool().catch(() => {});
});
