/**
 * `adv.compressor_exceeds_supply` — the advisory for a mains EMS record whose
 * compressor runtime runs past the AC supply availability in the same record
 * (agj.3, epic agj).
 *
 * agj.3's acceptance sentence is proved here against the REAL machinery rather
 * than asserted: the fixtures are validated by the real `SchemaRegistry` (which
 * is the load-bearing claim — this advisory exists only because the schema
 * bounds each object independently and never relates them), the payload is run
 * through the real §6 body stages for its 200 and its zero fail findings, and
 * the §7 summary is computed with and without the advisory and compared.
 *
 * The mains/solar partition is measured here too, not taken on trust: the
 * discriminator this check selects on is `ems-record.allOf[0]`, and the probes
 * below pin what Ajv actually does with each branch. If a future schema version
 * changes that partition, these fail rather than the check quietly grading the
 * wrong records.
 *
 * The copy assertions at the bottom are NOT polish. The finding prose is
 * user-facing text held to the same bar as `ADVISORY_COPY` (src/web/
 * advisories.test.ts): no defect vocabulary, no synonym for the category, and —
 * specific to this check — no cause named, since from the receiving side a
 * runtime past its supply is equally consistent with several of them.
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
import { compressorSupplyCheck, isMainsRecord, SUPPLY_KEY } from './compressor-supply.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── fixtures ────────────────────────────────────────────────────────────────

/** One conformant MAINS EMS record; `over` mutates it. */
function mainsRecord(index: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const minutes = index * 15;
  const hh = String(3 + Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return {
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
    ...over,
  };
}

/**
 * The SOLAR half of `ems-record.allOf[0]`: DCSV + DCCD and no SVA. Built by
 * dropping SVA rather than by overriding it, because the branch's `not` forbids
 * SVA outright — a record carrying both matches two branches of an exclusive
 * `oneOf` and is INVALID.
 */
function solarRecord(index: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const record = mainsRecord(index);
  delete record[SUPPLY_KEY];
  return { ...record, DCSV: 12.4, DCCD: 3.1, ...over };
}

/** A schema-valid EMS transmission carrying `records`. */
function emsPayload(records: Record<string, unknown>[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-compressor-supply',
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
        EMSV: 'v01.02.123',
        LDOP: '2021-08-15',
        LMFR: 'Logger_Co',
        LMOD: 'Logger_Model',
        LPQS: 'E006/998',
        LSER: 'log4567890asdf',
        LSV: 'v01.02.008',
        records,
      },
    ],
  };
}

/** A schema-valid RTMD transmission whose one record carries CMPR past SVA. */
function rtmdPayload(): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-compressor-supply-rtm',
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
          {
            ABST: '20200115T040554Z',
            ALRM: 'HEAT',
            BEMD: 14.3,
            EERR: 'none',
            TVC: 3.2,
            CMPR: 900,
            SVA: 60,
          },
        ],
      },
    ],
  };
}

// ── harnesses ───────────────────────────────────────────────────────────────

function makeCtx(payload: unknown, transferType = 'ems'): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'compressor-supply-session',
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    registry,
    findings: [],
    parsedBody: null,
    meta: { transferType },
    normalizedSchemaVersion: null,
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: null,
    schemaOk: null,
  };
}

/** The §6 body stages in route order (mirrors date-format.test.ts's harness). */
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
function checkOnly(payload: unknown, transferType = 'ems'): Finding[] {
  const ctx = makeCtx(payload, transferType);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  return compressorSupplyCheck(ctx);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.compressor_exceeds_supply');
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

// ── the gap this advisory exists for ────────────────────────────────────────

test('THE GAP: a compressor running past its supply is schema-valid', () => {
  // The premise of the whole check, measured rather than assumed: CMPR and SVA
  // are each bounded 0..900 independently, and the schema has no vocabulary for
  // one property's relationship to another in the same record.
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  assert.equal(
    entry.validate(emsPayload([mainsRecord(0, { CMPR: 900, SVA: 120 })])),
    true,
    `Ajv has nothing to say about CMPR > SVA: ${JSON.stringify(entry.validate.errors)}`,
  );
});

test('PIN: the mains/solar partition is the schema’s own exclusive oneOf', () => {
  // ems-record.allOf[0]. The discriminator this check selects on is a schema
  // fact, not a heuristic — so it is measured here rather than described.
  const entry = registry.get('0.8.1');
  assert.ok(entry);
  const validate = (records: Record<string, unknown>[]): boolean =>
    entry.validate(emsPayload(records)) === true;

  assert.ok(validate([solarRecord(0)]), 'DCSV + DCCD without SVA is the solar branch');
  assert.ok(!validate([mainsRecord(0, { DCSV: 12.4, DCCD: 3.1 })]), 'SVA with DCSV matches both');
  const neither = mainsRecord(0);
  delete neither[SUPPLY_KEY];
  assert.ok(!validate([neither]), 'neither branch satisfied');

  assert.ok(isMainsRecord(mainsRecord(0)), 'presence of SVA selects mains');
  assert.ok(isMainsRecord(mainsRecord(0, { SVA: null })), 'presence, NOT nullness, is the test');
  assert.ok(!isMainsRecord(solarRecord(0)), 'a solar record carries no SVA to select on');
});

// ── acceptance: it fires on an otherwise conformant payload ─────────────────

test('it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(emsPayload([mainsRecord(0), mainsRecord(1, { CMPR: 420, SVA: 200 })]));
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 200);
  assert.equal(
    result.findings.filter((f) => f.severity === 'fail').length,
    0,
    `expected no fail findings, got ${JSON.stringify(result.findings.filter((f) => f.severity === 'fail'))}`,
  );

  const raised = advisories(result.findings);
  assert.equal(raised.length, 1, 'one finding per transmission');
  assert.equal(raised[0]?.severity, 'info');
  assert.equal(raised[0]?.code, 'adv.compressor_exceeds_supply', 'the adv.* id rides in code too');
  assert.ok(!raised[0]?.outdated, 'never outdated — that would file it as a defect');
  assert.equal(raised[0]?.pointer, '/data/0/records/1/CMPR', 'points at the first one');
});

test('the conformant baseline stays silent', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload([mainsRecord(0), mainsRecord(1)]))), []);
});

test('CMPR equal to SVA is silent — the comparison is STRICTLY greater', () => {
  // A compressor that ran the whole time power was available is a hard-working
  // fridge, not an observation. 900/900 is exactly the conformant baseline.
  assert.deepEqual(
    advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 900, SVA: 900 })]))),
    [],
  );
  assert.deepEqual(advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 0, SVA: 0 })]))), []);
});

test('CMPR2 is read against SVA the same way', () => {
  const [finding] = advisories(
    checkOnly(emsPayload([mainsRecord(0, { CMPR: 100, CMPR2: 640, SVA: 600 })])),
  );
  assert.ok(finding, 'CMPR2 past SVA raised nothing');
  assert.equal(finding.pointer, '/data/0/records/0/CMPR2');
  assert.match(finding.detail ?? '', /CMPR2 is 640 s and SVA is 600 s — 40 s/);
});

test('both compressors in one record are two readings, and both are named', () => {
  const [finding] = advisories(
    checkOnly(emsPayload([mainsRecord(0, { CMPR: 700, CMPR2: 800, SVA: 600 })])),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /carries 2 readings/);
  // Two objects named, so the verbs that follow the list are plural (ezgh).
  assert.match(finding.detail ?? '', /CMPR and CMPR2 are larger than SVA/);
  assert.match(finding.detail ?? '', /CMPR and CMPR2 count the seconds the compressor ran/);
});

test('one object named takes the singular verb, however many readings there are', () => {
  // Two readings, but both are CMPR — the verb agrees with the list, not the
  // count (ezgh).
  const [finding] = advisories(
    checkOnly(
      emsPayload([
        mainsRecord(0, { CMPR: 700, SVA: 600 }),
        mainsRecord(1, { CMPR: 800, SVA: 600 }),
      ]),
    ),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /carries 2 readings/);
  assert.match(finding.detail ?? '', /CMPR is larger than SVA/);
  assert.match(finding.detail ?? '', /CMPR counts the seconds the compressor ran/);
});

test('the count and the worst excess are the transmission’s, over every report', () => {
  const payload = emsPayload([
    mainsRecord(0, { CMPR: 300, SVA: 200 }), // 100 s
    mainsRecord(1), // conformant
    mainsRecord(2, { CMPR: 900, SVA: 450 }), // 450 s — the worst
    mainsRecord(3, { CMPR: 60, SVA: 30 }), // 30 s
  ]);
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding);
  assert.match(finding.detail ?? '', /carries 3 readings/);
  assert.match(finding.detail ?? '', /The largest excess across the transmission is 450 s/);
  assert.equal(finding.pointer, '/data/0/records/0/CMPR', 'the first in document order');
});

// ── what it deliberately does not read ──────────────────────────────────────

test('RTMD is out of scope entirely — an rtm payload raises nothing', () => {
  // RTMDs do not measure compressor runtime (agj.3, Benson 2026-08-18), so the
  // rtm branch is skipped rather than graded. The fixture carries CMPR 900
  // against SVA 60, which WOULD be the sharpest possible observation on EMS.
  assert.deepEqual(advisories(checkOnly(rtmdPayload(), 'rtm')), []);
  assert.deepEqual(
    advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 900, SVA: 60 })]), 'rtm')),
    [],
  );
});

test('solar records are out of scope — there is nothing to read CMPR against', () => {
  // DCSV is a VOLTAGE (0..999.9), not availability in seconds, and no DC
  // availability object exists through 0.8.4. A solar record with CMPR 900 is
  // therefore unreadable here, not silently conformant.
  assert.deepEqual(advisories(checkOnly(emsPayload([solarRecord(0, { CMPR: 900 })]))), []);
  assert.deepEqual(
    advisories(checkOnly(emsPayload([solarRecord(0, { CMPR: 900, DCSV: 0.5 })]))),
    [],
  );
});

test('a null on either side is skipped', () => {
  // Both objects are nullable. A null SVA on a mains record says the supply
  // reading is missing, not that it was zero — reading it as zero would make
  // every running compressor an observation.
  assert.deepEqual(
    advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 900, SVA: null })]))),
    [],
  );
  assert.deepEqual(advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: null, SVA: 0 })]))), []);
});

test('a malformed body raises nothing at all', () => {
  assert.deepEqual(advisories(checkOnly({})), []);
  assert.deepEqual(advisories(checkOnly({ data: [] })), []);
  assert.deepEqual(advisories(checkOnly({ data: ['not a report'] })), []);
  assert.deepEqual(advisories(checkOnly({ data: [{ records: 'not an array' }] })), []);
  assert.deepEqual(advisories(checkOnly({ data: [{ records: ['not a record'] }] })), []);
});

// ── the governing constraint: it moves no requirement's status ──────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(emsPayload([mainsRecord(0), mainsRecord(1, { CMPR: 420, SVA: 200 })]));
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

// ── wording is acceptance, not polish ───────────────────────────────────────

test('it names the count, both values as sent, the excess and the worst', () => {
  const [finding] = advisories(
    checkOnly(
      emsPayload([
        mainsRecord(0, { CMPR: 420, SVA: 200 }),
        mainsRecord(1, { CMPR: 800, SVA: 500 }),
      ]),
    ),
  );
  const detail = finding?.detail ?? '';

  assert.match(detail, /carries 2 readings/, 'the count');
  assert.match(detail, /\/data\/0\/records\/0\/CMPR/, 'a pointer to the first');
  assert.match(detail, /CMPR is 420 s and SVA is 200 s/, 'both values as sent');
  assert.match(detail, /220 s of compressor runtime beyond the supply/, 'the excess');
  assert.match(detail, /largest excess across the transmission is 300 s/, 'the worst');
  assert.match(detail, /15-minute period/, 'what the two objects share');
});

test('a single reading does not report its own excess twice', () => {
  const detail = advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]
    ?.detail;
  assert.match(detail ?? '', /carries 1 reading where/);
  assert.doesNotMatch(detail ?? '', /largest excess/, 'the first one IS the worst');
});

test('the detail says why a solar record is not read here', () => {
  // So nobody later "extends" the check by substituting DCSV — a voltage — for
  // SVA. The reason lives in the module header AND in what the supplier sees.
  const detail = advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]
    ?.detail;
  assert.match(detail ?? '', /DCSV and DCCD/);
  assert.match(detail ?? '', /no DC supply availability in seconds/);
});

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  // Same bar the Advisories copy is held to (src/web/advisories.test.ts): the
  // payload broke no rule — the schema accepts these values — so any of these
  // would be a false statement about the supplier rather than a harsh tone.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must)\b/i;
  const detail =
    advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]?.detail ?? '';

  assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
  assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
});

test('the detail names no cause', () => {
  // From the receiving side a runtime past its supply is equally consistent with
  // a mis-scaled CMPR, a mis-scaled SVA, an accumulator that was not reset and a
  // metering fault. Picking one would be the concluding language this category
  // forbids.
  const detail =
    advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]?.detail ?? '';
  assert.doesNotMatch(detail, /because|caused by|due to|means that|indicates|suggests/i);
});

test('the detail stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence's detail, so each one has to be readable without its siblings.
  const detail =
    advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]?.detail ?? '';
  assert.match(detail, /This transmission/);
  assert.doesNotMatch(detail, /this session|every transmission/i);
});
