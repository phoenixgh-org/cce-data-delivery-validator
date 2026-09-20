/**
 * Fixture transmissions as tests (bat.1; DESIGN.md §6).
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
import { emsBaseline } from '../exercise/baseline.js';
import { CONTRACT_PROFILE, SchemaRegistry } from '../schema-registry.js';
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
import { isAdvisoryId } from './stages/semantic/advisory.js';
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
  validTransmissionDualPass,
} from './fixtures/transmissions.js';

// ── pipeline-level harness (no DB, no HTTP) ─────────────────────────────────

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

/** No-DB semantic deps: serial (count 1) and no prior transmissions. */
const noDbSemanticDeps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
  findPriorUnitWindows: async () => [],
  findPriorUnitIdentities: async () => [],
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
    primaryProfile: null,
    shadowProfile: null,
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
  // `ctx` carries the registry and the lineage the schema stage shadowed —
  // what the trailing shadow sentence is built from (by1c.27).
  return buildResponseBody(result.status, result.findings, null, ctx);
}

/**
 * The GRADED fail findings of a run — the contract profile's, and only those.
 *
 * Since bd by1c.6 the schema stage also grades the transmission under the shadow
 * lineage, so a payload that is perfectly conformant today can carry shadow fail
 * findings describing how it would fare under DS01.3. Those are a different
 * profile's verdict and say nothing about this fixture's standing under the
 * contract, so a "zero fails" claim has to name which profile it is about. The
 * response body carries no profile field (it is the supplier's teaching surface,
 * not the API), so this reads the context the pipeline actually ran on.
 */
function contractFails(ctx: PipelineContext) {
  return contractGraded(ctx).filter((f) => f.severity === 'fail');
}

/** The graded (non-advisory) findings of the CONTRACT lineage — the body's tally. */
function contractGraded(ctx: PipelineContext) {
  return ctx.findings.filter(
    (f) => !isAdvisoryId(f.requirement) && f.profile !== ctx.shadowProfile,
  );
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
    contractFails(ctx).length,
    0,
    'valid baseline produces zero fail findings under the contract profile',
  );
  assert.ok(hasFinding(body.findingDetails, '3.2', 'pass'), 'schema validated clean');
  assert.deepEqual(body.advisories, [], 'the baseline raises no advisories');

  // THE HEADLINE IS THE CONTRACT TALLY (by1c.8). This fixture is the canonical
  // readiness demo: conformant under cce-interop 0.8.1, and missing five of the
  // logger-identity properties the DS01.3 Annex 4 draft requires. The shadow run
  // records those five failures and they are echoed in `findingDetails`, but
  // they grade a lineage that is not yet in force, so neither the count a
  // supplier reads as the outcome nor the one-line message may mention them.
  assert.ok(
    body.findingDetails.some((f) => f.severity === 'fail'),
    'precondition: the Annex 4 shadow run does fail this fixture',
  );
  assert.doesNotMatch(body.message, /fail/, 'the contract headline reports no failure');
  assert.equal(body.findings, contractGraded(ctx).length, 'the count is the contract-graded count');

  // Pinned exactly rather than as an inequality (by1c.27). These are the
  // PIPELINE-LEVEL counts: the §6 body stages only, so the route's own §1.3
  // auth finding is absent and the end-to-end body carries one more of each
  // (9 and 14 — pinned in the full-flow test below).
  assert.equal(body.findings, 8, 'eight contract-graded findings');
  assert.equal(body.findingDetails.length, 13, 'plus the five Annex 4 shadow fails');
  const shadow = body.findingDetails.filter((f) => f.profile === 'ds013');
  assert.equal(shadow.length, 5, 'the five logger-identity fails, listed but not counted');
  assert.ok(
    shadow.every((f) => f.severity === 'fail' && f.requirement === '5.3.2'),
    'each shadow entry names its own lineage and clause',
  );
  assert.ok(
    body.findingDetails.every((f) => f.profile === '2025' || f.profile === 'ds013'),
    'every echoed finding names the lineage that graded it',
  );

  // THE TRAILING SENTENCE (by1c.27). It is what tells a conformant supplier that
  // the five failures above graded an unpublished draft and moved nothing. Every
  // fact in it is read off the registry entry here too, so a re-pin of the draft
  // bytes moves the test and the message together.
  const draft = registry.get(registry.currentVersion('ds013')!)!;
  assert.equal(
    body.message,
    'Accepted (200): data recorded; 8 findings (1 info). ' +
      `5 further findings under the DS01.3 Annex 4 draft of ${draft.draftDate} ` +
      `(sha256 ${draft.sha256}) did not affect this status.`,
  );
  assert.match(draft.sha256, /^[0-9a-f]{64}$/, 'the hash is quoted in full, not shortened');
});

/**
 * The DUAL-PASS RTM FIXTURE's own guarantee (by1c.15), asserted against every
 * registered version of both lineages rather than against the two current ones.
 *
 * Iterating the registry is the point. A version list written out here would go
 * on claiming a guarantee the moment a third entry is vendored — the outdated
 * 0.8.0 cohort is exactly that case already — and the fixture is only useful to
 * the readiness exercise while it really passes everything registered. So the
 * test enumerates `provenance()` and asserts clean validation per entry, and a
 * newly registered version enrols itself.
 *
 * The other half of the pair is asserted below: {@link validTransmission} must
 * keep FAILING the shadow lineage on exactly the five logger-identity
 * properties, which is what makes it the readiness demo.
 */
test('the dual-pass fixture validates under every registered version of both lineages', () => {
  const versions = registry.provenance();
  assert.ok(versions.length > 1, 'more than one version is registered');
  assert.ok(
    versions.some((p) => p.profile !== CONTRACT_PROFILE),
    'both lineages are registered — otherwise "dual" proves nothing',
  );

  for (const { version, profile } of versions) {
    const entry = registry.get(version);
    assert.ok(entry, `registry cannot fetch its own registered version ${version}`);
    const valid = entry.validate(validTransmissionDualPass);
    assert.ok(
      valid,
      `dual-pass fixture rejected by ${profile} ${version}: ` +
        JSON.stringify(entry.validate.errors),
    );
  }
});

test('the readiness-demo fixture still fails the shadow lineage on the five L* properties', () => {
  // The guard on the OTHER fixture: validTransmission earns its place by passing
  // the contract and failing the draft on exactly LDOP/LMFR/LMOD/LPQS/LSER. If a
  // re-pin of the draft bytes ever relaxed that, the demo would quietly become a
  // second dual-pass fixture and the readiness surfaces would have nothing to
  // show — so the difference between the two fixtures is pinned here.
  const shadow = registry.shadowFor(CONTRACT_PROFILE);
  assert.ok(shadow, 'a shadow lineage is registered');
  assert.equal(shadow.validate(validTransmission), false, 'the demo must fail the draft');
  const missing = (shadow.validate.errors ?? [])
    .filter((e) => e.keyword === 'required')
    .map((e) => (e.params as { missingProperty?: string }).missingProperty)
    .sort();
  assert.deepEqual(missing, ['LDOP', 'LMFR', 'LMOD', 'LPQS', 'LSER']);
});

/**
 * A payload that passes BOTH lineages — the EMS baseline the exercise runner
 * ships. The shadow run records a single `pass` finding, and the response says
 * so: a supplier who is already DS01.3-ready learns it from the ingest response
 * without opening the dashboard.
 */
test('a dual-passing payload echoes the shadow PASS and says "Also passes…" (by1c.27)', async () => {
  const ctx = makeCtx(toBytes(emsBaseline({ caseId: 'dual-pass', index: 0 })), {
    contentType: JSON_UTF8,
  });
  const body = await runFixture(ctx);

  assert.equal(body.status, 200);
  const shadow = body.findingDetails.filter((f) => f.profile === 'ds013');
  assert.equal(shadow.length, 1, 'a clean shadow run records exactly one finding');
  assert.equal(shadow[0]?.severity, 'pass');
  assert.equal(shadow[0]?.requirement, '5.3.2');

  const draft = registry.get(registry.currentVersion('ds013')!)!;
  assert.match(
    body.message,
    new RegExp(
      `Also passes the DS01\\.3 Annex 4 draft of ${draft.draftDate} ` +
        `\\(sha256 ${draft.sha256}\\)\\.$`,
    ),
  );
});

/**
 * An unresolvable `schemaVersion` names no lineage, so no shadow run happens —
 * and the response says nothing about a second lineage at all. The silence is
 * the contract: a sentence about a draft the body was never graded against
 * would be a claim we cannot support.
 */
test('an unresolvable version → 422 with no shadow entries and no shadow sentence', async () => {
  const payload = cloneValid();
  payload.meta.schemaVersion = '9.9.9';
  const ctx = makeCtx(toBytes(payload), { contentType: JSON_UTF8 });
  const body = await runFixture(ctx);

  assert.equal(body.status, 422);
  assert.equal(ctx.shadowProfile, null, 'no resolved entry means no lineage to shadow');
  assert.equal(
    body.findingDetails.filter((f) => f.profile === 'ds013').length,
    0,
    'nothing was graded under the draft',
  );
  assert.doesNotMatch(body.message, /draft|sha256|further findings|Also passes/);
});

/**
 * ROLES SWAP WITH THE PAYLOAD (by1c.27). A supplier may declare the Annex 4
 * revision, which makes ds013 the primary lineage and the 2025 lineage the
 * shadow. Nothing in the sentence is a literal, so it names that lineage — and
 * describes published bytes as a schema rather than as a draft.
 *
 * The name comes from the ONE vocabulary both surfaces now read (bd by1c.32):
 * pipeline.ts kept a lineage map of its own until the names moved to
 * src/profile-vocabulary.ts, which the dashboard's provenance line reads too.
 * Which of the two forms the sentence takes is read off the ENTRY (bd by1c.49),
 * but both forms name the schema DOCUMENT — the `longName` — because the
 * sentence ends in the sha256 of the file that ran: "the cce-interop 0.8.1
 * schema" for a published entry, "the DS01.3 Annex 4 draft of 2026-09-08" for a
 * draft. The requirement package the dashboard's lens names ("UNICEF Q1 2025",
 * "DS01.3 DRAFT") is a different noun and stays off the wire (tfnv.1). The
 * shadow entry here is published, so the regex below requires the literal
 * "cce-interop".
 */
test('a ds013-primary payload names the 2025 lineage as its shadow', async () => {
  const payload = emsBaseline({ caseId: 'ds013-primary', index: 0 });
  payload.meta.schemaVersion = '1';
  const ctx = makeCtx(toBytes(payload), { contentType: JSON_UTF8 });
  const body = await runFixture(ctx);

  assert.equal(ctx.primaryProfile, 'ds013');
  assert.equal(ctx.shadowProfile, '2025');

  const current = registry.get(registry.currentVersion('2025')!)!;
  assert.match(
    body.message,
    new RegExp(
      `Also passes the cce-interop ${current.version.replace(/\./g, '\\.')} schema ` +
        `\\(sha256 ${current.sha256}\\)\\.$`,
    ),
  );
  assert.doesNotMatch(body.message, /DS01\.3/, 'the shadow here is the cce-interop lineage');
  assert.equal(
    body.findingDetails.filter((f) => f.profile === '2025' && f.requirement === '3.2').length,
    1,
    'the shadow §3.2 pass is echoed, naming its lineage',
  );
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
  const baselineCtx = makeCtx(validBytes(), { contentType: JSON_UTF8 });
  const baseline = await runFixture(baselineCtx);
  const advisedCtx = makeCtx(advisoryOnlyBytes(), { contentType: JSON_UTF8 });
  const advised = await runFixture(advisedCtx);

  // Precondition: the payload really does raise an advisory, and no fail.
  assert.equal(advised.status, 200);
  assert.equal(advised.advisories.length, 1, 'adv.date_format raised');
  assert.equal(advised.advisories[0]?.requirement, 'adv.date_format');
  assert.equal(
    contractFails(advisedCtx).length,
    0,
    '100 % conformant under the contract profile: no fail findings',
  );

  // THE CONTRACT: the graded count and the graded echo read exactly as they
  // would had the advisory never been raised.
  //
  // Compared under the CONTRACT PROFILE. The mis-shaped date this fixture
  // carries IS a schema failure under the DS01.3 Annex 4 draft (its date objects
  // carry a pattern that 0.8.1's do not), so the shadow run legitimately says
  // something about the advised payload that it does not say about the baseline.
  // That is the two-surface design of bd by1c.6 item 8, not advisory leakage:
  // what 7rv protects is the contract tally, which is what is compared here.
  const graded = (ctx: PipelineContext) =>
    ctx.findings
      .filter((f) => !isAdvisoryId(f.requirement) && f.profile !== ctx.shadowProfile)
      .map((f) => `${f.requirement}:${f.severity}`);
  assert.equal(
    graded(advisedCtx).length,
    graded(baselineCtx).length,
    'advisory does not inflate the contract-profile count',
  );
  assert.deepEqual(graded(advisedCtx), graded(baselineCtx), 'advisory is absent from the grade');
  // The tally in the headline is the GRADED tally: the advisory contributed
  // nothing to the count or to the fail/info breakdown, and appears only in its
  // own trailing sentence.
  //
  // This used to be pinned as `advised.message.startsWith(baseline.message)`,
  // which no longer holds for a reason that has nothing to do with advisories:
  // the two payloads differ under the SHADOW profile (Annex 4 patterns the date
  // objects), so their DETAIL lists differ by that one shadow finding. The
  // property 7rv is about is per-payload, so it is pinned per payload here.
  // Since by1c.8 the tally itself is contract-only, so the shadow finding is
  // absent from both the count and the fail/info breakdown.
  const fails = contractGraded(advisedCtx).filter((f) => f.severity === 'fail').length;
  const infos = contractGraded(advisedCtx).filter((f) => f.severity === 'info').length;
  const headline = advised.message.replace(/ 1 advisory,.*$/, '');
  assert.equal(fails, 0, 'nothing fails this payload under the contract');
  assert.equal(
    headline,
    `Accepted (200): data recorded; ${advised.findings} findings (${infos} info).`,
    'the tally is the contract-graded tally, with no advisory folded into it',
  );
  assert.doesNotMatch(baseline.message, /advisor/i);
  assert.doesNotMatch(headline, /advisor/i);
  // Carried, not dropped: the response says they exist, outside the tally. No
  // longer the LAST sentence: since by1c.27 the shadow lineage gets one of its
  // own after it, and this payload's mis-shaped date does fail the Annex 4 draft.
  assert.match(advised.message, /1 advisory, not graded and not counted above\. /);
  assert.match(advised.message, /further findings under the DS01\.3 Annex 4 draft of .* status\.$/);
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

    // THE WHOLE BODY, END TO END (by1c.27). This is the canonical readiness
    // demo — conformant under cce-interop 0.8.1, short of five logger-identity
    // objects the Annex 4 draft wants — so it is the body a supplier is most
    // likely to be reading when they meet a `severity: 'fail'` under an HTTP
    // 200. Counts are one higher than the pipeline-level test above because the
    // route runs the §1.3 auth stage as well.
    assert.equal(body.findings, 9, 'nine contract-graded findings');
    assert.equal(body.findingDetails.length, 14, 'plus the five Annex 4 shadow fails');
    assert.ok(
      body.findingDetails.every((f) => f.profile === '2025' || f.profile === 'ds013'),
      'every echoed finding names the lineage that graded it',
    );
    const draft = registry.get(registry.currentVersion('ds013')!)!;
    assert.equal(
      body.message,
      'Accepted (200): data recorded; 9 findings (2 info). ' +
        `5 further findings under the DS01.3 Annex 4 draft of ${draft.draftDate} ` +
        `(sha256 ${draft.sha256}) did not affect this status.`,
    );
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
