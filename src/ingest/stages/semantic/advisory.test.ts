/**
 * Advisories plumbing (pwd / bva slice A).
 *
 * Two things under test, neither of which needs a real advisory check to exist:
 *   - the emission helper produces the exact finding shape the category depends
 *     on (severity `info`, the `adv.*` id in BOTH `requirement` and `code`,
 *     `outdated` never set);
 *   - the category composes into stage 8 — a registered advisory check's
 *     findings land on `ctx.findings` and the stage still never halts.
 *
 * The first real checks (`adv.null_identity`, `adv.null_padding`) arrive in
 * slice C; a TEST-ONLY advisory stands in for them here so the path is
 * demonstrated rather than assumed. Persistence and the API read path are
 * covered end to end in src/api/sessions.test.ts (DB-gated).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PriorTransmission } from '../../../db/repository.js';
import type { Finding, PipelineContext } from '../../pipeline.js';
import { semanticStage, type SemanticCheck, type SemanticDeps } from '../semantic.js';
import {
  ADVISORY_CHECKS,
  ADVISORY_IDS,
  ADVISORY_PREFIX,
  ADVISORY_RATIONALES,
  advisoriesCheck,
  advisory,
  advisoryRationale,
  isAdvisoryId,
  runAdvisories,
} from './advisory.js';

// ── harness (mirrors semantic-stage.test.ts) ─────────────────────────────────

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'test-session',
    rawBody: Buffer.from('{}'),
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody: { meta: {}, data: [] },
    meta: {},
    normalizedSchemaVersion: '0.8.1',
    primaryProfile: null,
    shadowProfile: null,
    contentType: 'application/json; charset=utf-8',
    contentEncoding: null,
    parseOk: true,
    schemaOk: true,
    ...overrides,
  };
}

function makeDeps(concurrentAtEntry = 1): SemanticDeps {
  return {
    concurrentAtEntry,
    findPriorTransmissions: async (): Promise<PriorTransmission[]> => [],
    findPriorUnitWindows: async () => [],
  };
}

/** A stand-in advisory check, standing where slice C's checks will stand. */
const testAdvisoryCheck: SemanticCheck = (): Finding[] => [
  advisory({
    id: 'adv.test_only',
    summary: 'a test-only observation',
    detail: 'a test-only advisory proving the emission path',
    pointer: '/data/0/records/0/TCON',
  }),
];

// ── the emission helper ──────────────────────────────────────────────────────

test('advisory() emits severity info under the adv.* id in requirement AND code', () => {
  const f = advisory({
    id: 'adv.null_padding',
    summary: 'observed',
    detail: 'why it matters',
    pointer: '/data/0',
  });

  assert.equal(f.severity, 'info', 'always info — 2kx locked no fourth severity');
  assert.equal(f.requirement, 'adv.null_padding', 'requirement carries the adv.* id');
  assert.equal(f.code, 'adv.null_padding', 'code carries the same id, so it de-duplicates');
  assert.equal(f.pointer, '/data/0', 'pointer drives the raw-payload drill-down');
  assert.equal(f.summary, 'observed', 'the observation, shown in the transmission detail');
  assert.equal(f.detail, 'why it matters', 'the rationale, shown on the compliance row');
});

test('advisory() never sets `outdated` — an advisory is not a defect', () => {
  // `isIssue` (src/api/signatures.ts) folds a finding into the "distinct issues
  // to fix" list when it is a fail OR an info carrying `outdated`. Leaving the
  // flag alone is what keeps advisories out of that defect count.
  const f = advisory({ id: 'adv.null_identity', summary: 'observed', detail: 'why' });
  assert.ok(!f.outdated, 'outdated must stay falsy');
  assert.equal(f.pointer, null, 'pointer defaults to null, not undefined');
});

test('advisory() carries no schema-signature fields', () => {
  // keyword/instancePath/param belong to Ajv errors; a set `keyword` would make
  // sigKey treat the advisory as a schema defect.
  const f = advisory({ id: 'adv.null_padding', summary: 'observed', detail: 'why' });
  assert.equal(f.keyword, undefined);
  assert.equal(f.instancePath, undefined);
  assert.equal(f.param, undefined);
});

test('isAdvisoryId separates the adv.* namespace from §7 requirement ids', () => {
  assert.equal(ADVISORY_PREFIX, 'adv.');
  assert.ok(isAdvisoryId('adv.null_padding'));
  assert.ok(isAdvisoryId('adv.anything_at_all'));
  for (const req of ['1.2', '3.2', '1.10', '5.3']) {
    assert.ok(!isAdvisoryId(req), `${req} is a §7 requirement, not an advisory`);
  }
  assert.ok(!isAdvisoryId(null), 'null/undefined are not advisory ids');
  assert.ok(!isAdvisoryId('tx.missing_charset'), 'transport codes are not advisories');
});

// ── composition into stage 8 ─────────────────────────────────────────────────

test('runAdvisories collects every registered check, in order', async () => {
  const second: SemanticCheck = (): Finding[] => [
    advisory({ id: 'adv.second', summary: 'second', detail: 'second why' }),
  ];
  const findings = await runAdvisories(makeCtx(), makeDeps(), [testAdvisoryCheck, second]);

  assert.deepEqual(
    findings.map((f) => f.requirement),
    ['adv.test_only', 'adv.second'],
  );
});

test('the registry holds the catalogue, and says nothing about an empty payload', async () => {
  // The catalogue as of agj.24. Registration is the ONLY wiring a new advisory
  // needs — semantic.ts fans out through advisoriesCheck — so this list is the
  // one place that says out loud which checks the category is running.
  assert.deepEqual(
    ADVISORY_CHECKS.map((c) => c.name),
    [
      'nullIdentityCheck',
      'nullPaddingCheck',
      'dateFormatCheck',
      'timeOrderCheck',
      'compressorSupplyCheck',
      'cmprMinutesCheck',
      'sampleGapCheck',
      'duplicateRecordsCheck',
      'blankAdminCheck',
      'unexplainedNullTempCheck',
      'shortIdentifierCheck',
      'nullAccumulatorCheck',
      'abstWindowOverlapCheck',
    ],
  );
  // A payload with no reports gives every check nothing to observe, so the
  // category stays silent rather than inventing a finding.
  assert.deepEqual(await advisoriesCheck(makeCtx(), makeDeps()), []);
});

test('ADVISORY_IDS names the catalogue, one id per registered check (axdd)', () => {
  // The id list is what a reader OUTSIDE this module joins against — the exercise
  // suite's coverage report asks it which advisories exist, so an id missing from
  // it is an advisory nothing can notice is unexercised. The list is built from
  // the checks' own exported constants, so it cannot disagree with what a check
  // EMITS; what it can still miss is a newly registered check whose constant was
  // never added here, and the length pin is what says so.
  assert.equal(
    ADVISORY_IDS.length,
    ADVISORY_CHECKS.length,
    'every registered check contributes exactly one id',
  );
  assert.equal(new Set(ADVISORY_IDS).size, ADVISORY_IDS.length, 'ids are distinct');
  for (const id of ADVISORY_IDS) {
    assert.ok(isAdvisoryId(id), `${id} lives in the adv.* namespace`);
  }
  // Pinned in ADVISORY_CHECKS order, so a reordering or a swapped constant is a
  // visible change rather than a silent one.
  assert.deepEqual(ADVISORY_IDS, [
    'adv.null_identity',
    'adv.null_padding',
    'adv.date_format',
    'adv.time_not_increasing',
    'adv.compressor_exceeds_supply',
    'adv.cmpr_minutes',
    'adv.sample_gap',
    'adv.duplicate_records',
    'adv.blank_admin',
    'adv.unexplained_null_temp',
    'adv.short_identifier',
    'adv.null_accumulator',
    'adv.abst_window_overlap',
  ]);
});

test('ADVISORY_RATIONALES covers exactly ADVISORY_IDS, and nothing else (synm)', () => {
  // The catalogue is what a reader holding an ID and no finding looks the
  // rationale up in — the API serves it on the advisory signature, so a missing
  // entry is an advisory whose row in the compliance column would explain
  // nothing, and a stray entry is copy no check owns. Pinned in both directions,
  // and in ADVISORY_IDS order so a reordering is a visible change.
  assert.deepEqual([...ADVISORY_RATIONALES.keys()], [...ADVISORY_IDS]);
  for (const id of ADVISORY_IDS) {
    const text = advisoryRationale(id);
    assert.ok(text, `${id} has no rationale`);
    assert.ok(text.trim().length > 0, `${id}'s rationale is blank`);
  }
  assert.equal(advisoryRationale('adv.never_registered'), null, 'an unknown id resolves to null');
  assert.equal(advisoryRationale('3.2'), null, 'a §7 requirement is not in the catalogue');
  assert.equal(advisoryRationale(null), null);
});

test('every rationale is STATIC — no payload number survives into one (synm)', () => {
  // The rationale is shown once per advisory id, on a row that has no payload in
  // front of it. A count, a timestamp or a serial interpolated into one would be
  // a claim about whichever transmission happened to arrive last. Numbers that
  // describe one delivery belong in that finding's `summary`.
  for (const [id, text] of ADVISORY_RATIONALES) {
    assert.doesNotMatch(text, /\b\d+ of \d+\b/, `${id}: carries an "N of M" count`);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, `${id}: carries a timestamp`);
    assert.doesNotMatch(text, /\$\{/, `${id}: carries an unresolved template`);
  }
});

test('stage 8 records advisories alongside conformance findings and still continues', async () => {
  const ctx = makeCtx();
  const outcome = await semanticStage(makeDeps()).run(ctx);
  assert.equal(outcome.kind, 'continue', 'the semantic stage never halts');

  // With no advisory registered, only the §7 checks speak — the category adds
  // nothing to a payload it has nothing to say about.
  assert.equal(ctx.findings.filter((f) => isAdvisoryId(f.requirement)).length, 0);
  assert.ok(ctx.findings.length > 0, 'the §7 semantic checks still ran');

  // With one registered, its finding rides the same accumulator, and every
  // §7 finding is untouched.
  const conformance = ctx.findings.map((f) => `${f.requirement}|${f.severity}`);
  const withAdvisory = makeCtx();
  const advisories = await runAdvisories(withAdvisory, makeDeps(), [testAdvisoryCheck]);
  for (const f of advisories) withAdvisory.findings.push(f);
  await semanticStage(makeDeps()).run(withAdvisory);

  assert.deepEqual(
    withAdvisory.findings
      .filter((f) => !isAdvisoryId(f.requirement))
      .map((f) => `${f.requirement}|${f.severity}`),
    conformance,
    'the §7 findings are identical whether or not an advisory was raised',
  );
  assert.equal(
    withAdvisory.findings.filter((f) => isAdvisoryId(f.requirement)).length,
    1,
    'the advisory landed on ctx.findings',
  );
});
