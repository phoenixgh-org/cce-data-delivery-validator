/**
 * `adv.time_not_increasing` — the advisory for a record array whose ABST does
 * not step forward from one position to the next (agj.4, epic agj).
 *
 * The acceptance sentence from agj.4 is that consecutive records whose ABST goes
 * backwards or repeats raise ONE finding per transmission carrying a count, the
 * worst backward step and a pointer to the first; and that a forward-ordered
 * payload stays silent. All of that is proved here against the REAL machinery
 * rather than asserted — the fixtures are validated by the real `SchemaRegistry`
 * (the load-bearing claim: the schema constrains each ABST's shape and says
 * nothing about its neighbours), run through the real §6 body stages for their
 * 200 and their zero fail findings, and the §7 summary is computed with and
 * without the advisory findings and compared.
 *
 * The §3.4 pin is the other half of the acceptance criterion and is NOT
 * incidental: agj.4 is explicit that `intervalCheck` owns cadence regularity and
 * its verdict must not move. The out-of-order fixture below is graded by the
 * real interval check and still earns its §3.4 pass, which is simultaneously the
 * proof that the blind spot is real and the proof that this module did not
 * disturb it.
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
import { timeOrderCheck } from './time-order.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── fixtures ────────────────────────────────────────────────────────────────

/** One conformant EMS record stamped at `abst`; `over` mutates it. */
function emsRecord(abst: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...over,
  };
}

/** `20240115T033000Z` for a 15-minute slot offset from 03:30 UTC. */
function abstAt(minutesFrom0330: number): string {
  const total = 3 * 60 + 30 + minutesFrom0330;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `20240115T${hh}${mm}00Z`;
}

/**
 * A schema-valid EMS transmission whose ONE report carries records stamped at
 * the given ABST values, in the given ARRAY ORDER — which is the whole subject.
 */
function emsPayload(absts: readonly unknown[]): Record<string, unknown> {
  return emsPayloadReports([absts]);
}

/** The same, for several reports — each an independent series. */
function emsPayloadReports(reports: readonly (readonly unknown[])[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-time-order-ems',
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

/** A schema-valid RTMD transmission — the other record branch, same ABST rule. */
function rtmdPayload(absts: readonly unknown[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-time-order-rtm',
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

/** The forward-ordered series every "stays silent" case is measured against. */
const FORWARD = [abstAt(0), abstAt(15), abstAt(30), abstAt(45)];
/** The same four readings, with two positions swapped: one step back of 15 min. */
const SWAPPED = [abstAt(15), abstAt(0), abstAt(30), abstAt(45)];

// ── harnesses ───────────────────────────────────────────────────────────────

function makeCtx(payload: unknown, transferType = 'ems'): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'time-order-session',
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
  return timeOrderCheck(ctx);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.time_not_increasing');
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

test('THE GAP: an out-of-order series is schema-valid on both record branches', () => {
  // The premise of the check, measured rather than assumed: ABST carries a
  // `pattern` per value and the schema says nothing about a value's neighbours,
  // so a swapped pair passes Ajv without comment.
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  for (const payload of [emsPayload(SWAPPED), rtmdPayload(SWAPPED)]) {
    assert.equal(
      entry.validate(payload),
      true,
      `Ajv has nothing to say about record order: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

test('THE GAP: §3.4 grades the SORTED series, so this one still reads as regular', async () => {
  // interval.ts's gradeSeries sorts before grading — by design, since it is
  // asking about cadence rather than order. The consequence is the blind spot
  // agj.4 names: a swapped pair scores the same perfectly regular CV as the
  // forward series, so §3.4 alone can never notice this payload.
  const ctx = makeCtx(emsPayload(SWAPPED));
  ctx.parsedBody = emsPayload(SWAPPED);
  const [interval] = await intervalCheck(ctx, deps);
  assert.equal(interval?.requirement, '3.4');
  assert.equal(interval?.severity, 'pass', 'the sorted series is evenly spaced');
});

// ── acceptance: it fires on a fully conformant payload ──────────────────────

test('it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(emsPayload(SWAPPED));
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
  assert.equal(raised[0]?.code, 'adv.time_not_increasing', 'the adv.* id rides in code too');
  assert.ok(!raised[0]?.outdated, 'never outdated — that would file it as a defect');
  assert.equal(raised[0]?.pointer, '/data/0/records/1/ABST', 'points at the first such record');
});

test('a forward-ordered payload stays silent, on both branches', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload(FORWARD))), []);
  assert.deepEqual(advisories(checkOnly(rtmdPayload(FORWARD), 'rtm')), []);
  assert.deepEqual(advisories(checkOnly(emsPayload([abstAt(0)]))), [], 'a single record');
});

test('a repeated timestamp is observed — strictly increasing means no ties', () => {
  const [finding] = advisories(checkOnly(emsPayload([abstAt(0), abstAt(0), abstAt(15)])));
  assert.ok(finding, 'a repeat raised nothing');
  assert.equal(finding.pointer, '/data/0/records/1/ABST');
  assert.match(finding.detail ?? '', /carries the same ABST as the record before it/);
  assert.match(finding.detail ?? '', /No timestamp steps back/, 'nothing reversed, so say so');
});

test('a backward step is observed on the RTMD branch too', () => {
  const [finding] = advisories(checkOnly(rtmdPayload(SWAPPED), 'rtm'));
  assert.ok(finding);
  assert.equal(finding.pointer, '/data/0/records/1/ABST');
});

// ── the three things the finding has to carry ───────────────────────────────

test('it carries the count, the worst backward step in seconds, and the first pointer', () => {
  // Three steps that are not forward: position 1 (15 min back), position 3
  // (45 min back — the worst), and position 5 (a repeat).
  const [finding] = advisories(
    checkOnly(
      emsPayload([
        abstAt(15),
        abstAt(0), // back 15 min
        abstAt(60),
        abstAt(15), // back 45 min — the worst
        abstAt(75),
        abstAt(75), // a repeat
      ]),
    ),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /carries 3 records/, 'the count');
  assert.match(finding.detail ?? '', /2700 s \(45 min\)/, 'the worst backward step, in seconds');
  assert.match(finding.detail ?? '', /first is at \/data\/0\/records\/1\/ABST/, 'the pointer');
  assert.equal(finding.pointer, '/data/0/records/1/ABST', 'and on the finding itself');
});

test('the seconds reading stands alone when the step is not a whole minute', () => {
  const [finding] = advisories(
    checkOnly(emsPayload(['20240115T033030Z', '20240115T033000Z', '20240115T034500Z'])),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /30 s earlier/);
  assert.doesNotMatch(finding.detail ?? '', /min\)/, 'no fractional minutes invented');
});

test('a sub-second reversal is a step BACK, not a repeat (1dda)', () => {
  // ABST's pattern admits a fractional part and parseAbst resolves it to
  // milliseconds, so these are two DIFFERENT timestamps 300 ms apart. Rounding
  // the gap to whole seconds would call them the same ABST — a statement about
  // a payload that was never sent, which is exactly what an advisory may not do.
  const payload = emsPayload(['20240115T033000.500Z', '20240115T033000.200Z']);
  assert.equal(
    registry.get('0.8.1')?.validate(payload),
    true,
    "sub-second ABST is schema-valid — the precision is the supplier's to use",
  );

  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'a reversal under one second still raised nothing');
  assert.equal(finding.pointer, '/data/0/records/1/ABST');
  assert.match(finding.detail ?? '', /300 ms earlier than the record before it/);
  assert.match(finding.detail ?? '', /furthest any of them steps back is 300 ms/);
  assert.doesNotMatch(finding.detail ?? '', /same ABST/, 'the two values differ');
  assert.doesNotMatch(finding.detail ?? '', /No timestamp steps back/, 'one did step back');
});

test('only an exactly equal epoch value reads as a repeat', () => {
  // The same instant written two ways is a tie; anything else is a step.
  const [tie] = advisories(checkOnly(emsPayload(['20240115T033000.000Z', '20240115T033000Z'])));
  assert.ok(tie);
  assert.match(tie.detail ?? '', /carries the same ABST as the record before it/);
  assert.match(tie.detail ?? '', /No timestamp steps back/);

  // And a step of one millisecond is named rather than rounded away.
  const [step] = advisories(checkOnly(emsPayload(['20240115T033000.001Z', '20240115T033000Z'])));
  assert.ok(step);
  assert.match(step.detail ?? '', /1 ms earlier than the record before it/);
});

// ── reports are independent series ──────────────────────────────────────────

test('the walk never crosses a report boundary', () => {
  // Two devices, each forward-ordered, whose series overlap in wall-clock time.
  // Comparing across them would report an ordering relationship that does not
  // exist — the arrays belong to different loggers.
  assert.deepEqual(
    advisories(
      checkOnly(
        emsPayloadReports([
          [abstAt(30), abstAt(45)],
          [abstAt(0), abstAt(15)],
        ]),
      ),
    ),
    [],
  );
});

test('counts are summed across reports and the first pointer is in document order', () => {
  const [finding] = advisories(
    checkOnly(
      emsPayloadReports([
        [abstAt(0), abstAt(15)],
        [abstAt(30), abstAt(15)],
        [abstAt(60), abstAt(60)],
      ]),
    ),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /carries 2 records/);
  assert.equal(finding.pointer, '/data/1/records/1/ABST');
});

// ── what it deliberately does not say ───────────────────────────────────────

test('an unparseable or absent ABST is skipped, and the chain continues', () => {
  // The schema owns ABST's format (it carries a `pattern` and is required on
  // both record branches), so a mis-shaped value is a §3.2 matter Ajv already
  // grades. Skipping it rather than breaking the chain can only under-report.
  assert.deepEqual(
    advisories(checkOnly(emsPayload([abstAt(0), 'not-an-abst', null, undefined, abstAt(15)]))),
    [],
    'the surviving pair is still forward-ordered',
  );
  const [finding] = advisories(
    checkOnly(emsPayload([abstAt(15), 'not-an-abst', abstAt(0), abstAt(30)])),
  );
  assert.ok(finding, 'and the comparison resumes from the last value that parsed');
  assert.equal(finding.pointer, '/data/0/records/2/ABST');
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
  const ctx = makeCtx(emsPayload(SWAPPED));
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

test('PIN: §3.4 grades the swapped payload exactly as it grades the forward one', async () => {
  // agj.4's explicit constraint: §3.4 owns cadence regularity and its verdict
  // must not move. Both payloads carry the same four readings, so the §3.4
  // finding has to be indistinguishable — this module observes ORDER, in its own
  // namespace, and leaves the cadence grade where it was.
  const swapped = await runPipeline(makeCtx(emsPayload(SWAPPED)), bodyStages());
  const forward = await runPipeline(makeCtx(emsPayload(FORWARD)), bodyStages());
  const only34 = (findings: readonly Finding[]) => findings.filter((f) => f.requirement === '3.4');

  assert.deepEqual(only34(swapped.findings), only34(forward.findings));
  assert.equal(only34(swapped.findings)[0]?.severity, 'pass', 'and it is still a pass');
  assert.equal(advisories(forward.findings).length, 0, 'while the forward payload is silent');
});

// ── wording is acceptance, not polish ───────────────────────────────────────

test('it names what arrived and what the order costs the receiving side', () => {
  const detail = advisories(checkOnly(emsPayload(SWAPPED)))[0]?.detail ?? '';

  assert.match(detail, /ABST/, 'the object');
  assert.match(detail, /\/data\/0\/records\/1\/ABST/, 'where');
  assert.match(detail, /900 s \(15 min\)/, 'how far back');
  assert.match(detail, /strictly increasing/, 'the rule being observed against');
  assert.match(
    detail,
    /stores the records in the order they were sent/,
    'and what the receiving side does with the order',
  );
  assert.match(detail, /Sorting the records oldest-first/, 'and the remedy');
});

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  // Same bar the Advisories copy is held to (src/web/advisories.test.ts): the
  // payload broke no rule — the schema accepts this order — so any of these
  // would be a false statement about the supplier rather than a harsh tone.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must)\b/i;
  const detail = advisories(checkOnly(emsPayload(SWAPPED)))[0]?.detail ?? '';

  assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
  assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
});

test('the detail never says which record is the misplaced one', () => {
  // From the receiving side a backward step is equally consistent with a record
  // out of position, a mis-stamped timestamp, and a re-clocked logger. Naming a
  // cause would be concluding, which this category forbids.
  const detail = advisories(checkOnly(emsPayload(SWAPPED)))[0]?.detail ?? '';
  assert.doesNotMatch(detail, /misplaced|out of place|should have been|belongs at|duplicate/i);
});

test('the detail stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence's detail, so each one has to be readable without its siblings.
  const detail = advisories(checkOnly(emsPayload(SWAPPED)))[0]?.detail ?? '';
  assert.match(detail, /This transmission/);
  assert.doesNotMatch(detail, /this session|every transmission/i);
});
