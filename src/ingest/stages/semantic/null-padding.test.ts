/**
 * `adv.null_padding` — the advisory for a property sent as null in every record
 * that carried it (pwd, bite bva slice C).
 *
 * The acceptance sentence from bva is that the check must fire on a payload that
 * is fully schema- AND requirement-conformant, and must move NO requirement's
 * pass/fail status. Both are proved here against the REAL machinery rather than
 * asserted: the fixture is validated by the real `SchemaRegistry`, run through
 * the real §6 body stages (size → content-type → encoding → parse → schema →
 * semantic) for its 200 and its zero fail findings, and the §7 summary is
 * computed with and without the advisory findings and compared.
 *
 * The copy assertions at the bottom are NOT polish. Slice B's tests guard
 * `ADVISORY_COPY` only; the finding prose is user-facing text on the same
 * surface and is held to the same bar here — no defect vocabulary, no synonym
 * for the category, and nothing concluding about the supplier's equipment, since
 * a 100 %-null rate is strong evidence and never proof.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeComplianceSummary } from '../../../api/compliance-matrix.js';
import { SchemaRegistry } from '../../../schema-registry.js';
import { runPipeline, type Finding, type PipelineContext, type Stage } from '../../pipeline.js';
import { contentTypeStage } from '../content-type.js';
import { encodingStage } from '../encoding.js';
import { parseStage } from '../parse.js';
import { schemaStage } from '../schema.js';
import { semanticStage, type SemanticDeps } from '../semantic.js';
import { sizeStage } from '../size.js';
import { isAdvisoryId } from './advisory.js';
import { MIN_RECORDS, nullPaddingCheck } from './null-padding.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── the fixture: a conformant EMS transmission that pads three properties ────

/**
 * One EMS record at 15-minute cadence, with `padded` sent as null.
 *
 * ALRM/EERR/LERR are null in EVERY record on purpose: they are the DS01
 * condition codes where null is the DEFINED value for "nothing to report", so a
 * healthy device legitimately sends them this way and the check has to stay
 * silent about them. Every reading is inside its Annex-1 bounds.
 *
 * SVA (and no DCSV/DCCD) satisfies `ems-record`'s mains-vs-solar `oneOf`, and
 * TVC is a real number because that same allOf lets TVC be null ONLY alongside a
 * non-empty LERR — so on this branch a padded TVC is not schema-legal in the
 * first place, and the check never needs to consider it.
 */
function emsRecord(index: number, padded: readonly string[]): Record<string, unknown> {
  const minutes = index * 15;
  const hh = String(3 + Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  const record: Record<string, unknown> = {
    ABST: `20240115T${hh}${mm}00Z`,
    ALRM: null,
    BEMD: 13.2,
    BLOG: 367,
    CMPR: 320,
    DORV: 0,
    EERR: null,
    LERR: null,
    SVA: 900,
    TAMB: 23.1,
    TVC: 4.7,
  };
  for (const key of padded) record[key] = null;
  return record;
}

/** A schema-valid EMS transmission of `n` records padding `padded`. */
function emsPayload(n: number, padded: readonly string[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: `T-null-padding-${n}`,
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: [
      {
        CID: 'US',
        ADOP: '2020-12-01',
        AMFR: 'Alpha Fridge, Inc',
        AMOD: 'FRIDGE-100',
        APQS: 'E003/998',
        ASER: 'A-SerialNum',
        EDOP: '2021-06-01',
        EMFR: 'EMD_Name',
        EMOD: 'EMD-ModelNo',
        EPQS: 'E006/999',
        ESER: 'EMD-SerialNum',
        // ems-report's allOf wants LSV and EMSV at report OR record level.
        EMSV: 'v01.02.123',
        LSV: 'v01.02.008',
        LDOP: '2021-08-15',
        LMFR: 'Logger_Co',
        LMOD: 'Logger_Model',
        LPQS: 'E006/998',
        LSER: 'log4567890asdf',
        records: Array.from({ length: n }, (_, i) => emsRecord(i, padded)),
      },
    ],
  };
}

/** The properties the fixture pads. */
const PADDED = ['HAMB', 'TCON', 'TFRZ'] as const;

// ── harnesses ────────────────────────────────────────────────────────────────

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'null-padding-session',
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    registry,
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: null,
    schemaOk: null,
  };
}

/** The §6 body stages in route order (mirrors fixtures.test.ts's harness). */
function bodyStages(): Stage[] {
  return [
    sizeStage(),
    contentTypeStage(),
    encodingStage(),
    parseStage(),
    schemaStage(),
    semanticStage(deps),
  ];
}

/** Drive the check alone against an already-parsed body (unit cases). */
function checkOnly(payload: unknown): Finding[] {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  ctx.meta = { transferType: 'ems' };
  return nullPaddingCheck(ctx);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.null_padding');
}

/** Tally findings into the `countsByRequirement` shape the §7 join consumes. */
function countsOf(
  findings: readonly Finding[],
): Record<string, { pass: number; fail: number; info: number }> {
  const counts: Record<string, { pass: number; fail: number; info: number }> = {};
  for (const f of findings) {
    counts[f.requirement] ??= { pass: 0, fail: 0, info: 0 };
    counts[f.requirement]![f.severity] += 1;
  }
  return counts;
}

// ── acceptance: it fires on a fully conformant payload ───────────────────────

test('the fixture really is schema-conformant on the current registered schema', () => {
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  assert.equal(
    entry.validate(emsPayload(MIN_RECORDS, PADDED)),
    true,
    `padding three nullable properties is legal: ${JSON.stringify(entry.validate.errors)}`,
  );
});

test('it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(emsPayload(16, PADDED));
  const result = await runPipeline(ctx, bodyStages());

  // Fully requirement-conformant as far as the pipeline can grade: the run
  // succeeds and not one stage recorded a fail.
  assert.equal(result.status, 200);
  assert.equal(
    result.findings.filter((f) => f.severity === 'fail').length,
    0,
    `expected no fail findings, got ${JSON.stringify(result.findings.filter((f) => f.severity === 'fail'))}`,
  );

  // And the advisory still speaks — exactly once, as an observation.
  const raised = advisories(result.findings);
  assert.equal(raised.length, 1, 'one finding per transmission, not one per property');
  assert.equal(raised[0]?.severity, 'info');
  assert.equal(raised[0]?.code, 'adv.null_padding', 'the adv.* id rides in code too');
  assert.ok(!raised[0]?.outdated, 'never outdated — that would file it as a defect');
  assert.equal(raised[0]?.pointer, '/data/0/records/0/HAMB', 'points at the first padded value');
});

test('it names every padded property, its nulls, and the bytes they cost', () => {
  const [finding] = advisories(checkOnly(emsPayload(16, PADDED)));
  assert.ok(finding);

  // 3 properties × 16 records = 48 nulls; `"KEY":null,` is key length + 8, so
  // 16 × 3 × 12 = 576 bytes.
  assert.equal(
    finding.detail,
    'HAMB, TCON and TFRZ arrived as null in every record that carried them — 48 nulls ' +
      'across the 16 records in this transmission, about 576 bytes of the 1 MB limit in §1.4 ' +
      'carrying no reading. A null cannot tell the country receiving it whether a reading was ' +
      'unavailable at that moment or is never produced at all; leaving the property out says ' +
      'the second one plainly, and gives those bytes back.',
  );
});

// ── the floor on N ───────────────────────────────────────────────────────────

test(`the floor: ${MIN_RECORDS - 1} records say nothing, ${MIN_RECORDS} speak`, () => {
  assert.equal(MIN_RECORDS, 12, 'the floor is 12 records — see the module header for why');
  assert.deepEqual(advisories(checkOnly(emsPayload(MIN_RECORDS - 1, PADDED))), []);
  assert.equal(advisories(checkOnly(emsPayload(MIN_RECORDS, PADDED))).length, 1);
});

test('a 2-record transmission proves nothing and is left alone', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload(2, PADDED))), []);
});

// ── what it deliberately does not say ────────────────────────────────────────

test('ALRM, EERR and LERR are never named, however constant they are', () => {
  // They are null in all 16 records of the fixture. For those three the schema
  // defines null as "no condition present", so a device that raised no alarm and
  // logged no error is CORRECTLY shaped this way; naming them would report a
  // healthy device as a padded one.
  const [finding] = advisories(checkOnly(emsPayload(16, PADDED)));
  assert.ok(finding);
  for (const code of ['ALRM', 'EERR', 'LERR']) {
    assert.ok(!finding.detail?.includes(code), `${code} must not be named`);
  }
});

test('a property that is null in only some records is not padding', () => {
  const payload = emsPayload(16, PADDED) as {
    data: { records: Record<string, unknown>[] }[];
  };
  // One real reading anywhere in the run is enough to disqualify HAMB.
  payload.data[0]!.records[7]!.HAMB = 58.1;
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding);
  assert.ok(!finding.detail?.includes('HAMB'), 'HAMB carried a reading, so it is not padded');
  assert.ok(finding.detail?.includes('TCON'), 'the genuinely padded ones still speak');
});

test('a payload with nothing padded raises nothing at all', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload(16, []))), []);
});

// ── the governing constraint: it moves no requirement's status ───────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(emsPayload(16, PADDED));
  const result = await runPipeline(ctx, bodyStages());
  assert.equal(advisories(result.findings).length, 1, 'the advisory really is present');

  const withAdvisory = computeComplianceSummary(countsOf(result.findings));
  const without = computeComplianceSummary(
    countsOf(result.findings.filter((f) => !isAdvisoryId(f.requirement))),
  );

  assert.deepEqual(withAdvisory, without, 'the advisory moved a §7 row');
  assert.equal(
    withAdvisory.filter((r) => r.status === 'fail' || r.status === 'mixed').length,
    0,
    'and the supplier is still carrying no failed requirement',
  );
});

// ── wording is acceptance, not polish ────────────────────────────────────────

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  // Same bar slice B holds ADVISORY_COPY to (src/web/advisories.test.ts): the
  // payload broke no rule, so any of these would be a false statement about the
  // supplier rather than merely a harsh tone.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must|should)\b/i;
  const [finding] = advisories(checkOnly(emsPayload(16, PADDED)));
  const detail = finding?.detail ?? '';

  assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
  assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
});

test('the detail concludes nothing about the supplier’s equipment', () => {
  // A 100 %-null rate is strong evidence, never proof — a genuinely broken
  // sensor looks identical from the receiving side, so the prose states the
  // count and the bytes and leaves the meaning to the party that knows.
  const [finding] = advisories(checkOnly(emsPayload(16, PADDED)));
  const detail = finding?.detail ?? '';

  assert.doesNotMatch(
    detail,
    /sensor|fitted|hardware|equipment is/i,
    `detail concludes: ${detail}`,
  );
  // The claim it DOES make is symmetric and hedged: it names both readings a
  // null could stand for rather than picking one.
  assert.match(detail, /cannot tell/i);
  assert.match(detail, /unavailable at that moment or is never produced/i);
});

test('the detail states the observation and frames it as payload size', () => {
  const [finding] = advisories(checkOnly(emsPayload(16, PADDED)));
  const detail = finding?.detail ?? '';

  assert.match(detail, /arrived as null in every record that carried them/, 'states what arrived');
  assert.match(detail, /48 nulls across the 16 records in this transmission/, 'and how much');
  assert.match(detail, /1 MB limit in §1\.4/, 'the actionable framing is the supplier’s bytes');
});

test('the detail stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence's detail, so each one has to be readable without its siblings:
  // it names this transmission's own numbers and never says "and every other".
  const detail = advisories(checkOnly(emsPayload(16, PADDED)))[0]?.detail ?? '';
  assert.match(detail, /this transmission/);
  assert.doesNotMatch(detail, /this session|every transmission/i);
});
