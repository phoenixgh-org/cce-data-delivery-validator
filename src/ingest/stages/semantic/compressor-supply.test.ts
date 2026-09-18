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
import { violatesAdvisoryCopyBar } from './advisory-finding.js';
import { isAdvisoryId } from './advisory.js';
import { compressorSupplyCheck, isMainsRecord, SUPPLY_KEY } from './compressor-supply.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
  findPriorUnitWindows: async () => [],
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
    primaryProfile: null,
    shadowProfile: null,
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
  assert.match(finding.summary ?? '', /^1 record reports CMPR2 larger than SVA/);
});

test('both compressors past one record’s SVA are ONE record, and both are named', () => {
  // The observation counts RECORDS, so two excesses inside a single record stay
  // one record — while the list still names both objects (ezgh).
  const [finding] = advisories(
    checkOnly(emsPayload([mainsRecord(0, { CMPR: 700, CMPR2: 800, SVA: 600 })])),
  );
  assert.ok(finding);
  assert.equal(
    finding.summary,
    '1 record reports CMPR and CMPR2 larger than SVA; the largest excess is 200 s.',
  );
});

test('one object across two records takes the plural record noun', () => {
  const [finding] = advisories(
    checkOnly(
      emsPayload([
        mainsRecord(0, { CMPR: 700, SVA: 600 }),
        mainsRecord(1, { CMPR: 800, SVA: 600 }),
      ]),
    ),
  );
  assert.ok(finding);
  assert.equal(
    finding.summary,
    '2 records report CMPR larger than SVA; the largest excess is 200 s.',
  );
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
  assert.equal(
    finding.summary,
    '3 records report CMPR larger than SVA; the largest excess is 450 s.',
  );
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

test('it names the record count, the objects and the worst excess, then the why', () => {
  const [finding] = advisories(
    checkOnly(
      emsPayload([
        mainsRecord(0, { CMPR: 420, SVA: 200 }),
        mainsRecord(1, { CMPR: 800, SVA: 500 }),
      ]),
    ),
  );

  assert.equal(
    finding?.summary,
    '2 records report CMPR larger than SVA; the largest excess is 300 s.',
  );
  assert.equal(finding?.pointer, '/data/0/records/0/CMPR', 'a pointer to the first');
  assert.equal(
    finding?.detail,
    'On a mains appliance SVA and CMPR are both represented as seconds within the same ' +
      '15-minute period. It is unexpected for the compressor to run for longer than power ' +
      'was available within the period.',
  );
});

test('the excess stays in SECONDS — the unit the two objects are declared in', () => {
  // The duration rule puts elapsed-time phrases in minutes, but this value is
  // the difference between two schema objects whose own unit is seconds.
  const summary = advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]
    ?.summary;
  assert.match(summary ?? '', /the largest excess is 220 s\.$/);
});

test('a single record takes the singular noun and verb', () => {
  const summary = advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]
    ?.summary;
  assert.match(summary ?? '', /^1 record reports CMPR larger than SVA/);
});

test('the rationale carries no solar sentence (decided 2026-09-15)', () => {
  // The check already skips solar records, so the supplier reading this is
  // holding a mains record. The reason nothing on the solar branch substitutes
  // for SVA lives in the module header, where the next contributor needs it.
  const detail = advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]
    ?.detail;
  assert.doesNotMatch(detail ?? '', /DCSV|DCCD|solar/i);
});

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  // Same bar the Advisories copy is held to (src/web/advisories.test.ts): the
  // payload broke no rule — the schema accepts these values — so any of these
  // would be a false statement about the supplier rather than a harsh tone.
  // The bar is imported and applied through its one helper, not re-spelled here
  // (7qjf, agj.25): a second copy would drift the day a word is added to the
  // shared list, and a copy that skipped the exempt phrases would read approved
  // copy as a defect.
  const [finding] = advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])));

  for (const copy of [finding?.summary ?? '', finding?.detail ?? '']) {
    assert.ok(!violatesAdvisoryCopyBar(copy), `copy reads as a defect: ${copy}`);
    assert.doesNotMatch(copy, /data quality|practice note|observation/i, 'no renaming');
  }
});

test('the detail names no cause', () => {
  // From the receiving side a runtime past its supply is equally consistent with
  // a mis-scaled CMPR, a mis-scaled SVA, an accumulator that was not reset and a
  // metering fault. Picking one would be the concluding language this category
  // forbids.
  const [finding] = advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])));
  const copy = `${finding?.summary ?? ''} ${finding?.detail ?? ''}`;
  assert.doesNotMatch(copy, /because|caused by|due to|means that|indicates|suggests/i);
});

test('the observation stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence, so the observation has to be readable without its siblings.
  const summary =
    advisories(checkOnly(emsPayload([mainsRecord(0, { CMPR: 420, SVA: 200 })])))[0]?.summary ?? '';
  assert.match(summary, /^1 record reports CMPR larger than SVA/);
  assert.doesNotMatch(summary, /this session|every transmission/i);
});
