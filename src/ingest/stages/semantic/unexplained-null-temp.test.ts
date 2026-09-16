/**
 * `adv.unexplained_null_temp` — the advisory for an `rtmd-report` record whose
 * TVC arrived as null with no error code beside it (agj.2).
 *
 * Acceptance, as for every advisory: it fires on a payload that is fully schema-
 * AND requirement-conformant, and moves NO requirement's pass/fail status. Both
 * are proved against the real machinery — the fixtures are validated by the real
 * `SchemaRegistry`, run through the real §6 body stages for their 200 and their
 * zero fail findings, and the §7 summary is computed with and without the
 * advisory findings and compared.
 *
 * THE BRANCH EXCLUSION is the point of several cases below. On `ems-record` the
 * schema itself requires a `minLength`-1 LERR beside a null TVC, in BOTH
 * registered versions, so the EMS case is a §3.2 failure and never this
 * advisory's. The tests pin that the schema really does reject it and that the
 * check stays silent there even when driven directly.
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
import { isAdvisoryId } from './advisory.js';
import { unexplainedNullTempCheck } from './unexplained-null-temp.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * An rtm record at `hhmm`, with `reading` spread over it last so a case can send
 * `TVC: null`, drop TVC entirely, or put an error code beside it. The base is a
 * fully populated reading: EERR 'none' is what the repo's own rtm fixture sends,
 * and under this check's rule a non-empty string is an explanation.
 */
function rtmRecord(hhmm: string, reading: Record<string, unknown> = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ABST: `20240115T${hhmm}00Z`,
    ALRM: null,
    BEMD: 14.3,
    EERR: 'none',
    TVC: 3.2,
    ...reading,
  };
  return record;
}

/** Three EMS records at 15-minute cadence — regular (§3.4) and under the padding floor. */
function emsRecords(reading: Record<string, unknown> = {}): Record<string, unknown>[] {
  return ['0330', '0345', '0400'].map((hhmm) => ({
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
    ...reading,
  }));
}

/** A schema-valid RTMD transmission carrying exactly the records given. */
function rtmPayload(records: Record<string, unknown>[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-unexplained-null-temp-rtm',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: [{ ...rtmReport(), records }],
  };
}

/** The administrative half of an `rtmd-report`, fully populated. */
function rtmReport(): Record<string, unknown> {
  return {
    AMID: 'appliance-1',
    CID: 'US',
    EDOP: '2021-06-01',
    EMFR: 'EMD_Name',
    EMOD: 'EMD-ModelNo',
    EPQS: 'E006/999',
    ESER: 'EMD-SerialNum',
    EMSV: 'v01.02.123',
    DLST: { TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' } },
  };
}

/** An EMS transmission carrying the given record override on all three records. */
function emsPayload(reading: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-unexplained-null-temp-ems',
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
        records: emsRecords(reading),
      },
    ],
  };
}

/** The case: one rtm record whose TVC is null and whose EERR is null, with no LERR. */
const RTM_UNEXPLAINED = rtmPayload([rtmRecord('0330', { TVC: null, EERR: null })]);

// ── harnesses ────────────────────────────────────────────────────────────────

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'unexplained-null-temp-session',
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
function checkOnly(payload: { meta: { transferType?: unknown } }): Finding[] {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  ctx.meta = { transferType: String(payload.meta.transferType) };
  return unexplainedNullTempCheck(ctx);
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
  return findings.filter((f) => f.requirement === 'adv.unexplained_null_temp');
}

function detailOf(payload: { meta: { transferType?: unknown } }): string {
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  return finding.detail ?? '';
}

/** The one-line observation — where every number lives. */
function summaryOf(payload: { meta: { transferType?: unknown } }): string {
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

// ── acceptance: it fires on a fully conformant RTMD payload ──────────────────

test('the fixture really is schema-conformant on the current registered schema', () => {
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  assert.equal(
    entry.validate(RTM_UNEXPLAINED),
    true,
    `a null TVC with a null EERR is legal on rtmd-record: ${JSON.stringify(entry.validate.errors)}`,
  );
});

test('RTMD: it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(RTM_UNEXPLAINED);
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
  assert.equal(raised[0]?.code, 'adv.unexplained_null_temp');
  assert.ok(!raised[0]?.outdated);
  assert.equal(raised[0]?.pointer, '/data/0/records/0', 'points at the first offending record');
});

// ── the EMS branch belongs to the schema, not to this check (agj.2) ──────────

test('EMS: the schema itself rejects a null TVC with a null LERR, in BOTH registered versions', () => {
  // This is WHY there is no EMS arm. ems-record's allOf carries a oneOf whose
  // abnormal case requires TVC null AND LERR a minLength-1 string, so stage 7
  // halts 422 and stage 8 never runs on the EMS form of this case.
  for (const version of ['0.8.0', '0.8.1']) {
    const entry = registry.get(version);
    assert.ok(entry, `${version} is registered`);
    assert.equal(
      entry.validate(emsPayload({ TVC: null, LERR: null })),
      false,
      `${version}: a null TVC with a null LERR is a §3.2 failure`,
    );
    assert.equal(
      entry.validate(emsPayload({ TVC: null, LERR: '' })),
      false,
      `${version}: an empty LERR does not satisfy the minLength`,
    );
    assert.equal(
      entry.validate(emsPayload({ TVC: null, LERR: 'L1' })),
      true,
      `${version}: a populated LERR is the schema's own explanation`,
    );
  }
});

test('EMS: the check returns nothing even when driven directly on that payload', () => {
  // Belt and braces on the branch gate: an EMS payload cannot reach stage 8 in
  // production, and if it somehow did, the check would still say nothing rather
  // than duplicate Ajv with an info finding.
  assert.deepEqual(checkOnly(emsPayload({ TVC: null, LERR: null })), []);
  assert.deepEqual(checkOnly(emsPayload({ TVC: null, LERR: null, EERR: null })), []);
});

// ── what "unexplained" means ─────────────────────────────────────────────────

test('RTMD: a fully populated reading is silence', () => {
  assert.deepEqual(advisories(checkOnly(rtmPayload([rtmRecord('0330')]))), []);
});

test('RTMD: an EERR beside the null reading is an explanation', () => {
  // The record says the reading was not taken AND why, which is the behaviour
  // the check is asking for — so it stays quiet.
  assert.deepEqual(
    advisories(checkOnly(rtmPayload([rtmRecord('0330', { TVC: null, EERR: 'E1' })]))),
    [],
  );
});

test('RTMD: a LERR beside the null reading explains it too, with EERR null', () => {
  assert.deepEqual(
    advisories(checkOnly(rtmPayload([rtmRecord('0330', { TVC: null, LERR: 'L1', EERR: null })]))),
    [],
  );
});

test('RTMD: both codes null is the case, and the pointer names the record', () => {
  const findings = advisories(checkOnly(RTM_UNEXPLAINED));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pointer, '/data/0/records/0');
});

test('RTMD: a blank EERR explains nothing — empty and whitespace-only both fire', () => {
  for (const eerr of ['', '   ']) {
    assert.equal(
      advisories(checkOnly(rtmPayload([rtmRecord('0330', { TVC: null, EERR: eerr })]))).length,
      1,
      `expected a firing for EERR ${JSON.stringify(eerr)}`,
    );
  }
});

test('RTMD: a non-string code is read as an explanation — we grade what we can prove', () => {
  // Not schema-valid, but the rule matters: the check never converts a shape it
  // cannot read into an observation about the supplier.
  for (const eerr of [7, { code: 'E1' }]) {
    assert.deepEqual(
      advisories(checkOnly(rtmPayload([rtmRecord('0330', { TVC: null, EERR: eerr })]))),
      [],
      `expected silence for EERR ${JSON.stringify(eerr)}`,
    );
  }
});

test('RTMD: a record that never sent TVC is not this advisory’s case', () => {
  // rtmd-record's anyOf lets a device report TFRZ or TAMB instead, so an absent
  // TVC is a freezer or an ambient-only sensor rather than a reading that was
  // attempted and lost. Only `TVC: null` fires.
  const record = rtmRecord('0330', { EERR: null });
  delete record.TVC;
  record.TAMB = 23.1;
  assert.deepEqual(advisories(checkOnly(rtmPayload([record]))), []);
});

test('RTMD: the literal EERR "none" the repo’s own fixture sends counts as an explanation', () => {
  // Stated out loud because it bounds the check: a placeholder is a non-empty
  // string, and telling one from a real code would be a judgement about the
  // supplier rather than an observation about the payload.
  assert.deepEqual(
    advisories(checkOnly(rtmPayload([rtmRecord('0330', { TVC: null })]))),
    [],
    'EERR "none" is a non-empty string',
  );
});

// ── counting and the pointer ─────────────────────────────────────────────────

test('RTMD: the count is of RECORDS, and the pointer is the FIRST offending one', () => {
  const payload = rtmPayload([
    rtmRecord('0330'),
    rtmRecord('0345', { TVC: null, EERR: null }),
    rtmRecord('0400'),
    rtmRecord('0415', { TVC: null, EERR: null }),
  ]);
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding);
  assert.equal(finding.pointer, '/data/0/records/1');
  assert.equal(finding.summary, '2 of 4 records carry TVC as null with LERR and EERR both blank.');
});

test('RTMD: offending records in two reports are counted together', () => {
  const payload = rtmPayload([rtmRecord('0330'), rtmRecord('0345', { TVC: null, EERR: null })]);
  const data = payload.data as Record<string, unknown>[];
  data.push({
    ...rtmReport(),
    AMID: 'appliance-2',
    records: [rtmRecord('0330', { TVC: null, EERR: null })],
  });

  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding);
  assert.equal(finding.pointer, '/data/0/records/1', 'the first offender, not the first report');
  // The counts are the TRANSMISSION's, pooled across reports. How many reports
  // they came from left the copy with the approved observation (agj.17); the
  // drill-down from the pointer is what places them.
  assert.equal(finding.summary, '2 of 3 records carry TVC as null with LERR and EERR both blank.');
});

test('RTMD: non-object reports and non-object records are skipped rather than counted', () => {
  const payload = rtmPayload([rtmRecord('0330', { TVC: null, EERR: null })]);
  const data = payload.data as unknown[];
  (data[0] as Record<string, unknown>).records = [
    null,
    'not-a-record',
    rtmRecord('0345', { TVC: null, EERR: null }),
  ];
  data.push('not-a-report', 42);

  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding);
  assert.equal(finding.pointer, '/data/0/records/2', 'index counts the array, not the objects');
  assert.equal(finding.summary, '1 of 1 record carries TVC as null with LERR and EERR both blank.');
});

test('an empty data array gives it nothing to observe', () => {
  const payload = rtmPayload([]);
  (payload.data as unknown[]).length = 0;
  assert.deepEqual(checkOnly(payload), []);
});

// ── the governing constraint: it moves no requirement's status ───────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(RTM_UNEXPLAINED);
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

test('it names what arrived, then why a null TVC is worth following up', () => {
  assert.equal(
    summaryOf(RTM_UNEXPLAINED),
    '1 of 1 record carries TVC as null with LERR and EERR both blank.',
  );
  assert.equal(
    detailOf(RTM_UNEXPLAINED),
    'rtmd-record allows a null TVC without tying it to anything that accounts for it, so ' +
      'these records are fully conformant. However, TVC is the most essential measurement ' +
      'for protecting vaccine health, so null TVC values should be investigated to ensure ' +
      'proper device operation.',
  );
});

test('the copy carries no defect vocabulary and no synonym for the category', () => {
  // `error` is deliberately absent from this list where the other advisories
  // carry it: LERR and EERR are titled "Logger Error Codes" and "EMD Error
  // Codes" in the schema itself, so naming the field is naming the payload
  // rather than grading it. "should" is absent too — the approved rationale's
  // "should be investigated" is a recommendation in the house sense, not a
  // statement that the payload broke a rule. Everything else that reads as a
  // verdict is barred.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must)\b/i;
  for (const copy of [summaryOf(RTM_UNEXPLAINED), detailOf(RTM_UNEXPLAINED)]) {
    assert.doesNotMatch(copy, defectWords, `copy reads as a defect: ${copy}`);
    assert.doesNotMatch(copy, /data quality|practice note|observation about/i, 'no renaming');
  }
});

test('the copy concludes nothing about the device', () => {
  // The rationale Benson settled on 2026-09-15 replaced the earlier draft's
  // "a quiet null may be ordinary on an RTMD", which read as a reason to leave
  // it alone. It still names no cause: a reading the device did not take and one
  // it could not obtain are indistinguishable from the receiving side.
  const copy = `${summaryOf(RTM_UNEXPLAINED)} ${detailOf(RTM_UNEXPLAINED)}`;
  assert.doesNotMatch(copy, /sensor|broke|broken|fault|faulty|suppress/i, `concludes: ${copy}`);
  assert.match(detailOf(RTM_UNEXPLAINED), /fully conformant/, 'the payload is not faulted');
});

test('the observation stands alone per transmission', () => {
  // Recurring advisories fold in the dashboard to the most recent occurrence.
  const summary = summaryOf(RTM_UNEXPLAINED);
  assert.match(summary, /^1 of 1 record carries TVC as null/);
  assert.doesNotMatch(summary, /this session|every transmission/i);
});
