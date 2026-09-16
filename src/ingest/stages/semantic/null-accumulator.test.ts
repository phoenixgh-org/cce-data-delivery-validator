/**
 * `adv.null_accumulator` — the advisory for a mains EMS record whose compressor
 * runtime arrived as null in a period the same record says had no AC supply
 * (agj.9).
 *
 * Acceptance, as for every advisory: it fires on a payload that is fully schema-
 * AND requirement-conformant, and moves NO requirement's pass/fail status. Both
 * are proved against the real machinery — the fixtures are validated by the real
 * `SchemaRegistry`, run through the real §6 body stages for their 200 and their
 * zero contract-profile fail findings, and the §7 summary is computed with and
 * without the advisory findings and compared.
 *
 * THE EXCLUSIVITY WITH `adv.null_padding` is pinned from both sides: a column of
 * nulls over twelve records is null_padding's observation and this check stays
 * silent on it, while an intermittent null is this check's and null_padding
 * stays silent on that. Both are run through the real registry of advisory
 * checks rather than asserted about in prose.
 *
 * The copy assertions are acceptance, not polish: the category's wording rule
 * (observe, never conclude) is held here the way null-identity.test.ts holds it.
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
import { nullAccumulatorCheck } from './null-accumulator.js';
import { nullPaddingCheck } from './null-padding.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * One mains EMS record at `hhmm` — a fully populated reading, with `over` spread
 * last so a case can set SVA to 0, null an accumulator, or plant an error code.
 * LERR and EERR are null in the base, which is what leaves a null unexplained.
 */
function emsRecord(hhmm: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ABST: `20240115T${hhmm}00Z`,
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

/** The same record on the SOLAR branch: DCSV + DCCD, and no SVA at all. */
function solarRecord(hhmm: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const record = emsRecord(hhmm, over);
  delete record.SVA;
  return { ...record, DCSV: 12.4, DCCD: 30 };
}

/** The administrative half of an `ems-report`, fully populated. */
function emsReport(records: Record<string, unknown>[]): Record<string, unknown> {
  return {
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
  };
}

/** An EMS transmission carrying the given reports. */
function emsPayload(...reports: Record<string, unknown>[][]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-null-accumulator-ems',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: reports.map((records) => emsReport(records)),
  };
}

/** The same shape declared as an RTMD transmission, to prove the branch gate. */
function rtmBranded(payload: Record<string, unknown>): Record<string, unknown> {
  const meta = { ...(payload.meta as Record<string, unknown>), transferType: 'rtm' };
  return { ...payload, meta };
}

/** Three records at 15-minute cadence, the middle one an outage with a null CMPR. */
const OUTAGE = emsPayload([
  emsRecord('0330'),
  emsRecord('0345', { SVA: 0, CMPR: null }),
  emsRecord('0400'),
]);

/**
 * The same outage with BOTH accumulators null, so the copy has to name two of
 * them. The plural form of every phrase turns on this fixture.
 */
const OUTAGE_BOTH = emsPayload([
  emsRecord('0330', { CMPR2: 300 }),
  emsRecord('0345', { SVA: 0, CMPR: null, CMPR2: null }),
  emsRecord('0400', { CMPR2: 300 }),
]);

/** Twelve records at 15-minute cadence, every one an outage with a null CMPR. */
function everyRecordNull(): Record<string, unknown> {
  const times = [
    '0300',
    '0315',
    '0330',
    '0345',
    '0400',
    '0415',
    '0430',
    '0445',
    '0500',
    '0515',
    '0530',
    '0545',
  ];
  return emsPayload(times.map((hhmm) => emsRecord(hhmm, { SVA: 0, CMPR: null })));
}

// ── harnesses ────────────────────────────────────────────────────────────────

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'null-accumulator-session',
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    registry,
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
    primaryProfile: null,
    shadowProfile: null,
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: null,
    schemaOk: null,
  };
}

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

/** Drive the check alone, with the branch the payload declares. */
function checkOnly(payload: Record<string, unknown>): Finding[] {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  ctx.meta = { transferType: String((payload.meta as { transferType?: unknown }).transferType) };
  return nullAccumulatorCheck(ctx);
}

/** The same context, driven through `adv.null_padding` instead. */
function paddingOnly(payload: Record<string, unknown>): Finding[] {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  ctx.meta = { transferType: String((payload.meta as { transferType?: unknown }).transferType) };
  return nullPaddingCheck(ctx) as Finding[];
}

/**
 * The fail findings of a run under the CONTRACT profile only — the schema stage
 * grades every transmission twice since by1c.6, so a "zero fails" claim about
 * this advisory has to say which profile it speaks for.
 */
function contractFails(ctx: PipelineContext, findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'fail' && f.profile !== ctx.shadowProfile);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.null_accumulator');
}

function detailOf(payload: Record<string, unknown>): string {
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  return finding.detail ?? '';
}

/** The one-line observation — where the counts live. */
function summaryOf(payload: Record<string, unknown>): string {
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  return finding.summary ?? '';
}

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

// ── acceptance: it fires on a fully conformant EMS payload ───────────────────

test('the fixture really is schema-conformant on both registered contract versions', () => {
  // A null CMPR needs no explanation on the 0.8.x lineage — that gap is the
  // whole surface of this advisory.
  for (const version of ['0.8.0', '0.8.1']) {
    const entry = registry.get(version);
    assert.ok(entry, `${version} is registered`);
    assert.equal(
      entry.validate(OUTAGE),
      true,
      `${version}: SVA 0 with a null CMPR is legal: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

test('it fires through the real §6 body stages on a 200 with zero contract fails', async () => {
  const ctx = makeCtx(OUTAGE);
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
  assert.equal(raised[0]?.code, 'adv.null_accumulator');
  assert.ok(!raised[0]?.outdated);
  assert.equal(raised[0]?.pointer, '/data/0/records/1', 'points at the first offending record');
});

test('the advisory moves no §7 requirement', () => {
  const run = async (): Promise<readonly Finding[]> => {
    const ctx = makeCtx(OUTAGE);
    const result = await runPipeline(ctx, bodyStages());
    return result.findings;
  };

  return run().then((findings) => {
    assert.equal(advisories(findings).length, 1, 'the advisory really is present');
    const withAdvisory = computeComplianceSummary(countsOf(findings));
    const without = computeComplianceSummary(
      countsOf(findings.filter((f) => !isAdvisoryId(f.requirement))),
    );
    assert.deepEqual(withAdvisory, without, 'the advisory moved a §7 row');
  });
});

// ── the condition, one clause at a time ──────────────────────────────────────

test('the untransformed EMS baseline shape is silence', () => {
  assert.deepEqual(
    advisories(checkOnly(emsPayload([emsRecord('0330'), emsRecord('0345'), emsRecord('0400')]))),
    [],
  );
});

test('an explanation beside the null keeps it quiet', () => {
  // A null beside a populated code is a fault the supplier is already reporting,
  // not a zero sent as null — LERR and EERR alike.
  for (const explanation of [{ LERR: 'L1' }, { EERR: 'E9' }]) {
    const payload = emsPayload([
      emsRecord('0330'),
      emsRecord('0345', { SVA: 0, CMPR: null, ...explanation }),
      emsRecord('0400'),
    ]);
    assert.deepEqual(advisories(checkOnly(payload)), [], JSON.stringify(explanation));
  }
  // A blank code explains nothing, so the advisory still speaks.
  const blank = emsPayload([
    emsRecord('0330'),
    emsRecord('0345', { SVA: 0, CMPR: null, LERR: '   ' }),
    emsRecord('0400'),
  ]);
  assert.equal(advisories(checkOnly(blank)).length, 1, 'a whitespace-only LERR is no explanation');
});

test('a zero runtime is the value the advisory is asking for', () => {
  const payload = emsPayload([
    emsRecord('0330'),
    emsRecord('0345', { SVA: 0, CMPR: 0 }),
    emsRecord('0400'),
  ]);
  assert.deepEqual(advisories(checkOnly(payload)), []);
});

test('supply available in the period is a deferred form, not this one', () => {
  // SVA 900 with a null CMPR: the true runtime is unknown from here, so the
  // correlated argument does not hold and the check says nothing.
  const payload = emsPayload([
    emsRecord('0330'),
    emsRecord('0345', { CMPR: null }),
    emsRecord('0400'),
  ]);
  assert.deepEqual(advisories(checkOnly(payload)), []);
});

test('the door accumulators are deferred too', () => {
  const payload = emsPayload([
    emsRecord('0330'),
    emsRecord('0345', { SVA: 0, DORV: null }),
    emsRecord('0400'),
  ]);
  assert.deepEqual(advisories(checkOnly(payload)), []);
});

test('a solar record carries nothing to read a runtime against', () => {
  // No SVA on the record at all: it is the solar branch of ems-record.allOf[0],
  // and nothing there can say the compressor could not have run.
  const payload = emsPayload([
    emsRecord('0330'),
    solarRecord('0345', { CMPR: null }),
    emsRecord('0400'),
  ]);
  assert.deepEqual(advisories(checkOnly(payload)), []);
});

test('the rtm branch is out of scope entirely', () => {
  assert.deepEqual(advisories(checkOnly(rtmBranded(OUTAGE))), []);
});

test('CMPR2 is read the same way, and named in its own right', () => {
  const payload = emsPayload([
    emsRecord('0330', { CMPR2: 210 }),
    emsRecord('0345', { SVA: 0, CMPR: 0, CMPR2: null }),
    emsRecord('0400', { CMPR2: 195 }),
  ]);
  const raised = advisories(checkOnly(payload));
  assert.equal(raised.length, 1);
  assert.equal(raised[0]?.pointer, '/data/0/records/1');
  assert.match(raised[0]?.summary ?? '', /CMPR2/);
  assert.doesNotMatch(
    raised[0]?.summary ?? '',
    /\bCMPR\b/,
    'CMPR itself arrived as 0, so it is not named',
  );
});

test('records are counted across reports, and the pointer names the first', () => {
  const payload = emsPayload(
    [emsRecord('0330'), emsRecord('0345', { SVA: 0, CMPR: null })],
    [emsRecord('0330'), emsRecord('0345', { SVA: 0, CMPR: null }), emsRecord('0400')],
  );
  const raised = advisories(checkOnly(payload));
  assert.equal(raised.length, 1, 'still one finding per transmission');
  assert.equal(raised[0]?.pointer, '/data/0/records/1');
  // The counts are the TRANSMISSION's, pooled across reports. How many reports
  // they came from left the copy with the approved observation (agj.17); the
  // pointer is what places them.
  assert.equal(
    raised[0]?.summary,
    '2 of 5 records carry CMPR as null in a period whose SVA is 0, with LERR and EERR blank.',
  );
});

// ── exclusivity with adv.null_padding (agj.9 acceptance) ─────────────────────

test('a column of nulls belongs to adv.null_padding, and this check stays silent', () => {
  // Twelve records, CMPR null in every one of them, every period an outage. The
  // null is not intermittent — nothing in the report says the accumulator ever
  // produces a number — so the observation owed is "this column is empty".
  const payload = everyRecordNull();
  assert.deepEqual(advisories(checkOnly(payload)), [], 'this advisory says nothing');

  const padding = paddingOnly(payload);
  assert.equal(padding.length, 1, 'null_padding is the surface that speaks');
  assert.match(padding[0]?.summary ?? '', /CMPR/);
});

test('an intermittent null belongs here, and adv.null_padding stays silent', () => {
  // The mirror: CMPR is numeric in other records, so null_padding's "null in
  // EVERY record that carried it" cannot hold and the two never name the same
  // property on the same transmission.
  assert.equal(advisories(checkOnly(OUTAGE)).length, 1);
  assert.deepEqual(paddingOnly(OUTAGE), []);
});

// ── wording is acceptance, not polish ────────────────────────────────────────

test('the copy carries no defect vocabulary and no synonym for the category', () => {
  // "should" is NOT on this list: the approved rationale's "the period's total
  // should be an explicit 0" is a recommendation in the house sense, the same
  // way sample_gap's "loggers should rarely produce gaps" is, and neither says
  // the payload broke a rule.
  // The list itself is imported, not re-spelled here (7qjf): a second copy
  // would drift the day a word is added to the shared bar.
  const defectWords = ADVISORY_COPY_BANNED_WORDS;
  for (const copy of [summaryOf(OUTAGE), detailOf(OUTAGE)]) {
    assert.doesNotMatch(copy, defectWords, `copy reads as a defect: ${copy}`);
    assert.doesNotMatch(copy, /data quality|practice note|observation about/i, 'no renaming');
  }
});

test('the copy observes rather than concludes, and offers the mechanism as a suggestion', () => {
  const copy = `${summaryOf(OUTAGE)} ${detailOf(OUTAGE)}`;
  assert.doesNotMatch(copy, /sensor|broke|broken|fault|faulty|suppress/i, `concludes: ${copy}`);
  // 52r's framing: a period in which nothing happened is a total of 0.
  assert.match(copy, /could not have run/);
  assert.match(copy, /should be an explicit 0/);
  // What the RECEIVING side cannot do is the only thing we can speak to.
  assert.match(copy, /unable to distinguish a period in which the compressor did not run/);
  // The compressor controller is named as what the numeric records SUGGEST, not
  // as a cause established from the payload.
  assert.match(copy, /which suggests the null appears when the compressor controller goes/);
});

test('the sentence reads as English with one accumulator named and with two (c4c4)', () => {
  // Pinned VERBATIM in both forms, observation and rationale. Both are assembled
  // from per-number fragments, so a fragment that is right in one form can be
  // broken in the other and the suite would not notice: "with nothing beside it
  // is to account for the null" and "both are accumulators" beside three named
  // objects both shipped and were read by suppliers.
  assert.equal(
    summaryOf(OUTAGE),
    '1 of 3 records carries CMPR as null in a period whose SVA is 0, with LERR and EERR blank.',
  );
  assert.equal(
    summaryOf(OUTAGE_BOTH),
    '1 of 3 records carries CMPR and CMPR2 as null in a period whose SVA is 0, with LERR and ' +
      'EERR blank.',
  );

  // The rationale carries no counts, but its third sentence names the
  // accumulators this finding was raised on, and the verb agrees with the list.
  assert.match(
    detailOf(OUTAGE),
    /CMPR arrives as a number in the other records of this report/,
    detailOf(OUTAGE),
  );
  assert.match(
    detailOf(OUTAGE_BOTH),
    /CMPR and CMPR2 arrive as numbers in the other records of this report/,
    detailOf(OUTAGE_BOTH),
  );

  // No pronoun+copula splice survives in either form.
  for (const copy of [detailOf(OUTAGE), detailOf(OUTAGE_BOTH)]) {
    assert.doesNotMatch(copy, /beside (it is|they are)\b/, `pronoun+copula splice: ${copy}`);
    assert.doesNotMatch(copy, /\bboth are accumulators\b/, copy);
  }
});

test('it names what arrived, then why an explicit 0 is what the country can add up', () => {
  assert.equal(
    detailOf(OUTAGE),
    'With no supplied electricity the compressor could not have run, so the ' +
      "period's total should be an explicit 0 that the receiving country can add up. A " +
      'null value here leaves the country unable to distinguish a period in which the ' +
      'compressor did not run from a period in which the compressor runtime could not be ' +
      'measured. ' +
      'CMPR arrives as a number in the other records of this report, which suggests the null ' +
      'appears when the compressor controller goes offline during a power outage, and a ' +
      'logger that already knows no power was supplied can report a runtime of 0 rather ' +
      'than null.',
  );
});

test('the plural form clears the same wording bars as the singular', () => {
  // The category's two rules are acceptance for every form of the sentence, not
  // only the one the other copy tests happen to drive.
  // The bar is the shared constant here too (w1e5): a re-spelled copy three
  // lines from the import would drift the day a word is added to it.
  for (const copy of [summaryOf(OUTAGE_BOTH), detailOf(OUTAGE_BOTH)]) {
    assert.doesNotMatch(copy, ADVISORY_COPY_BANNED_WORDS, `copy reads as a defect: ${copy}`);
    assert.doesNotMatch(copy, /sensor|broke|broken|fault|faulty|suppress/i, `concludes: ${copy}`);
  }
});

test('the observation stands alone per transmission, and the pointer names its first record', () => {
  // Recurring advisories fold in the dashboard to the most recent occurrence.
  assert.match(summaryOf(OUTAGE), /^1 of 3 records carries CMPR as null/);
  assert.doesNotMatch(summaryOf(OUTAGE), /this session|every transmission/i);
  assert.equal(advisories(checkOnly(OUTAGE))[0]?.pointer, '/data/0/records/1');
});
