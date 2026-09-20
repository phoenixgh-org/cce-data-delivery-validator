/**
 * Stage 7 (schema validate) tests (3bn.6).
 *
 * Two layers, mirroring body-stages.test.ts:
 *
 *  1. STAGE-UNIT tests — drive `schemaStage().run()` against a hand-built
 *     {@link PipelineContext} carrying a REAL {@link SchemaRegistry} (loaded from
 *     the vendored bytes). No DB, no HTTP — these always run and prove the
 *     stage's branches: unknown version → 422, invalid body → 422 with one
 *     finding per non-container Ajv error (each with a JSON Pointer), a
 *     genuinely-valid current-version transmission → continue with
 *     schemaOk = true + a §3.2 pass, and a valid-but-outdated version →
 *     continue + a §3.2 info(outdated).
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

import type { ErrorObject, ValidateFunction } from 'ajv';

import { buildApp } from '../../app.js';
import { closePool, getPool } from '../../db/pool.js';
import { createSession } from '../../db/repository.js';
import { emsBaseline } from '../../exercise/baseline.js';
import { duplicateVersionStringsIntoRecords } from '../../exercise/transforms/payload.js';
import { SchemaRegistry, type Profile, type RegistryEntry } from '../../schema-registry.js';
import { cloneValid } from '../fixtures/transmissions.js';
import type { Finding, PipelineContext, StageOutcome } from '../pipeline.js';
import {
  identifyingParam,
  isContainerError,
  schemaStage,
  translateNullExplanations,
} from './schema.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const JSON_UTF8 = 'application/json; charset=utf-8';

/**
 * The registered version that is NOT current — the outdated-but-valid cohort.
 *
 * These tests used to synthesize that cohort: a stub registry reported a fake
 * `9.9.9` as current so the real 0.8.1 would resolve as outdated, because the
 * registry then vendored a single version and the outdated branch had no live
 * case at all. 0.8.0 is registered again as of bd 8qa.4 (2026-08-04) precisely so
 * that branch has a real one, so the stub is gone and these tests now drive the
 * genuine article: the real registry, the real currency comparison, and a body
 * validated by 0.8.0's own compiled draft-07 validator rather than 0.8.1's.
 *
 * Named rather than inlined so the day 0.8.0 stops being the oldest registered
 * version, the fix is one constant — and so `npm test` states the assumption it
 * is making about the registry's shape (../../schema-registry.test.ts pins it).
 */
const OUTDATED_VERSION = '0.8.0';

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

/**
 * The same transmission, declaring {@link OUTDATED_VERSION}. Valid against that
 * version's own bytes too — the releases differ on bounds for data objects this
 * body does not carry (ACCD, BLOG), so only the currency verdict changes.
 */
function outdatedPayload(): Record<string, unknown> {
  const payload = validPayload();
  (payload.meta as Record<string, unknown>).schemaVersion = OUTDATED_VERSION;
  (payload.meta as Record<string, unknown>).transferId = 'T-outdated-1';
  return payload;
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
    primaryProfile: null,
    shadowProfile: null,
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: true,
    schemaOk: null,
  };
}

function findingsBy(findings: Finding[], requirement: string, severity: string) {
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

test('schema: parseable-but-invalid body → halt 422, one finding per non-container Ajv error with pointers', () => {
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
  assert.ok(fails.length >= 1, 'at least one fail finding per non-container Ajv error');
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

/**
 * A registry whose single entry always fails with the given Ajv errors.
 *
 * The container-only failure below cannot be produced from the vendored bytes —
 * Ajv always reports the leaf errors underneath a combining keyword — so the
 * guard's new trigger is exercised with a hand-built ErrorObject list, the way
 * the pure-translation tests further down do.
 */
function failingRegistry(errors: ErrorObject[]): SchemaRegistry {
  const validate = Object.assign(() => false, { errors }) as unknown as ValidateFunction;
  const entry: RegistryEntry = {
    version: '0.8.1',
    sha256: 'f'.repeat(64),
    profile: '2025',
    validate,
  };
  return {
    lookup: () => ({ ok: true as const, entry }),
    shadowFor: () => null,
    acceptedVersions: () => ['0.8.1'],
    currentVersion: () => '0.8.1',
  } as unknown as SchemaRegistry;
}

test('schema: a failure of ONLY container errors still halts 422 with one finding', () => {
  // The never-zero-findings guard (bd bt8o): suppressing every error Ajv
  // returned must not leave a rejected transmission with no §3.2 / 5.3.2
  // finding to explain it, so the stage falls back to the single
  // tx.schema_invalid.
  const errors = [
    { keyword: 'if', instancePath: '', schemaPath: '#/if', params: { failingKeyword: 'then' } },
    { keyword: 'oneOf', instancePath: '/data/0', schemaPath: '#/allOf/0/oneOf', params: {} },
  ] as unknown as ErrorObject[];
  const ctx = makeCtx(validPayload(), failingRegistry(errors));
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.deepEqual(outcome, { kind: 'halt', status: 422 }, 'the rejection still stands');
  assert.equal(ctx.schemaOk, false);
  assert.equal(ctx.findings.length, 1, 'exactly one finding, not zero and not the containers');
  const only = ctx.findings[0];
  assert.equal(only?.code, 'tx.schema_invalid');
  assert.equal(only?.requirement, '3.2');
  assert.equal(only?.severity, 'fail');
  assert.equal(only?.profile, '2025');
  assert.match(only?.detail ?? '', /failed validation against schema 0\.8\.1/);
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
  // A body declaring the OLDER registered version against the REAL registry, so
  // it resolves as outdated-but-valid: 0.8.0's own compiled validator accepts it
  // and the body is ACCEPTED (continue, schemaOk true), but the stage records a
  // §3.2 info finding flagged `outdated` — never a pass/fail. This is the branch
  // the live pass-outdated exercise case rides (src/exercise/cases/payload.ts).
  const current = registry.currentVersion();
  assert.notEqual(OUTDATED_VERSION, current, 'the fixture version really is not current');

  const ctx = makeCtx(outdatedPayload());
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.equal(outcome.kind, 'continue', 'outdated-but-valid payload is still accepted');
  assert.equal(ctx.schemaOk, true);
  assert.equal(ctx.normalizedSchemaVersion, OUTDATED_VERSION);
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
  assert.match(
    infos[0]?.detail ?? '',
    new RegExp(OUTDATED_VERSION.replace(/\./g, '\\.')),
    'names the declared version',
  );
  assert.match(
    infos[0]?.detail ?? '',
    new RegExp((current ?? '').replace(/\./g, '\\.')),
    'names the current version to upgrade to',
  );
});

// ── stage-unit: the shadow run (by1c.6, by1c.21) ────────────────────────────
//
// A transmission whose declared `schemaVersion` resolves to a registered lineage
// is graded twice: that lineage is the PRIMARY and drives the status, the
// current entry of the other lineage runs as SHADOW and never does. Findings are
// numbered by the PROFILE that produced them, not by the role it played — the
// Annex 4 validator files 5.3.2 (or 5.3.3 under /meta) whether it ran as primary
// or as shadow, and a cce-interop validator files §3.2 either way.

/** Findings attributed to one profile. */
function byProfile(findings: Finding[], profile: Profile) {
  return findings.filter((f) => f.profile === profile);
}

test('shadow: the RTM fixture passes 2025 and records five ds013 5.3.2 identity fails', () => {
  const ctx = makeCtx(cloneValid());
  const outcome = schemaStage().run(ctx) as StageOutcome;

  // The contract verdict is untouched: accepted, with the §3.2 pass.
  assert.equal(outcome.kind, 'continue', 'the shadow run never changes the status');
  assert.equal(ctx.schemaOk, true);
  assert.equal(ctx.primaryProfile, '2025');
  assert.equal(ctx.shadowProfile, 'ds013');
  assert.equal(findingsBy(ctx.findings, '3.2', 'pass').length, 1, 'one §3.2 pass');

  // The shadow verdict: the Annex 4 draft requires the five logger-identity
  // objects on an rtmd-report, and this fixture carries none of them.
  const shadow = byProfile(ctx.findings, 'ds013');
  assert.equal(shadow.length, 5, `exactly five shadow findings, got ${JSON.stringify(shadow)}`);
  for (const f of shadow) {
    assert.equal(f.severity, 'fail');
    assert.equal(f.requirement, '5.3.2', 'a body-level Annex 4 error is clause 5.3.2');
    assert.equal(f.keyword, 'required');
    assert.equal(f.pointer, '/data/0');
  }
  assert.deepEqual(
    shadow.map((f) => f.param).sort(),
    ['LDOP', 'LMFR', 'LMOD', 'LPQS', 'LSER'],
    'the five logger-identity objects, each its own signature',
  );
  // The root `if` Ajv emits alongside them carries no location and is suppressed.
  assert.equal(
    ctx.findings.filter((f) => f.keyword === 'if').length,
    0,
    'no container-keyword finding reaches the supplier',
  );
});

test('shadow: a transferredAt offset adds ONE 5.3.3 finding on top of the five', () => {
  const payload = cloneValid();
  payload.meta.transferredAt = '2024-01-15T04:05:54+03:00';
  const ctx = makeCtx(payload);
  const outcome = schemaStage().run(ctx) as StageOutcome;

  // 0.8.1 patterns transferredAt too, so the PRIMARY run rejects this body. The
  // shadow run is recorded all the same — only the status is primary-only.
  assert.deepEqual(outcome, { kind: 'halt', status: 422 });

  const shadow = byProfile(ctx.findings, 'ds013');
  assert.equal(shadow.length, 6, 'the five identity fails plus the metadata one');
  const meta = shadow.filter((f) => f.requirement === '5.3.3');
  assert.equal(meta.length, 1, 'one clause-5.3.3 finding');
  assert.equal(meta[0]?.keyword, 'pattern');
  assert.equal(meta[0]?.pointer, '/meta/transferredAt');
  assert.equal(
    typeof meta[0]?.param,
    'string',
    'a pattern failure names its pattern, so two paths do not share one signature',
  );
  assert.equal(
    shadow.filter((f) => f.requirement === '5.3.2').length,
    5,
    'everything outside /meta stays 5.3.2',
  );
});

test('shadow: the EMS exercise baseline passes the Annex 4 draft — one ds013 5.3.2 PASS', () => {
  const ctx = makeCtx(emsBaseline({ caseId: 'shadow-pass', index: 0 }));
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.equal(outcome.kind, 'continue');
  assert.equal(ctx.schemaOk, true);
  const shadow = byProfile(ctx.findings, 'ds013');
  assert.equal(shadow.length, 1, 'a clean shadow run records exactly one finding');
  assert.equal(shadow[0]?.severity, 'pass', 'passing the other profile is a recorded fact');
  assert.equal(shadow[0]?.requirement, '5.3.2');
  assert.match(shadow[0]?.detail ?? '', /DRAFT 1 \(draft \d{4}-\d{2}-\d{2}, sha256 [0-9a-f]{64}\)/);
  assert.doesNotMatch(shadow[0]?.detail ?? '', /official/, 'an unpublished draft is not official');
});

test('shadow: a null sensed value collapses to ONE tx.null_unexplained finding', () => {
  // The Annex 4 draft (like 0.8.1) encodes "a null reading must be explained" as
  // a record-level oneOf. Ajv says it in three errors; the supplier is told once.
  const payload = emsBaseline({ caseId: 'null-tvc', index: 0 });
  (payload.data[0]!.records as Record<string, unknown>[])[1]!.TVC = null;
  const ctx = makeCtx(payload);
  schemaStage().run(ctx);

  const shadow = byProfile(ctx.findings, 'ds013');
  assert.equal(shadow.length, 1, `one shadow finding, got ${JSON.stringify(shadow)}`);
  assert.equal(shadow[0]?.code, 'tx.null_unexplained');
  assert.equal(shadow[0]?.requirement, '5.3.2');
  assert.equal(shadow[0]?.severity, 'fail');
  assert.equal(shadow[0]?.pointer, '/data/0/records/1');
  assert.equal(shadow[0]?.param, 'TVC');
  assert.match(shadow[0]?.detail ?? '', /null TVC without an explaining LERR\/EERR/);
});

test('shadow: a SECOND failing record keeps its own findings (by1c.24)', () => {
  // Two records fail the same record-level oneOf for different reasons. Ajv's
  // schemaPath is a position in the SCHEMA, shared by every item of the array,
  // so gathering a container's leaves by schemaPath alone hands record 0's
  // collapse the leaves of record 1 as well — and record 1's defect is then
  // dropped rather than reported. The translation must stay inside its record.
  const payload = emsBaseline({ caseId: 'two-bad-records', index: 0 });
  const records = payload.data[0]!.records as Record<string, unknown>[];
  records[0]!.TVC = null; // LERR is null in the baseline: an unexplained null.
  delete records[1]!.TVC; // a different defect entirely: the reading is absent.
  const ctx = makeCtx(payload);
  schemaStage().run(ctx);

  const shadow = byProfile(ctx.findings, 'ds013');
  const collapsed = shadow.filter((f) => f.code === 'tx.null_unexplained');
  assert.equal(collapsed.length, 1, `only record 0 collapses, got ${JSON.stringify(shadow)}`);
  assert.equal(collapsed[0]?.pointer, '/data/0/records/0');
  assert.equal(collapsed[0]?.param, 'TVC');

  // Record 1's missing reading still reaches the supplier. Ajv emits the
  // `required` error once per failing branch of the oneOf, so the count is not
  // 1 — what this pins is that the shadow run reports it as often as the
  // contract run does, rather than silently losing it.
  const missingTvc = (profile: Profile) =>
    byProfile(ctx.findings, profile).filter(
      (f) => f.pointer === '/data/0/records/1' && f.keyword === 'required' && f.param === 'TVC',
    ).length;
  assert.ok(missingTvc('ds013') > 0, 'record 1 is not swallowed by record 0 collapse');
  assert.equal(missingTvc('ds013'), missingTvc('2025'), 'shadow loses nothing the contract sees');
});

test('shadow: a wrong-TYPE second record keeps both of its branch errors (by1c.24)', () => {
  // The same scoping defect, in its other live shape: a string where a number
  // belongs trips both branches of record 1's oneOf ("must be number" and "must
  // be null"), and both were being absorbed into record 0's collapse.
  const payload = emsBaseline({ caseId: 'two-bad-records-type', index: 0 });
  const records = payload.data[0]!.records as Record<string, unknown>[];
  records[0]!.TVC = null;
  records[1]!.TVC = 'not-a-number';
  const ctx = makeCtx(payload);
  schemaStage().run(ctx);

  const shadow = byProfile(ctx.findings, 'ds013');
  assert.equal(shadow.filter((f) => f.code === 'tx.null_unexplained').length, 1);
  const branchTypes = shadow
    .filter((f) => f.pointer === '/data/0/records/1/TVC' && f.keyword === 'type')
    .map((f) => f.param);
  assert.ok(branchTypes.includes('number'), `normal branch kept, got ${branchTypes.join('|')}`);
  assert.ok(branchTypes.includes('null'), `abnormal branch kept, got ${branchTypes.join('|')}`);
});

test('shadow: a container-only failure records ONE 5.3.2 fail, as the primary does (xtss)', () => {
  // The never-zero-findings guard, on the shadow half. The exercise suite's
  // '3.2-fail-ems-version-strings-in-both-places' body satisfies BOTH branches of
  // each version-string `oneOf`, and a oneOf matched twice is violated — so Ajv
  // returns nothing but containers (two `oneOf`s at /data/0 and the root `if`)
  // under EITHER lineage. Suppressing all three used to leave the shadow clause
  // recording neither a pass nor a fail for a transmission the draft rejected, so
  // 5.3.2's tally could only understate the draft's rejections.
  const payload = duplicateVersionStringsIntoRecords().apply(
    emsBaseline({ caseId: 'shadow-container-only', index: 0 }),
  );
  const ctx = makeCtx(payload);
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.deepEqual(outcome, { kind: 'halt', status: 422 }, 'the primary rejection still stands');
  assert.equal(ctx.primaryProfile, '2025');
  assert.equal(ctx.shadowProfile, 'ds013');
  assert.equal(
    ctx.findings.filter((f) => f.keyword !== undefined).length,
    0,
    'no container-keyword finding reaches the supplier on either run',
  );

  const shadow = byProfile(ctx.findings, 'ds013');
  assert.equal(shadow.length, 1, `exactly one shadow finding, got ${JSON.stringify(shadow)}`);
  assert.equal(shadow[0]?.severity, 'fail', 'a rejection the draft made is recorded as a fail');
  assert.equal(shadow[0]?.requirement, '5.3.2', "the SHADOW validator's clause, not §3.2");
  assert.equal(shadow[0]?.code, 'tx.schema_invalid');
  assert.match(shadow[0]?.detail ?? '', /failed validation against schema 1 \(§5\.3\.2\)/);

  // The primary path is unchanged: the same single fallback, under its own clause.
  const primary = byProfile(ctx.findings, '2025');
  assert.equal(primary.length, 1, `exactly one primary finding, got ${JSON.stringify(primary)}`);
  assert.equal(primary[0]?.code, 'tx.schema_invalid');
  assert.equal(primary[0]?.requirement, '3.2');
});

test('translateNullExplanations scopes leaves to their own record', () => {
  // Pure-unit mirror of the two-record case, with record 10 as the sibling: the
  // record pointer must be matched on the segment boundary, or `/records/10/...`
  // reads as being inside `/records/1`.
  const errors = [
    {
      keyword: 'type',
      instancePath: '/data/0/records/1/TVC',
      schemaPath: '#/allOf/1/oneOf/0/properties/TVC/type',
      params: { type: 'number' },
    },
    {
      keyword: 'type',
      instancePath: '/data/0/records/1/LERR',
      schemaPath: '#/allOf/1/oneOf/1/properties/LERR/type',
      params: { type: 'string' },
    },
    {
      keyword: 'oneOf',
      instancePath: '/data/0/records/1',
      schemaPath: '#/allOf/1/oneOf',
      params: {},
    },
    // Record 10 fails the SAME oneOf — same schemaPath, different record.
    {
      keyword: 'required',
      instancePath: '/data/0/records/10',
      schemaPath: '#/allOf/1/oneOf/0/required',
      params: { missingProperty: 'TVC' },
    },
    {
      keyword: 'type',
      instancePath: '/data/0/records/10/LERR',
      schemaPath: '#/allOf/1/oneOf/1/properties/LERR/type',
      params: { type: 'string' },
    },
    {
      keyword: 'oneOf',
      instancePath: '/data/0/records/10',
      schemaPath: '#/allOf/1/oneOf',
      params: {},
    },
  ] as unknown as ErrorObject[];

  const { explanations, remaining } = translateNullExplanations(errors);
  assert.equal(explanations.length, 1, 'only record 1 shows both halves of the rule');
  assert.equal(explanations[0]?.pointer, '/data/0/records/1');
  assert.equal(explanations[0]?.replaces.length, 2, 'it stands for its own two leaves only');
  const kept = remaining.map((e) => `${e.keyword}@${e.instancePath}`);
  assert.deepEqual(kept, [
    'oneOf@/data/0/records/1',
    'required@/data/0/records/10',
    'type@/data/0/records/10/LERR',
    'oneOf@/data/0/records/10',
  ]);
});

test('shadow: an unresolved schemaVersion runs no shadow at all', () => {
  const ctx = makeCtx({ meta: { schemaVersion: '9.9.9', transferType: 'rtm' }, data: [] });
  schemaStage().run(ctx);

  assert.equal(ctx.primaryProfile, null, 'no resolved entry means no lineage');
  assert.equal(ctx.shadowProfile, null);
  assert.equal(byProfile(ctx.findings, 'ds013').length, 0, 'zero shadow findings');
  assert.equal(ctx.findings.length, 1, 'only the unsupported-version finding');
});

// ── stage-unit: a payload declaring the ds013 lineage (by1c.21) ─────────────
//
// `lookup()` resolves the Annex 4 key '1', so a supplier may declare it. When
// they do, the Annex 4 draft is the PRIMARY validator — and its findings are
// numbered 5.3.x under profile ds013, never §3.2 under the contract lineage,
// because the numbering follows the validator that produced them.

test('ds013 primary: a body failing Annex 4 → 422 with ONLY ds013 5.3.x findings', () => {
  const payload = cloneValid();
  payload.meta.schemaVersion = '1';
  const ctx = makeCtx(payload);
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.deepEqual(outcome, { kind: 'halt', status: 422 });
  assert.equal(ctx.schemaOk, false);
  assert.equal(ctx.normalizedSchemaVersion, '1');
  assert.equal(ctx.primaryProfile, 'ds013');
  assert.equal(ctx.shadowProfile, '2025');

  const primary = byProfile(ctx.findings, 'ds013');
  for (const f of primary) {
    assert.equal(f.severity, 'fail');
    assert.equal(f.requirement, '5.3.2', 'never the contract clause §3.2');
  }
  assert.deepEqual(
    primary
      .filter((f) => f.keyword === 'required')
      .map((f) => f.param)
      .sort(),
    ['LDOP', 'LMFR', 'LMOD', 'LPQS', 'LSER'],
    'the five logger-identity objects',
  );
  // Ajv also emits a root `if` alongside them. by1c.6 suppressed containers on
  // the shadow run first; bd bt8o extended the same predicate to the primary run,
  // so that finding is gone and the five identity fails are the whole verdict.
  assert.equal(primary.length, 5, 'the five identity fails, and nothing else');
  assert.equal(
    ctx.findings.filter((f) => f.keyword === 'if').length,
    0,
    'no container-keyword finding reaches the supplier on the primary run either',
  );
  assert.equal(
    ctx.findings.filter((f) => f.requirement === '3.2' && f.severity === 'fail').length,
    0,
    'the contract clause records no failure it did not observe',
  );

  // The same body IS valid 0.8.1, so the shadow run records that fact.
  const shadow = byProfile(ctx.findings, '2025');
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0]?.severity, 'pass');
  assert.equal(shadow[0]?.requirement, '3.2');
});

test('ds013 primary: a clean body passes as a DRAFT, and shadow-passes 0.8.1', () => {
  const payload = emsBaseline({ caseId: 'ds013-clean', index: 0 });
  payload.meta.schemaVersion = '1';
  const ctx = makeCtx(payload);
  const outcome = schemaStage().run(ctx) as StageOutcome;

  assert.equal(outcome.kind, 'continue');
  assert.equal(ctx.schemaOk, true);

  const primary = byProfile(ctx.findings, 'ds013');
  assert.equal(primary.length, 1);
  assert.equal(primary[0]?.severity, 'pass');
  assert.equal(primary[0]?.requirement, '5.3.2');
  // by1c.21: the word "official" was a false claim about unpublished bytes.
  assert.match(primary[0]?.detail ?? '', /validated against DRAFT 1 \(draft \d{4}-\d{2}-\d{2}, /);
  assert.doesNotMatch(primary[0]?.detail ?? '', /official/);

  const shadow = byProfile(ctx.findings, '2025');
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0]?.severity, 'pass');
  assert.equal(shadow[0]?.requirement, '3.2');
});

test('a published entry is still called official', () => {
  const ctx = makeCtx(validPayload());
  schemaStage().run(ctx);
  const pass = findingsBy(ctx.findings, '3.2', 'pass')[0];
  assert.match(pass?.detail ?? '', /validated against official 0\.8\.1 \(sha256 [0-9a-f]{64}\)/);
  assert.doesNotMatch(pass?.detail ?? '', /DRAFT/);
});

// ── unit: the two pure translations (bt8o reuses isContainerError; the
//    null-explanation collapse stays shadow-only) ────────────────────────────

test('isContainerError names the combining keywords and nothing else', () => {
  const err = (keyword: string) => ({ keyword }) as unknown as ErrorObject;
  for (const keyword of ['if', 'then', 'else', 'oneOf', 'anyOf', 'allOf']) {
    assert.equal(isContainerError(err(keyword)), true, `${keyword} is a container`);
  }
  for (const keyword of ['required', 'pattern', 'type', 'minLength', 'not']) {
    assert.equal(isContainerError(err(keyword)), false, `${keyword} asserts something itself`);
  }
});

test('translateNullExplanations leaves a oneOf it does not recognize alone', () => {
  // The mains/solar partition is a record-level oneOf too, but its leaves sit AT
  // the record rather than under it, so nothing about a null reading is claimed.
  const errors = [
    {
      keyword: 'required',
      instancePath: '/data/0/records/0',
      schemaPath: '#/allOf/0/oneOf/0/required',
      params: { missingProperty: 'SVA' },
    },
    {
      keyword: 'oneOf',
      instancePath: '/data/0/records/0',
      schemaPath: '#/allOf/0/oneOf',
      params: {},
    },
  ] as unknown as ErrorObject[];
  const { explanations, remaining } = translateNullExplanations(errors);
  assert.deepEqual(explanations, []);
  assert.equal(remaining.length, 2, 'every error is handed back untouched');
});

test('translateNullExplanations leaves a wrong-TYPE reading alone', () => {
  // A string where a number belongs trips the abnormal branch's "must be null"
  // too, so the object carries a null-admitting type error and is not a null.
  const errors = [
    {
      keyword: 'type',
      instancePath: '/data/0/records/1/TVC',
      schemaPath: '#/allOf/1/oneOf/0/properties/TVC/type',
      params: { type: 'number' },
    },
    {
      keyword: 'type',
      instancePath: '/data/0/records/1/LERR',
      schemaPath: '#/allOf/1/oneOf/1/properties/LERR/type',
      params: { type: 'string' },
    },
    {
      keyword: 'type',
      instancePath: '/data/0/records/1/TVC',
      schemaPath: '#/allOf/1/oneOf/1/properties/TVC/type',
      params: { type: 'null' },
    },
    {
      keyword: 'oneOf',
      instancePath: '/data/0/records/1',
      schemaPath: '#/allOf/1/oneOf',
      params: {},
    },
  ] as unknown as ErrorObject[];
  assert.deepEqual(translateNullExplanations(errors).explanations, []);
});

test('translateNullExplanations reads an ABSENT explainer as unexplained too', () => {
  // The other live shape: the reading is null and LERR was never sent at all.
  const errors = [
    {
      keyword: 'type',
      instancePath: '/data/0/records/1/TVC',
      schemaPath: '#/allOf/1/oneOf/0/properties/TVC/type',
      params: { type: 'number' },
    },
    {
      keyword: 'required',
      instancePath: '/data/0/records/1',
      schemaPath: '#/allOf/1/oneOf/1/required',
      params: { missingProperty: 'LERR' },
    },
    {
      keyword: 'oneOf',
      instancePath: '/data/0/records/1',
      schemaPath: '#/allOf/1/oneOf',
      params: {},
    },
  ] as unknown as ErrorObject[];
  const { explanations, remaining } = translateNullExplanations(errors);
  assert.equal(explanations.length, 1);
  assert.equal(explanations[0]?.object, 'TVC');
  assert.equal(explanations[0]?.pointer, '/data/0/records/1');
  assert.equal(remaining.length, 1, 'only the oneOf container is left to suppress');
});

test('identifyingParam names the pattern and the length limit', () => {
  // Annex 4 applies both widely; without these every pattern failure in a
  // transmission would sign identically and collapse into one dashboard row.
  const err = (keyword: string, params: Record<string, unknown>) =>
    ({ keyword, params }) as unknown as ErrorObject;
  assert.equal(identifyingParam(err('pattern', { pattern: '^[0-9]{4}$' })), '^[0-9]{4}$');
  assert.equal(identifyingParam(err('minLength', { limit: 1 })), '1');
  assert.equal(identifyingParam(err('maxLength', { limit: 64 })), '64');
  assert.equal(identifyingParam(err('not', {})), null, 'an unlisted keyword still has none');
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

async function postToSession(payload: Buffer): Promise<{
  statusCode: number;
  body: { transmissionId: string | null; status: number; findings: number };
  sessionUuid: string;
}> {
  const session = await createSession();
  // Always the app's OWN SchemaRegistry.load(). This used to accept a registry
  // override, needed only to fake an outdated cohort into existence; with 0.8.0
  // registered there is a real one, so every full-flow test now runs against the
  // registry the service actually boots with.
  const app = buildApp({ logger: false });
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
      assert.ok(fails.length >= 1, 'one finding per non-container Ajv error');
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
    // A payload declaring the older registered version, against the app's own
    // registry: it grades outdated-but-valid end to end, with no fake current
    // version anywhere in the flow.
    const payload = Buffer.from(JSON.stringify(outdatedPayload()), 'utf8');
    let sessionUuid: string | undefined;
    try {
      const out = await postToSession(payload);
      sessionUuid = out.sessionUuid;

      assert.notEqual(out.statusCode, 422, 'outdated-but-valid payload is still accepted');
      assert.ok(out.statusCode < 300, `reaches success (got ${out.statusCode})`);

      const rows = await rowFor(sessionUuid);
      assert.equal(rows[0]?.schema_ok, true, 'schema_ok persisted true');
      assert.equal(
        rows[0]?.schema_version,
        OUTDATED_VERSION,
        'declared (outdated) version recorded',
      );

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
