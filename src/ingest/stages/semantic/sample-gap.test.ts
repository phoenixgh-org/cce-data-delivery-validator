/**
 * `adv.sample_gap` — the advisory for consecutive readings taken more than one
 * 15-minute sampling period apart (agj.6, epic agj).
 *
 * The acceptance sentence from agj.6 is that consecutive ABST deltas exceeding
 * 900 s + epsilon raise ONE finding per transmission carrying the count of gaps
 * and the widest one; that epsilon is a named exported constant; and that §3.4's
 * verdict is PROVABLY unchanged. All of that is measured here against the REAL
 * machinery rather than asserted — the fixtures are validated by the real
 * `SchemaRegistry`, run through the real §6 body stages for their 200 and their
 * zero fail findings, and §3.4 is graded by the real `intervalCheck` on the very
 * payload that raises this advisory.
 *
 * The §3.4 pin is the load-bearing half. §3.4 grades the coefficient of
 * variation of the intervals, which is scale-free by design, so a perfectly
 * regular ONE-HOUR series scores CV 0 and earns its §3.4 pass while every period
 * is four times the one DS01 defines. The hourly fixture below is graded by the
 * real interval check and earns a §3.4 finding INDISTINGUISHABLE from the one the
 * quarter-hourly fixture earns — which is simultaneously the proof that the blind
 * spot is real and the proof that this module did not disturb it.
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
import { intervalCheck } from './interval.js';
import { SAMPLE_GAP_EPSILON_MS, SAMPLE_PERIOD_MS, sampleGapCheck } from './sample-gap.js';
import { timeOrderCheck } from './time-order.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── fixtures ────────────────────────────────────────────────────────────────

/** One conformant EMS record stamped at `abst`. */
function emsRecord(abst: unknown): Record<string, unknown> {
  return {
    ABST: abst,
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
}

/** A compact ABST `offsetSeconds` after 2024-01-15T03:30:00Z. */
function abstAt(offsetSeconds: number): string {
  const total = 3 * 3600 + 30 * 60 + offsetSeconds;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `20240115T${pad(Math.floor(total / 3600))}${pad(Math.floor((total % 3600) / 60))}${pad(
    total % 60,
  )}Z`;
}

/** A series of `count` readings spaced `everySeconds` apart. */
function series(count: number, everySeconds: number, fromSeconds = 0): string[] {
  return Array.from({ length: count }, (_, i) => abstAt(fromSeconds + i * everySeconds));
}

/** A schema-valid EMS transmission whose ONE report carries the given ABSTs. */
function emsPayload(absts: readonly unknown[]): Record<string, unknown> {
  return emsPayloadReports([absts]);
}

/** The same, for several reports — each an independent series. */
function emsPayloadReports(reports: readonly (readonly unknown[])[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-sample-gap-ems',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: reports.map((absts) => ({
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
      LSV: 'v01.02.008',
      LDOP: '2021-08-15',
      LMFR: 'Logger_Co',
      LMOD: 'Logger_Model',
      LPQS: 'E006/998',
      LSER: 'log4567890asdf',
      CDAT: '2021-06-01',
      CDAT2: '2021-06-02',
      records: absts.map((abst) => emsRecord(abst)),
    })),
  };
}

/** A schema-valid RTMD transmission — the other record branch, same period. */
function rtmdPayload(absts: readonly unknown[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-sample-gap-rtm',
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
        records: absts.map((abst) => ({
          ABST: abst,
          ALRM: 'HEAT',
          BEMD: 14.3,
          EERR: 'none',
          TVC: 3.2,
        })),
      },
    ],
  };
}

/** Four readings at the period DS01 defines — the "stays silent" reference. */
const QUARTER_HOURLY = series(4, 900);
/** The same four readings' worth of coverage, taken hourly — the subject. */
const HOURLY = series(4, 3600);

// ── harnesses ───────────────────────────────────────────────────────────────

function makeCtx(payload: unknown, transferType = 'ems'): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'sample-gap-session',
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

/** The §6 body stages in route order (mirrors time-order.test.ts's harness). */
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
  return sampleGapCheck(ctx);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.sample_gap');
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

test('THE GAP: an hourly series is schema-valid on both record branches', () => {
  // The premise, measured rather than assumed: ABST carries a `pattern` per
  // value and the schema has no vocabulary for how far apart two values are, so
  // an hourly series validates exactly like a quarter-hourly one.
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  for (const payload of [emsPayload(HOURLY), rtmdPayload(HOURLY)]) {
    assert.equal(
      entry.validate(payload),
      true,
      `Ajv has nothing to say about sampling period: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

test('THE GAP: §3.4 is scale-free, so the hourly series still reads as regular', async () => {
  // interval.ts grades the coefficient of variation, which is unitless BY
  // DESIGN — it has to grade a 15-minute logger and an hourly one alike. So a
  // perfectly regular hourly series scores CV 0 and §3.4 alone can never notice
  // that every one of its periods is four times the one DS01 defines.
  const ctx = makeCtx(emsPayload(HOURLY));
  ctx.parsedBody = emsPayload(HOURLY);
  const [interval] = await intervalCheck(ctx, deps);
  assert.equal(interval?.requirement, '3.4');
  assert.equal(interval?.severity, 'pass', 'the hourly series is perfectly evenly spaced');
});

// ── acceptance: it fires on a fully conformant payload ──────────────────────

test('it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(emsPayload(HOURLY));
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
  assert.equal(raised[0]?.code, 'adv.sample_gap', 'the adv.* id rides in code too');
  assert.ok(!raised[0]?.outdated, 'never outdated — that would file it as a defect');
});

test('a series at the 900 s period stays silent, on both branches', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload(QUARTER_HOURLY))), []);
  assert.deepEqual(advisories(checkOnly(rtmdPayload(QUARTER_HOURLY), 'rtm')), []);
  assert.deepEqual(advisories(checkOnly(emsPayload([abstAt(0)]))), [], 'a single record');
});

test('a gap is observed on the RTMD branch too', () => {
  // rtmd-report carries none of the per-period accumulators, but its readings
  // are stamped against the same 15-minute period and PQS states the rule
  // without qualifying it by device class.
  const [finding] = advisories(checkOnly(rtmdPayload(HOURLY), 'rtm'));
  assert.ok(finding, 'the rtm branch raised nothing');
  assert.equal(finding.pointer, '/data/0/records/1/ABST');
});

// ── the tolerance ───────────────────────────────────────────────────────────

test('epsilon is a named exported constant on top of the 900 s period', () => {
  assert.equal(SAMPLE_PERIOD_MS, 900_000, 'the DS01 period, in ms');
  assert.equal(SAMPLE_GAP_EPSILON_MS, 60_000, 'one minute of leeway — see the module header');
});

test('the bar is exactly period + epsilon, and the constants are what set it', () => {
  // Derived from the exports rather than hard-coded, so a future change to
  // either constant moves this test with it instead of silently past it.
  const barSeconds = (SAMPLE_PERIOD_MS + SAMPLE_GAP_EPSILON_MS) / 1000;

  assert.deepEqual(
    advisories(checkOnly(emsPayload([abstAt(0), abstAt(barSeconds)]))),
    [],
    'a delta exactly at the bar is not yet a gap',
  );
  const [finding] = advisories(checkOnly(emsPayload([abstAt(0), abstAt(barSeconds + 1)])));
  assert.ok(finding, 'one second past the bar is');
  assert.match(finding.detail ?? '', /961 s/, 'and the span is reported as sent');
});

test('whole-minute stamping of a 15-minute cadence stays silent — the reason for 60 s', () => {
  // Quantizing a nominal 900 s cadence to whole minutes makes every delta a
  // multiple of 60, so a well-behaved logger alternates 840 s and 960 s with no
  // reading missed. That artefact, and nothing wider, is what epsilon buys.
  assert.deepEqual(
    advisories(checkOnly(emsPayload([abstAt(0), abstAt(960), abstAt(1800), abstAt(2760)]))),
    [],
  );
  // A missed reading is 1800 s — nearly double the bar, so the tolerance can
  // never mask the thing this check exists to notice.
  const [missed] = advisories(checkOnly(emsPayload([abstAt(0), abstAt(1800), abstAt(2700)])));
  assert.ok(missed, 'a skipped period is still observed');
  assert.match(missed.detail ?? '', /1800 s \(30 min\)/);
});

// ── what the finding has to carry ───────────────────────────────────────────

test('it carries the count of gaps and the widest one, and points at its closing reading', () => {
  // Three gaps: 3600 s, 7200 s (the widest) and 1200 s. The two 900 s steps
  // between them are silent.
  const [finding] = advisories(
    checkOnly(
      emsPayload([
        abstAt(0),
        abstAt(3600), // gap 3600 s
        abstAt(4500),
        abstAt(11_700), // gap 7200 s — the widest, at records/3
        abstAt(12_600),
        abstAt(13_800), // gap 1200 s
      ]),
    ),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /carries 3 stretches/, 'the count');
  assert.match(finding.detail ?? '', /widest runs 7200 s \(120 min\)/, 'the widest span');
  assert.match(finding.detail ?? '', /\/data\/0\/records\/3\/ABST/, 'and where it ends');
  assert.equal(finding.pointer, '/data/0/records/3/ABST', 'and on the finding itself');
});

test('a single gap is named in the singular', () => {
  const [finding] = advisories(checkOnly(emsPayload(HOURLY.slice(0, 2))));
  assert.ok(finding);
  assert.match(finding.detail ?? '', /carries 1 stretch between/);
});

test('a span that is not whole minutes keeps its fraction', () => {
  const [finding] = advisories(checkOnly(emsPayload(['20240115T033000Z', '20240115T034601.500Z'])));
  assert.ok(finding);
  // The minutes reading is dropped rather than turned into a fraction nobody
  // wrote — the only `min` left in the detail is the fixed 900 s (15 min).
  assert.match(finding.detail ?? '', /widest runs 961\.5 s, ending/);
});

// ── order is time-order.ts's business, not this check's ─────────────────────

test('an out-of-order quarter-hourly series raises nothing here', () => {
  // The readings were taken 900 s apart; only the array order is unusual, and
  // ./time-order.ts is what observes that. Measuring gaps off the unsorted array
  // would report ONE defect twice, under two ids, as a gap the readings do not
  // support — so the timestamps are sorted first, exactly as §3.4 sorts them.
  const swapped = emsPayload([QUARTER_HOURLY[1], QUARTER_HOURLY[0], ...QUARTER_HOURLY.slice(2)]);
  assert.deepEqual(advisories(checkOnly(swapped)), [], 'no reading is missing from this series');

  const ctx = makeCtx(swapped);
  ctx.parsedBody = swapped;
  assert.equal(
    timeOrderCheck(ctx).length,
    1,
    'and the observation that IS owed on this payload is made, by the module that owns it',
  );
});

test('a repeated timestamp is not a gap', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload([abstAt(0), abstAt(0), abstAt(900)]))), []);
});

// ── reports are independent series ──────────────────────────────────────────

test('the walk never crosses a report boundary', () => {
  // Two devices sampling correctly, hours apart in wall-clock time. Comparing
  // across them would invent a gap in a series that has none.
  assert.deepEqual(
    advisories(
      checkOnly(
        emsPayloadReports([
          [abstAt(0), abstAt(900)],
          [abstAt(36_000), abstAt(36_900)],
        ]),
      ),
    ),
    [],
  );
});

test('gaps are pooled across reports and the widest wins the pointer', () => {
  const [finding] = advisories(
    checkOnly(
      emsPayloadReports([
        [abstAt(0), abstAt(1800)], // gap 1800 s
        [abstAt(0), abstAt(900), abstAt(5400)], // gap 4500 s — the widest
      ]),
    ),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /carries 2 stretches/);
  assert.match(finding.detail ?? '', /widest runs 4500 s \(75 min\)/);
  assert.equal(finding.pointer, '/data/1/records/2/ABST');
});

// ── what it deliberately does not say ───────────────────────────────────────

test('an unparseable or absent ABST is skipped, and its neighbours become consecutive', () => {
  // The schema owns ABST's format, so a mis-shaped value is a §3.2 matter Ajv
  // already grades. A timestamp we cannot place is also a reading we cannot
  // attribute to a period, so the readings around it are read as consecutive.
  assert.deepEqual(
    advisories(checkOnly(emsPayload([abstAt(0), 'not-an-abst', null, abstAt(900)]))),
    [],
    'the surviving pair is still one period apart',
  );
  const [finding] = advisories(
    checkOnly(emsPayload([abstAt(0), 'not-an-abst', undefined, abstAt(3600)])),
  );
  assert.ok(finding, 'and a pair that is not raises the observation');
  assert.equal(finding.pointer, '/data/0/records/3/ABST');
});

test('a malformed body raises nothing at all', () => {
  assert.deepEqual(advisories(checkOnly({})), []);
  assert.deepEqual(advisories(checkOnly({ data: [] })), []);
  assert.deepEqual(advisories(checkOnly({ data: ['not a report'] })), []);
  assert.deepEqual(advisories(checkOnly({ data: [{ records: 'not an array' }] })), []);
  assert.deepEqual(advisories(checkOnly({ data: [{ records: ['not a record', 7] }] })), []);
});

// ── the governing constraint: it moves no requirement's status ──────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(emsPayload(HOURLY));
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

test('PIN: §3.4 grades the hourly series exactly as it grades the quarter-hourly one', async () => {
  // agj.6's explicit constraint: §3.4 owns cadence regularity and its verdict
  // must not move. Both series are perfectly regular, so their §3.4 findings have
  // to be indistinguishable — this module observes the ABSOLUTE period, in its
  // own namespace, and leaves the cadence grade where it was.
  const hourly = await runPipeline(makeCtx(emsPayload(HOURLY)), bodyStages());
  const quarterly = await runPipeline(makeCtx(emsPayload(QUARTER_HOURLY)), bodyStages());
  const only34 = (findings: readonly Finding[]) => findings.filter((f) => f.requirement === '3.4');

  assert.deepEqual(only34(hourly.findings), only34(quarterly.findings));
  assert.equal(only34(hourly.findings)[0]?.severity, 'pass', 'and it is still a pass');
  assert.equal(advisories(quarterly.findings).length, 0, 'while the 900 s series is silent');
});

// ── wording is acceptance, not polish ───────────────────────────────────────

test('it names what arrived and what the stretch costs the receiving side', () => {
  const detail = advisories(checkOnly(emsPayload(HOURLY)))[0]?.detail ?? '';

  assert.match(detail, /900 s \(15 min\)/, 'the period being observed against');
  assert.match(detail, /60 s of leeway/, 'and the tolerance, so a silence is explainable');
  assert.match(detail, /3600 s \(60 min\)/, 'how wide');
  assert.match(detail, /\/data\/0\/records\/1\/ABST/, 'where');
  assert.match(detail, /CMPR, CMPR2, SVA, DORV, DORF/, 'why 900 is the number');
  assert.match(detail, /at least every 900 s/, 'and the remedy');
});

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  // Same bar the Advisories copy is held to (src/web/advisories.test.ts): the
  // payload broke no rule — a longer sampling period violates nothing the schema
  // or §7 expresses — so any of these would be a false statement about the
  // supplier rather than a harsh tone.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must)\b/i;
  const detail = advisories(checkOnly(emsPayload(HOURLY)))[0]?.detail ?? '';

  assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
  assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
});

test('the detail never concludes why the readings are far apart', () => {
  // A power outage, an appliance switched off and a logger set to a longer
  // period are indistinguishable from the receiving side, so the prose names
  // them as possibilities and never picks one.
  const detail = advisories(checkOnly(emsPayload(HOURLY)))[0]?.detail ?? '';
  assert.doesNotMatch(detail, /misconfigured|because|clearly|evidently|should have been/i);
  assert.match(detail, /rather than why/, 'and says so out loud');
});

test('the detail stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence's detail, so each one has to be readable without its siblings.
  const detail = advisories(checkOnly(emsPayload(HOURLY)))[0]?.detail ?? '';
  assert.match(detail, /This transmission/);
  assert.doesNotMatch(detail, /this session|every transmission/i);
});
