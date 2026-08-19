/**
 * `adv.cmpr_minutes` — the advisory for compressor runtimes that never cross 15,
 * the shape a MINUTES-valued feed takes on a SECONDS-valued envelope (agj.7,
 * epic agj).
 *
 * agj.7's acceptance sentence is proved here against the REAL machinery rather
 * than asserted. The load-bearing claim is measured first: a minutes-valued
 * payload validates CLEANLY against the vendored 0.8.1 bytes with the real Ajv
 * build, because the correction WIDENED the range (0–15 sits inside 0–900). If
 * that ever stops being true the schema learned to express the unit change and
 * this advisory needs revisiting rather than patching.
 *
 * The prose assertions at the bottom are ACCEPTANCE, not polish. agj.7 requires
 * the detail to attribute the cause to the pre-0.8.0 minutes-to-seconds
 * correction, to name the remedy, and to do neither in language that implies a
 * careless supplier — a supplier implementing against 0.7.2 or the published
 * DS01.2 Annex 2 was held to minutes BY THEIR OWN VALIDATOR.
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
import { cmprMinutesCheck, MINUTES_CEILING } from './cmpr-minutes.js';
import { compressorSupplyCheck, SUPPLY_KEY } from './compressor-supply.js';
import { MIN_RECORDS } from './null-padding.js';

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
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
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

/** The SOLAR half of `ems-record.allOf[0]`: DCSV + DCCD, and no SVA at all. */
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
      transferId: 'T-cmpr-minutes',
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

/**
 * `count` records whose CMPR walks the minutes-shaped values — every one at or
 * below 15, at least one above 0, and several at exactly 15 against SVA 900.
 */
const MINUTES_WALK: readonly number[] = [15, 12, 15, 9, 15, 0, 14, 15, 11, 15, 7, 15];

function minutesRecords(
  count = MIN_RECORDS,
  key = 'CMPR',
  over: Record<string, unknown> = {},
): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) =>
    mainsRecord(i, { CMPR: 320, [key]: MINUTES_WALK[i % MINUTES_WALK.length], ...over }),
  );
}

/** `count` conformant seconds-shaped records. */
function secondsRecords(count = MIN_RECORDS): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => mainsRecord(i, { CMPR: 200 + i * 10 }));
}

/** A schema-valid RTMD transmission whose records carry minutes-shaped CMPR. */
function rtmdPayload(): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-cmpr-minutes-rtm',
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
        records: Array.from({ length: MIN_RECORDS }, (_, i) => ({
          ABST: `20200115T04${String(i).padStart(2, '0')}54Z`,
          ALRM: 'HEAT',
          BEMD: 14.3,
          EERR: 'none',
          TVC: 3.2,
          CMPR: MINUTES_WALK[i % MINUTES_WALK.length],
          SVA: 900,
        })),
      },
    ],
  };
}

// ── harnesses ───────────────────────────────────────────────────────────────

function makeCtx(payload: unknown, transferType = 'ems'): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'cmpr-minutes-session',
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

/** The §6 body stages in route order (mirrors compressor-supply.test.ts). */
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
  return cmprMinutesCheck(ctx);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.cmpr_minutes');
}

function detailOf(payload: unknown): string {
  return advisories(checkOnly(payload))[0]?.detail ?? '';
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

test('THE GAP: a minutes-valued payload validates CLEANLY on both registered versions', () => {
  // The premise of the whole check, measured rather than assumed: the pre-0.8.0
  // correction WIDENED CMPR's range from 0..15 to 0..900, so every minutes value
  // is a legal seconds value and no schema check on either side can see it.
  for (const version of ['0.8.0', '0.8.1']) {
    const entry = registry.get(version);
    assert.ok(entry, `${version} is registered`);
    const payload = emsPayload(minutesRecords());
    (payload.meta as Record<string, unknown>).schemaVersion = version;
    assert.equal(
      entry.validate(payload),
      true,
      `${version} rejected a minutes-shaped payload: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

test('PIN: the registered versions carry the POST-correction CMPR bounds', () => {
  // The erratum boundary is 0.7.2 -> 0.8.0. Nothing pre-0.8.0 is registered here,
  // which is why the check needs no version gate — if one is ever vendored, this
  // fails and the gate becomes necessary.
  for (const version of ['0.8.0', '0.8.1']) {
    const schema = registry.get(version)?.validate.schema as
      | { $defs?: { 'PQS-DS01-objects'?: Record<string, { maximum?: number }> } }
      | undefined;
    const objects = schema?.$defs?.['PQS-DS01-objects'];
    assert.equal(objects?.CMPR?.maximum, 900, `${version} CMPR is seconds-bounded`);
    assert.equal(objects?.CMPR2?.maximum, 900, `${version} CMPR2 is seconds-bounded`);
    assert.equal(objects?.SVA?.maximum, 900, `${version} SVA never changed`);
  }
});

// ── acceptance: it fires on a fully conformant payload ──────────────────────

test('it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(emsPayload(minutesRecords()));
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
  assert.equal(raised[0]?.code, 'adv.cmpr_minutes', 'the adv.* id rides in code too');
  assert.ok(!raised[0]?.outdated, 'never outdated — that would file it as a defect');
  assert.equal(raised[0]?.pointer, '/data/0/records/0/CMPR', 'the first saturated record');
});

test('a seconds-shaped transmission stays silent', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload(secondsRecords()))), []);
});

// ── signal 1: the ceiling ───────────────────────────────────────────────────

test('the floor is null-padding’s MIN_RECORDS, counted in NUMERIC values', () => {
  assert.equal(MIN_RECORDS, 12, 'the shared floor');
  assert.equal(advisories(checkOnly(emsPayload(minutesRecords(MIN_RECORDS - 1)))).length, 0);
  assert.equal(advisories(checkOnly(emsPayload(minutesRecords(MIN_RECORDS)))).length, 1);

  // Nulls carry no evidence about a ceiling, so they do not count toward it: a
  // payload of 20 records with 11 readings and 9 nulls stays under the floor.
  const mostlyNull = [
    ...minutesRecords(MIN_RECORDS - 1),
    ...Array.from({ length: 9 }, (_, i) => mainsRecord(20 + i, { CMPR: null })),
  ];
  assert.deepEqual(advisories(checkOnly(emsPayload(mostlyNull))), []);
});

test('one value above the ceiling anywhere silences it', () => {
  const records = minutesRecords(MIN_RECORDS + 1);
  records[MIN_RECORDS]!.CMPR = 16;
  assert.deepEqual(advisories(checkOnly(emsPayload(records))), [], '16 is above 15');
});

test('an all-zero series says nothing — at least one value must be above 0', () => {
  const idle = Array.from({ length: MIN_RECORDS }, (_, i) => mainsRecord(i, { CMPR: 0 }));
  assert.deepEqual(advisories(checkOnly(emsPayload(idle))), []);
});

test('values pool across every report in the transmission', () => {
  // agj.7: "every non-null CMPR <= 15 ACROSS the transmission". A migrated
  // appliance alongside an un-migrated one lifts the ceiling and the check goes
  // quiet — under-reporting rather than over-.
  const mixed = emsPayload(minutesRecords()) as { data: Record<string, unknown>[] };
  const migrated = emsPayload(secondsRecords()) as { data: Record<string, unknown>[] };
  mixed.data.push(migrated.data[0]!);
  assert.deepEqual(advisories(checkOnly(mixed)), []);
});

// ── signal 2: saturation ────────────────────────────────────────────────────

test('records at exactly 15 against an SVA above 15 are counted and named', () => {
  // MINUTES_WALK carries six 15s in twelve records, all against SVA 900.
  const detail = detailOf(emsPayload(minutesRecords()));
  assert.match(detail, /6 of those readings sit at exactly 15 in a record whose SVA is above 15/);
  assert.match(detail, /the first at \/data\/0\/records\/0\/CMPR/);
  assert.match(detail, /the saturation signature/);
});

test('saturation does not gate the advisory — the ceiling alone raises it', () => {
  // A series that never reaches 15 exactly still shows the ceiling.
  const under = Array.from({ length: MIN_RECORDS }, (_, i) =>
    mainsRecord(i, { CMPR: 3 + (i % 5) }),
  );
  const [finding] = advisories(checkOnly(emsPayload(under)));
  assert.ok(finding, 'the ceiling alone raises it');
  assert.match(finding.detail ?? '', /the saturation signature is absent/);
  assert.equal(finding.pointer, '/data/0/records/0/CMPR');
});

test('a 15 beside an SVA at or below 15 is not saturation', () => {
  // Under either unit, 15 seconds of compressor against 15 seconds of supply is
  // not a compressor pinned at the top of its range.
  const records = Array.from({ length: MIN_RECORDS }, (_, i) =>
    mainsRecord(i, { CMPR: MINUTES_CEILING, SVA: 15 }),
  );
  const detail = detailOf(emsPayload(records));
  assert.match(detail, /the saturation signature is absent/);
});

test('SOLAR: signal 2 cannot arise, and the detail says so', () => {
  // ems-record.allOf[0] forbids SVA on the solar branch, so a solar appliance
  // falls back to the ceiling alone. DCSV is a VOLTAGE and is no substitute.
  const records = Array.from({ length: MIN_RECORDS }, (_, i) =>
    solarRecord(i, { CMPR: MINUTES_WALK[i % MINUTES_WALK.length] }),
  );
  const entry = registry.get('0.8.1');
  assert.ok(entry?.validate(emsPayload(records)), 'the solar fixture is schema-valid');

  const detail = detailOf(emsPayload(records));
  assert.match(detail, /the saturation signature is absent/);
  assert.match(detail, /the schema keeps it off the solar branch/);
});

// ── CMPR and CMPR2 are graded independently ─────────────────────────────────

test('CMPR2 alone trips it, and the detail names CMPR2 rather than CMPR', () => {
  // CMPR stays a healthy 320 s throughout — a supplier may have migrated one
  // compressor's reading and not the other.
  const records = minutesRecords(MIN_RECORDS, 'CMPR2');
  const detail = detailOf(emsPayload(records));
  assert.match(detail, /CMPR2 arrived as 12 numeric values/);
  assert.doesNotMatch(detail, /CMPR arrived as/, 'CMPR is seconds-shaped and is not named');
  assert.match(detail, /The unit of CMPR2 CHANGED/);
});

test('both objects trip it in ONE finding that names both', () => {
  const records = Array.from({ length: MIN_RECORDS }, (_, i) =>
    mainsRecord(i, {
      CMPR: MINUTES_WALK[i % MINUTES_WALK.length],
      CMPR2: MINUTES_WALK[(i + 1) % MINUTES_WALK.length],
    }),
  );
  const raised = advisories(checkOnly(emsPayload(records)));
  assert.equal(raised.length, 1, 'one finding per transmission, however many objects');
  assert.match(raised[0]?.detail ?? '', /CMPR arrived as/);
  assert.match(raised[0]?.detail ?? '', /CMPR2 arrived as/);
  assert.match(raised[0]?.detail ?? '', /The unit of CMPR and CMPR2 CHANGED/);
});

// ── what it deliberately does not read ──────────────────────────────────────

test('RTMD is out of scope entirely — an rtm payload raises nothing', () => {
  assert.deepEqual(advisories(checkOnly(rtmdPayload(), 'rtm')), []);
  assert.deepEqual(advisories(checkOnly(emsPayload(minutesRecords()), 'rtm')), []);
});

test('SVA, DORV and DORF are OUT OF SCOPE — they were always seconds', () => {
  // agj.7 corrected an earlier over-generalization: a low value on one of those
  // is a quiet period, not a units question, and reading them would raise this
  // advisory on correct payloads.
  const quiet = Array.from({ length: MIN_RECORDS }, (_, i) =>
    mainsRecord(i, { CMPR: 320, SVA: 12, DORV: 5, DORF: 3 }),
  );
  assert.deepEqual(advisories(checkOnly(emsPayload(quiet))), []);
});

test('nulls and non-numbers are skipped rather than read as zero', () => {
  const withNulls = minutesRecords(MIN_RECORDS + 2);
  withNulls[MIN_RECORDS]!.CMPR = null;
  withNulls[MIN_RECORDS + 1]!.CMPR = null;
  const detail = detailOf(emsPayload(withNulls));
  assert.match(detail, /CMPR arrived as 12 numeric values/, 'the two nulls are not counted');
});

test('a malformed body raises nothing at all', () => {
  assert.deepEqual(advisories(checkOnly({})), []);
  assert.deepEqual(advisories(checkOnly({ data: [] })), []);
  assert.deepEqual(advisories(checkOnly({ data: ['not a report'] })), []);
  assert.deepEqual(advisories(checkOnly({ data: [{ records: 'not an array' }] })), []);
  assert.deepEqual(advisories(checkOnly({ data: [{ records: ['not a record'] }] })), []);
});

// ── the two CMPR advisories are complementary, not backstops ───────────────

test('PIN: adv.compressor_exceeds_supply is structurally blind to this payload', () => {
  // agj.3 and agj.7 both say it out loud: minutes-valued CMPR is always <= 15
  // while seconds-valued SVA runs to 900, so CMPR > SVA essentially never fires
  // for this population. Neither check backstops the other.
  const ctx = makeCtx(emsPayload(minutesRecords()));
  ctx.parsedBody = ctx.parsedBody ?? JSON.parse(ctx.rawBody.toString('utf8'));
  ctx.parseOk = true;
  ctx.schemaOk = true;

  assert.equal(cmprMinutesCheck(ctx).length, 1, 'this check sees it');
  assert.deepEqual(compressorSupplyCheck(ctx), [], 'the other one cannot');
});

// ── the governing constraint: it moves no requirement's status ──────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(emsPayload(minutesRecords()));
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

// ── prose is acceptance, not polish ────────────────────────────────────────

test('the detail attributes the cause to the 0.7.2 → 0.8.0 unit correction', () => {
  const detail = detailOf(emsPayload(minutesRecords()));
  assert.match(detail, /between cce-interop 0\.7\.2 and 0\.8\.0/, 'the boundary');
  assert.match(detail, /DS01\.2 Annex 2/, 'the other artifact that carried minutes');
  assert.match(detail, /it was minutes.*capped it at 15.*gave 7 as its example/s, 'the old shape');
  assert.match(detail, /from 0\.8\.0 it is seconds, capped at 900, with 120 as its example/);
});

test('the detail names the remedy, and Annex 1 as authoritative on units', () => {
  const detail = detailOf(emsPayload(minutesRecords()));
  assert.match(detail, /Annex 1 of E006\/DS01 is authoritative on units/);
  assert.match(detail, /re-checking CMPR against it/);
});

test('the detail explains why nothing else sees it', () => {
  const detail = detailOf(emsPayload(minutesRecords()));
  assert.match(detail, /0–15 sits inside 0–900/);
  assert.match(detail, /visible to neither side’s schema validation|neither side's schema/);
});

test('the detail states the downstream consequence CONDITIONALLY', () => {
  // "a sixtieth of the compressor duty" is what happens IF these are minutes. A
  // fridge that genuinely barely runs looks identical from the receiving side,
  // so stating it flatly would be the concluding language this category forbids.
  const detail = detailOf(emsPayload(minutesRecords()));
  assert.match(detail, /If these readings are counts of minutes/);
  assert.match(detail, /a sixtieth of the compressor duty/);
});

test('the detail never implies a careless supplier', () => {
  // agj.7 is explicit: the pre-correction schema ENFORCED maximum 15, so an
  // implementation built against 0.7.2 was held to minutes by its own validator.
  // The prose says that, and carries no word that reads as blame.
  const detail = detailOf(emsPayload(minutesRecords()));
  assert.match(detail, /was held to 15 by its own validator/);
  assert.doesNotMatch(detail, /\b(careless|sloppy|neglect|oversight|should have|forgot)\b/i);
});

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  // Same bar the Advisories copy is held to (src/web/advisories.test.ts): the
  // payload broke no rule — it validates cleanly — so any of these would be a
  // false statement about the supplier rather than a harsh tone.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must)\b/i;
  const detail = detailOf(emsPayload(minutesRecords()));

  assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
  assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
});

test('the detail stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence's detail, so each one has to be readable without its siblings.
  const detail = detailOf(emsPayload(minutesRecords()));
  assert.match(detail, /Across this transmission/);
  assert.doesNotMatch(detail, /this session|every transmission/i);
});
