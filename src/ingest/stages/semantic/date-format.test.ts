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
import { ADVISORY_COPY_BANNED_WORDS } from './advisory-finding.js';
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
    primaryProfile: null,
    shadowProfile: null,
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

/**
 * The fail findings of a run under the CONTRACT profile only.
 *
 * Since bd by1c.6 the schema stage grades every transmission twice, so a payload
 * that is fully conformant under the 2025 contract may still carry shadow fail
 * findings describing how it would fare under DS01.3. Those are the other
 * profile's verdict; a "zero fails" claim about this advisory has to say which
 * profile it speaks for.
 */
function contractFails(ctx: PipelineContext, findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'fail' && f.profile !== ctx.shadowProfile);
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
    contractFails(ctx, result.findings).length,
    0,
    `expected no contract-profile fail findings, got ${JSON.stringify(contractFails(ctx, result.findings))}`,
  );

  const raised = advisories(result.findings);
  assert.equal(raised.length, 1, 'one finding per transmission');
  assert.equal(raised[0]?.severity, 'info');
  assert.equal(raised[0]?.code, 'adv.date_format', 'the adv.* id rides in code too');
  assert.ok(!raised[0]?.outdated, 'never outdated — that would file it as a defect');
  assert.equal(raised[0]?.pointer, '/data/0/ADOP', 'points at the first offending value');
});

// ── the two profiles, two surfaces (by1c.6 item 8) ──────────────────────────
//
// Advisories need no profile gate. They run only after the PRIMARY schema pass,
// so which surface speaks follows from which lineage the payload declared.

test('2025-primary: the advisory and the ds013 shadow failure both describe the date', async () => {
  const ctx = makeCtx(emsPayload({ ADOP: '2026-7-4' }));
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(
    result.status,
    200,
    '0.8.1 has nothing to say about a date, so the body is accepted',
  );
  assert.equal(advisories(result.findings).length, 1, 'the advisory speaks');

  // The Annex 4 draft DOES pattern the date objects, so the shadow run grades
  // the same value as a 5.3.2 failure. Two surfaces, one fact, by design: the
  // advisory says what the contract cannot grade, the shadow says what the
  // successor would.
  const shadowDate = result.findings.filter(
    (f) => f.profile === ctx.shadowProfile && f.pointer === '/data/0/ADOP',
  );
  assert.equal(shadowDate.length, 1, 'one shadow finding on the offending value');
  assert.equal(shadowDate[0]?.requirement, '5.3.2');
  assert.equal(shadowDate[0]?.keyword, 'pattern');
  assert.equal(shadowDate[0]?.severity, 'fail');
});

test('ds013-primary: the same date is rejected 422, and no advisory is raised', async () => {
  const payload = emsPayload({ ADOP: '2026-7-4' });
  (payload.meta as Record<string, unknown>).schemaVersion = '1';
  const ctx = makeCtx(payload);
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 422, 'the Annex 4 pattern rejects the value outright');
  assert.deepEqual(
    advisories(result.findings),
    [],
    'stage 8 never runs, so nothing double-reports',
  );
  const graded = result.findings.filter(
    (f) => f.severity === 'fail' && f.pointer === '/data/0/ADOP',
  );
  assert.equal(graded.length, 1);
  assert.equal(graded[0]?.requirement, '5.3.2', 'graded under the lineage that rejected it');
  assert.equal(graded[0]?.profile, 'ds013');
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
    assert.match(finding.summary ?? '', new RegExp(`${field} at /data/0/${field} arrived as`));
  });
}

test('record-level EDOP is observed on the EMS branch', () => {
  const [finding] = advisories(checkOnly(emsPayload({}, [{}, { EDOP: '2026-7-4' }])));
  assert.ok(finding);
  assert.equal(finding.pointer, '/data/0/records/1/EDOP');
  assert.match(finding.summary ?? '', /EDOP at \/data\/0\/records\/1\/EDOP arrived as "2026-7-4"/);
});

test('record-level EDOP is observed on the RTMD branch', () => {
  const [finding] = advisories(checkOnly(rtmdPayload({}, { EDOP: '1/6/21' }), 'rtm'));
  assert.ok(finding);
  assert.equal(finding.pointer, '/data/0/records/0/EDOP');
  assert.match(finding.summary ?? '', /EDOP at \/data\/0\/records\/0\/EDOP arrived as "1\/6\/21"/);
});

test('the observation counts every offending field and names the FIRST one', () => {
  // Only the first field is named (agj.17): the observation is one line, and the
  // rest are reached through the raw-payload drill-down the pointer opens.
  const [finding] = advisories(
    checkOnly(emsPayload({ ADOP: '2026-7-4', CDAT2: '07/04/2026' }, [{ EDOP: '1/6/21' }, {}])),
  );
  assert.ok(finding);
  assert.equal(
    finding.summary,
    '3 date fields are not YYYY-MM-DD — ADOP at /data/0/ADOP arrived as "2026-7-4".',
  );
  assert.equal(finding.pointer, '/data/0/ADOP', 'and the pointer is that first one');
  for (const later of ['CDAT2', '07/04/2026', '1/6/21']) {
    assert.ok(!finding.summary?.includes(later), `${later} is counted, not named`);
  }
});

test('repeats of the same field fold into one entry', () => {
  // A transmission can carry hundreds of records, and a record-level EDOP
  // mis-shaped in every one of them is ONE field in another form, not hundreds.
  const [finding] = advisories(
    checkOnly(emsPayload({}, [{ EDOP: '2026-7-4' }, { EDOP: '2026-7-5' }, { EDOP: '2026-7-6' }])),
  );
  assert.ok(finding);
  assert.equal(
    finding.summary,
    '1 date field is not YYYY-MM-DD — EDOP at /data/0/records/0/EDOP arrived as "2026-7-4".',
  );
  assert.doesNotMatch(finding.summary ?? '', /2026-7-6/, 'later values are counted, not listed');
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

test('it names the field, the value as sent, and the ISO form expected', () => {
  const [finding] = advisories(checkOnly(emsPayload({ ADOP: '2026-7-4' })));

  assert.equal(
    finding?.summary,
    '1 date field is not YYYY-MM-DD — ADOP at /data/0/ADOP arrived as "2026-7-4".',
  );
  assert.equal(
    finding?.detail,
    'The DS01 date objects (ADOP, LDOP, EDOP, CDAT, CDAT2) are plain strings, so a date ' +
      'arrives in whatever form it was written. YYYY-MM-DD, the ISO 8601 calendar date ' +
      'format, is prescribed by DS01 Annex 1, ensuring that every date representation has ' +
      'the same field widths, which is what lets a receiving system order and compare them.',
  );
});

test('the rationale cites DS01 Annex 1 as what prescribes the form', () => {
  // Decided 2026-09-15, verified against the Annex 1 spreadsheet: the schema
  // declares these as bare strings, so Annex 1 is where the form comes from.
  const detail = advisories(checkOnly(emsPayload({ ADOP: '2026-7-4' })))[0]?.detail ?? '';
  assert.match(detail, /prescribed by DS01 Annex 1/);
  assert.match(detail, /order and compare them/, 'and what uniform field widths buy');
});

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  // Same bar the Advisories copy is held to (src/web/advisories.test.ts): the
  // payload broke no rule — the schema accepts these values — so any of these
  // would be a false statement about the supplier rather than a harsh tone.
  // The list itself is imported, not re-spelled here (7qjf): a second copy
  // would drift the day a word is added to the shared bar.
  const defectWords = ADVISORY_COPY_BANNED_WORDS;
  const [finding] = advisories(checkOnly(emsPayload({ ADOP: '2026-7-4' })));

  for (const copy of [finding?.summary ?? '', finding?.detail ?? '']) {
    assert.doesNotMatch(copy, defectWords, `copy reads as a defect: ${copy}`);
    assert.doesNotMatch(copy, /data quality|practice note|observation/i, 'no renaming');
  }
});

test('the copy never re-writes the supplier’s value into what we think it meant', () => {
  // '2026-7-4' looks obvious and '07/04/2026' is genuinely ambiguous — naming a
  // corrected value for either would be concluding, which this category forbids.
  // The approved rationale carries no worked example, so no ISO date appears at
  // all: any that did would be a value we had invented.
  const [finding] = advisories(checkOnly(emsPayload({ CDAT: '07/04/2026' })));
  const copy = `${finding?.summary ?? ''} ${finding?.detail ?? ''}`;
  const isoDatesNamed = [...copy.matchAll(/\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/g)].map((m) => m[0]);
  assert.deepEqual(isoDatesNamed, [], `copy translates a value: ${copy}`);
});

test('the observation stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence, so the observation has to be readable without its siblings.
  const summary = advisories(checkOnly(emsPayload({ ADOP: '2026-7-4' })))[0]?.summary ?? '';
  assert.match(summary, /^1 date field is not YYYY-MM-DD — ADOP at \/data\/0\/ADOP/);
  assert.doesNotMatch(summary, /this session|every transmission/i);
});
