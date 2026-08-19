/**
 * `adv.date_format` — the advisory for a production date sent in a form other
 * than ISO-8601's YYYY-MM-DD (agj.1, epic agj).
 *
 * The acceptance sentence from agj.1 is that the five report-level date objects
 * AND record-level EDOP raise ONE finding per transmission naming every
 * offending field with a pointer; that nulls are skipped; and that the
 * conformant baseline stays silent. All of that is proved here against the REAL
 * machinery rather than asserted — the fixtures are validated by the real
 * `SchemaRegistry` (which is the load-bearing claim: this advisory only exists
 * because the schema has nothing to say about these values), run through the
 * real §6 body stages for their 200 and their zero fail findings, and the §7
 * summary is computed with and without the advisory findings and compared.
 *
 * The copy assertions at the bottom are NOT polish. The finding prose is
 * user-facing text held to the same bar as `ADVISORY_COPY` (src/web/
 * advisories.test.ts): no defect vocabulary, no synonym for the category, and —
 * specific to this check — no re-writing of a supplier's value into what we
 * think it meant, since `07/04/2026` is genuinely ambiguous and guessing would
 * be the concluding language advisories are forbidden.
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
import { dateFormatCheck, ISO_DATE, REPORT_DATE_FIELDS } from './date-format.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── fixtures ────────────────────────────────────────────────────────────────

/** One conformant EMS record; `over` mutates it (e.g. to plant a record EDOP). */
function emsRecord(index: number, over: Record<string, unknown> = {}): Record<string, unknown> {
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
 * A schema-valid EMS transmission whose report-level dates are `dates` and whose
 * records carry `recordOver`. Every date object DS01 defines is present, so a
 * fixture can mangle any of the five without changing anything else.
 */
function emsPayload(
  dates: Record<string, unknown> = {},
  recordOver: Record<string, unknown>[] = [{}, {}],
): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-date-format-ems',
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
        LSV: 'v01.02.008',
        LDOP: '2021-08-15',
        LMFR: 'Logger_Co',
        LMOD: 'Logger_Model',
        LPQS: 'E006/998',
        LSER: 'log4567890asdf',
        CDAT: '2021-06-01',
        CDAT2: '2021-06-02',
        ...dates,
        records: recordOver.map((over, i) => emsRecord(i, over)),
      },
    ],
  };
}

/** A schema-valid RTMD transmission — the other branch, same date objects. */
function rtmdPayload(
  dates: Record<string, unknown> = {},
  recordOver: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-date-format-rtm',
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
        ...dates,
        records: [
          {
            ABST: '20200115T040554Z',
            ALRM: 'HEAT',
            BEMD: 14.3,
            EERR: 'none',
            TVC: 3.2,
            ...recordOver,
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
    sessionUuid: 'date-format-session',
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

/** The §6 body stages in route order (mirrors null-padding.test.ts's harness). */
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
  return dateFormatCheck(ctx);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.date_format');
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

test('THE GAP: an unpadded production date is schema-valid on both branches', () => {
  // The premise of the whole check, measured rather than assumed: the date
  // objects are bare strings with no `format` and no `pattern`, so Ajv accepts
  // 2026-7-4 — and 'next Tuesday' — without comment. If this ever fails, the
  // schema learned to express dates and this advisory needs revisiting rather
  // than patching.
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  for (const payload of [
    emsPayload({ ADOP: '2026-7-4' }),
    emsPayload({ LDOP: 'next Tuesday' }),
    rtmdPayload({ EDOP: '07/04/2026' }),
    emsPayload({}, [{ EDOP: '2026-7-4' }, {}]),
  ]) {
    assert.equal(
      entry.validate(payload),
      true,
      `Ajv has nothing to say about these dates: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

// ── acceptance: it fires on a fully conformant payload ──────────────────────

test('it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(emsPayload({ ADOP: '2026-7-4' }));
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
  assert.equal(raised[0]?.code, 'adv.date_format', 'the adv.* id rides in code too');
  assert.ok(!raised[0]?.outdated, 'never outdated — that would file it as a defect');
  assert.equal(raised[0]?.pointer, '/data/0/ADOP', 'points at the first offending value');
});

test('the conformant baseline stays silent, on both branches', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload())), []);
  assert.deepEqual(advisories(checkOnly(rtmdPayload(), 'rtm')), []);
});

// ── every date object, at both levels ───────────────────────────────────────

for (const field of REPORT_DATE_FIELDS) {
  test(`report-level ${field} in another form is observed`, () => {
    const [finding] = advisories(checkOnly(emsPayload({ [field]: '2026-7-4' })));
    assert.ok(finding, `${field} raised nothing`);
    assert.equal(finding.pointer, `/data/0/${field}`);
    assert.match(finding.detail ?? '', new RegExp(`${field} at /data/0/${field} arrived as`));
  });
}

test('record-level EDOP is observed on the EMS branch', () => {
  const [finding] = advisories(checkOnly(emsPayload({}, [{}, { EDOP: '2026-7-4' }])));
  assert.ok(finding);
  assert.equal(finding.pointer, '/data/0/records/1/EDOP');
  assert.match(finding.detail ?? '', /EDOP at \/data\/0\/records\/1\/EDOP arrived as "2026-7-4"/);
});

test('record-level EDOP is observed on the RTMD branch', () => {
  const [finding] = advisories(checkOnly(rtmdPayload({}, { EDOP: '1/6/21' }), 'rtm'));
  assert.ok(finding);
  assert.equal(finding.pointer, '/data/0/records/0/EDOP');
  assert.match(finding.detail ?? '', /EDOP at \/data\/0\/records\/0\/EDOP arrived as "1\/6\/21"/);
});

test('one finding names every offending field, each with a pointer', () => {
  const [finding] = advisories(
    checkOnly(emsPayload({ ADOP: '2026-7-4', CDAT2: '07/04/2026' }, [{ EDOP: '1/6/21' }, {}])),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /3 date fields/);
  assert.match(finding.detail ?? '', /ADOP at \/data\/0\/ADOP arrived as "2026-7-4"/);
  assert.match(finding.detail ?? '', /CDAT2 at \/data\/0\/CDAT2 arrived as "07\/04\/2026"/);
  assert.match(finding.detail ?? '', /EDOP at \/data\/0\/records\/0\/EDOP arrived as "1\/6\/21"/);
});

test('repeats of the same field fold into one entry with a count', () => {
  // A transmission can carry hundreds of records; listing every occurrence would
  // be an unreadable finding, so the prose groups by field and counts the rest.
  const [finding] = advisories(
    checkOnly(emsPayload({}, [{ EDOP: '2026-7-4' }, { EDOP: '2026-7-5' }, { EDOP: '2026-7-6' }])),
  );
  assert.ok(finding);
  assert.match(finding.detail ?? '', /1 date field/, 'one FIELD, however many values');
  assert.match(finding.detail ?? '', /\/data\/0\/records\/0\/EDOP arrived as "2026-7-4"/);
  assert.match(finding.detail ?? '', /and in 2 other places/);
  assert.doesNotMatch(finding.detail ?? '', /2026-7-6/, 'later values are counted, not listed');
});

// ── what it deliberately does not say ───────────────────────────────────────

test('a null date is skipped — that is null-padding’s business, not this one', () => {
  assert.deepEqual(
    advisories(
      checkOnly(emsPayload({ ADOP: null, CDAT: null, CDAT2: null }, [{ EDOP: null }, {}])),
    ),
    [],
  );
});

test('a non-string value is left to the schema stage', () => {
  // A number where a date belongs is a §3.2 matter Ajv already grades; this
  // check only speaks about text it can compare against the ISO form.
  assert.deepEqual(advisories(checkOnly(emsPayload({ ADOP: 20260704 }))), []);
});

test('an ISO date is accepted however unusual the calendar value', () => {
  // The check grades SHAPE, not calendar validity: 2026-02-31 has the ISO field
  // widths, and deciding whether a date exists is not what this observes.
  assert.deepEqual(advisories(checkOnly(emsPayload({ ADOP: '2026-02-31' }))), []);
  assert.equal(ISO_DATE.test('2026-07-04'), true);
  assert.equal(ISO_DATE.test('2026-7-4'), false);
  assert.equal(ISO_DATE.test('2026-07-04T00:00:00Z'), false, 'anchored at both ends');
});

test('a malformed body raises nothing at all', () => {
  assert.deepEqual(advisories(checkOnly({})), []);
  assert.deepEqual(advisories(checkOnly({ data: [] })), []);
  assert.deepEqual(advisories(checkOnly({ data: ['not a report'] })), []);
  assert.deepEqual(advisories(checkOnly({ data: [{ records: 'not an array' }] })), []);
});

// ── the governing constraint: it moves no requirement's status ──────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(emsPayload({ ADOP: '2026-7-4' }));
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

test('it names the field, the value as sent, and the ISO-8601 form expected', () => {
  const [finding] = advisories(checkOnly(emsPayload({ ADOP: '2026-7-4' })));
  const detail = finding?.detail ?? '';

  assert.match(detail, /ADOP/, 'the field');
  assert.match(detail, /"2026-7-4"/, 'the value received, verbatim');
  assert.match(detail, /YYYY-MM-DD/, 'the form expected');
  assert.match(detail, /ISO-8601 calendar date, as in 2026-07-04/, 'and an example of it');
  assert.match(
    detail,
    /cannot order or compare dates whose field widths vary/,
    'and what the receiving side cannot do',
  );
});

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  // Same bar the Advisories copy is held to (src/web/advisories.test.ts): the
  // payload broke no rule — the schema accepts these values — so any of these
  // would be a false statement about the supplier rather than a harsh tone.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must)\b/i;
  const detail = advisories(checkOnly(emsPayload({ ADOP: '2026-7-4' })))[0]?.detail ?? '';

  assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
  assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
});

test('the detail never re-writes the supplier’s value into what we think it meant', () => {
  // '2026-7-4' looks obvious and '07/04/2026' is genuinely ambiguous — naming a
  // corrected value for either would be concluding, which this category forbids.
  // The only ISO date in the prose is the generic example.
  const detail = advisories(checkOnly(emsPayload({ CDAT: '07/04/2026' })))[0]?.detail ?? '';
  const isoDatesNamed = [...detail.matchAll(/\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/g)].map((m) => m[0]);
  assert.deepEqual(isoDatesNamed, ['2026-07-04'], `detail translates a value: ${detail}`);
});

test('the detail stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence's detail, so each one has to be readable without its siblings.
  const detail = advisories(checkOnly(emsPayload({ ADOP: '2026-7-4' })))[0]?.detail ?? '';
  assert.match(detail, /This transmission/);
  assert.doesNotMatch(detail, /this session|every transmission/i);
});
