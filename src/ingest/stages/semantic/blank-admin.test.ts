/**
 * `adv.blank_admin` — the advisory for administrative objects a report's own
 * schema branch requires and the supplier delivered blank (agj.5).
 *
 * Acceptance, as for every advisory: it fires on a payload that is fully schema-
 * AND requirement-conformant, and moves NO requirement's pass/fail status. Both
 * are proved against the real machinery — the fixtures are validated by the real
 * `SchemaRegistry`, run through the real §6 body stages for their 200 and their
 * zero fail findings, and the §7 summary is computed with and without the
 * advisory findings and compared.
 *
 * THE DIVISION OF LABOUR with `adv.null_identity` is the point of several cases
 * below. The identity trio (ASER, AID, AMID) is not read here at all, so a
 * report whose ASER is null and whose administrative objects are all populated
 * raises null_identity ALONE, and the exercise case deliberately leaves ASER
 * populated so the two do not both fire on one payload.
 *
 * The copy assertions are acceptance, not polish: the category's wording rule
 * (observe, never conclude) is held here the same way null-identity.test.ts
 * holds it.
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
import { blankAdminCheck } from './blank-admin.js';
import { nullIdentityCheck } from './null-identity.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Three records at 15-minute cadence — regular (§3.4) and under the padding floor. */
function records(shape: 'ems' | 'rtm'): Record<string, unknown>[] {
  return ['0330', '0345', '0400'].map((hhmm) =>
    shape === 'ems'
      ? {
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
        }
      : { ABST: `20240115T${hhmm}00Z`, ALRM: null, BEMD: 14.3, EERR: null, TVC: 3.2 },
  );
}

/**
 * A schema-valid EMS transmission whose report is fully populated. `admin` is
 * spread over the report, so a case can blank any one object — legal for the
 * eleven nullable ones as a null, and legal everywhere as `""`, since nothing on
 * the branch carries a `minLength`.
 */
function emsPayload(admin: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-blank-admin-ems',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: [{ ...emsReport(), ...admin }],
  };
}

/** The fully populated EMS report the fixtures blank fields out of. */
function emsReport(): Record<string, unknown> {
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
    records: records('ems'),
  };
}

/** A schema-valid RTMD transmission whose report is fully populated. */
function rtmPayload(admin: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-blank-admin-rtm',
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
        ...admin,
        records: records('rtm'),
      },
    ],
  };
}

/** The motivating EMS shape: a nullable object nulled and a non-nullable one blank. */
const EMS_BLANK_ADMIN = emsPayload({ AMFR: null, LMOD: '' });
/** The RTMD equivalent: one of its six nullable administrative objects nulled. */
const RTM_BLANK_ADMIN = rtmPayload({ EMFR: null });

// ── harnesses ────────────────────────────────────────────────────────────────

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'blank-admin-session',
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
  return blankAdminCheck(ctxFor(payload));
}

function ctxFor(payload: { meta: { transferType?: unknown } }): PipelineContext {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  ctx.meta = { transferType: String(payload.meta.transferType) };
  return ctx;
}

/**
 * The fail findings of a run under the CONTRACT profile only — the shadow
 * profile's verdict is a different surface (by1c.6), so a "zero fails" claim has
 * to say which profile it speaks for.
 */
function contractFails(ctx: PipelineContext, findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'fail' && f.profile !== ctx.shadowProfile);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.blank_admin');
}

function detailOf(payload: { meta: { transferType?: unknown } }): string {
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  return finding.detail ?? '';
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

// ── acceptance: it fires on fully conformant payloads, on both branches ──────

test('both fixtures really are schema-conformant on the current registered schema', () => {
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  for (const [name, payload] of [
    ['ems, AMFR null and LMOD blank', EMS_BLANK_ADMIN],
    ['rtm, EMFR null', RTM_BLANK_ADMIN],
  ] as const) {
    assert.equal(
      entry.validate(payload),
      true,
      `${name} is legal: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

test('EMS: it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(EMS_BLANK_ADMIN);
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
  assert.equal(raised[0]?.code, 'adv.blank_admin');
  assert.ok(!raised[0]?.outdated);
  assert.equal(raised[0]?.pointer, '/data/0', 'points at the report that arrived blank');
});

test('RTMD: it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(RTM_BLANK_ADMIN);
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 200);
  assert.equal(contractFails(ctx, result.findings).length, 0);
  assert.equal(advisories(result.findings).length, 1);
});

// ── what counts as blank, and on which branch ────────────────────────────────

test('EMS: a fully populated report is silence', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload())), []);
});

test('EMS: one nullable administrative object sent as null fires, and is named', () => {
  // The ordinary fully-conformant firing path: ten of the fifteen are
  // ["string","null"], so the null is legal and only this check speaks to it.
  const detail = detailOf(emsPayload({ AMFR: null }));
  assert.match(detail, /AMFR is null/);
  assert.equal(advisories(checkOnly(emsPayload({ AMFR: null }))).length, 1);
});

test('EMS: a blank string on a NON-NULLABLE object fires — the schema sets no minimum length', () => {
  // LDOP LMFR LMOD LPQS LSER are `type: "string"`, so null and absent are
  // already §3.2 failures there. The empty (or whitespace-only) string is the
  // whole conformant surface on those five, which is why blanks count at all.
  for (const admin of [{ LMOD: '' }, { LSER: '   ' }, { LPQS: '' }]) {
    assert.equal(
      advisories(checkOnly(emsPayload(admin))).length,
      1,
      `expected a firing for ${JSON.stringify(admin)}`,
    );
  }
  const entry = registry.get('0.8.1');
  assert.ok(entry);
  assert.equal(entry.validate(emsPayload({ LMOD: '' })), true, 'a blank LMOD is legal');
  assert.equal(entry.validate(emsPayload({ LMOD: null })), false, 'a null LMOD is a §3.2 failure');
});

test('EMS: every blank object is named, with no cap', () => {
  // 52r retired the six-name cap the category once carried: the list IS the
  // actionable part, and the branch bounds it at fifteen.
  const detail = detailOf(
    emsPayload({ CID: null, ADOP: null, AMFR: null, AMOD: null, APQS: null, LMOD: '', LSER: '  ' }),
  );
  for (const named of [
    'CID is null',
    'ADOP is null',
    'AMFR is null',
    'AMOD is null',
    'APQS is null',
    'LMOD is empty',
    'LSER is empty',
  ]) {
    assert.match(detail, new RegExp(named), `expected the detail to name ${named}`);
  }
});

test('EMS: an absent object reads "was not sent" rather than null', () => {
  // ABSENT IS NOT NULL. A nullable required key can only be absent on a payload
  // the schema stage rejected, so this path is defensive — but the prose still
  // has to say which of the two arrived.
  const report = emsReport();
  delete report.AMFR;
  const payload = { ...emsPayload(), data: [report] } as { meta: { transferType?: unknown } };
  assert.match(detailOf(payload), /AMFR was not sent/);
});

test('EMS: a value that is not a string and not null is treated as content', () => {
  // We grade what we can prove: a number or an object in an administrative slot
  // is a different observation, and not one this advisory makes.
  assert.deepEqual(advisories(checkOnly(emsPayload({ AMOD: 42 }))), []);
});

test('RTMD: the branch reads its own six and nothing else', () => {
  // ADOP, AMFR, AMOD, APQS, LDOP, LMFR, LMOD, LPQS and LSER are not required by
  // rtmd-report, so blanking them says nothing here. (rtmd-report is
  // additionalProperties: true, so a supplier MAY send them.)
  const notMine = {
    ADOP: null,
    AMFR: null,
    AMOD: null,
    APQS: null,
    LDOP: '',
    LMFR: '',
    LMOD: '',
    LPQS: '',
    LSER: '',
  };
  assert.deepEqual(advisories(checkOnly(rtmPayload(notMine))), []);

  for (const admin of [{ CID: null }, { EDOP: null }, { EMFR: '' }, { ESER: '   ' }]) {
    assert.equal(
      advisories(checkOnly(rtmPayload(admin))).length,
      1,
      `expected a firing for ${JSON.stringify(admin)}`,
    );
  }
});

test('RTMD: DLST is never read — an object is not an administrative string', () => {
  // rtmd-report REQUIRES DLST and types it `object`. What an empty sensor list
  // owes is a separate question (agj.5 scopes it out), so an empty `{}` is
  // silence here rather than a blank.
  assert.deepEqual(advisories(checkOnly(rtmPayload({ DLST: {} }))), []);
  assert.doesNotMatch(detailOf(RTM_BLANK_ADMIN), /DLST/);
});

// ── the identity trio belongs to adv.null_identity ───────────────────────────

test('the identity trio is never named, on either branch', () => {
  for (const payload of [
    emsPayload({ ASER: null, AID: null, AMFR: null }),
    rtmPayload({ AMID: '', ASER: null, AID: null, EMFR: null }),
  ]) {
    const detail = detailOf(payload);
    assert.doesNotMatch(detail, /\bASER\b|\bAID\b|\bAMID\b/, `named the identity trio: ${detail}`);
  }
});

test('PIN: a null ASER with every administrative object populated fires null_identity ALONE', () => {
  // The division of labour, stated as a test. ASER is required on ems-report and
  // nullable, so this payload is fully conformant and adv.null_identity owns it;
  // blank_admin does not double-report the same blank.
  const payload = emsPayload({ ASER: null });
  assert.deepEqual(advisories(checkOnly(payload)), [], 'blank_admin stays silent');
  assert.equal(nullIdentityCheck(ctxFor(payload)).length, 1, 'null_identity speaks');
});

test('PIN: the exercise case’s payload shape trips this advisory and NOT null_identity', () => {
  // What src/exercise/cases/payload.ts declares: AMFR null and LMOD blank with
  // ASER left populated, so the case's expectedFindings really is this advisory
  // on its own.
  assert.equal(advisories(checkOnly(EMS_BLANK_ADMIN)).length, 1);
  assert.deepEqual(nullIdentityCheck(ctxFor(EMS_BLANK_ADMIN)), []);
});

// ── counting and the pointer ─────────────────────────────────────────────────

test('multiple reports: the count is of reports and the pointer is the first offender', () => {
  const payload = {
    ...emsPayload(),
    data: [emsReport(), { ...emsReport(), AMFR: null }, { ...emsReport(), LMOD: '' }],
  } as { meta: { transferType?: unknown } };

  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  assert.equal(finding.pointer, '/data/1', 'the first report that arrived blank');
  assert.match(finding.detail ?? '', /^2 of 3 reports in this transmission carry /);
  // The listed fields are the FIRST offender's, and the prose says so rather
  // than letting the list read as a claim about all of them.
  assert.match(finding.detail ?? '', /in the first, AMFR is null/);
});

test('non-object entries in `data` are skipped, not counted', () => {
  const payload = {
    ...emsPayload(),
    data: ['not-a-report', 7, null, { ...emsReport(), AMFR: null }],
  } as { meta: { transferType?: unknown } };

  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  assert.equal(
    finding.pointer,
    '/data/3',
    'the index is the position in `data`, not in the filter',
  );
  assert.match(finding.detail ?? '', /^1 of 1 report in this transmission carries /);
});

test('an empty or missing `data` array gives it nothing to observe', () => {
  assert.deepEqual(advisories(checkOnly({ ...emsPayload(), data: [] })), []);
  assert.deepEqual(advisories(checkOnly({ meta: { transferType: 'ems' } })), []);
});

// ── the governing constraint: it moves no requirement's status ───────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(EMS_BLANK_ADMIN);
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

test('EMS: the detail reads as one whole observation', () => {
  assert.equal(
    detailOf(EMS_BLANK_ADMIN),
    '1 of 1 report in this transmission carries administrative objects that ems-report ' +
      'requires, delivered blank — AMFR is null and LMOD is empty. These objects describe the ' +
      'country, the appliance, the logger and the monitoring device rather than the readings ' +
      'taken from them, and they arrive once per report rather than once per reading. ' +
      'ems-report requires all fifteen of the keys read here; ten of them also accept null, ' +
      'none of them carries a minimum length, and so a null or an empty string satisfies the ' +
      'schema. The 3 records under it arrive complete and fully conformant, and the country ' +
      'receiving them holds readings whose description of the equipment is blank in those ' +
      'places.',
  );
});

test('RTMD: the detail speaks for its own branch', () => {
  assert.equal(
    detailOf(RTM_BLANK_ADMIN),
    '1 of 1 report in this transmission carries administrative objects that rtmd-report ' +
      'requires, delivered blank — EMFR is null. These objects describe the country and the ' +
      'monitoring device rather than the readings taken from it, and they arrive once per ' +
      'report rather than once per reading. rtmd-report requires all six of the keys read ' +
      'here; all six also accept null, none of them carries a minimum length, and so a null or ' +
      'an empty string satisfies the schema. The 3 records under it arrive complete and fully ' +
      'conformant, and the country receiving them holds readings whose description of the ' +
      'equipment is blank in those places.',
  );
});

test('a single record reads "The 1 record under it arrives", not "arrive"', () => {
  // `records` has minItems 1 and the repo's own rtm baseline sends exactly one,
  // so the singular is the ordinary shape rather than an edge case.
  const payload = rtmPayload({ EMFR: null });
  const [report] = payload.data as Record<string, unknown>[];
  report!.records = records('rtm').slice(0, 1);
  const detail = detailOf(payload as { meta: { transferType?: unknown } });
  assert.match(detail, /The 1 record under it arrives complete and fully conformant/);
});

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must|should)\b/i;
  for (const detail of [detailOf(EMS_BLANK_ADMIN), detailOf(RTM_BLANK_ADMIN)]) {
    assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
    assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
  }
});

test('the detail concludes nothing about the supplier or their commissioning process', () => {
  // The PQS framing that motivates the check ("easy to ignore, figuring the data
  // will be there when the monitor is put into a real fridge") belongs in the
  // module header. The wire prose says what arrived, and stops.
  for (const detail of [detailOf(EMS_BLANK_ADMIN), detailOf(RTM_BLANK_ADMIN)]) {
    assert.doesNotMatch(detail, /forgot|never configured|commission|bench|real fridge/i);
    assert.match(detail, /arrive[s]? complete and fully conformant/, 'the payload is not faulted');
  }
});

test('the detail stands alone per transmission', () => {
  // Recurring advisories fold in the dashboard to the most recent detail only.
  for (const detail of [detailOf(EMS_BLANK_ADMIN), detailOf(RTM_BLANK_ADMIN)]) {
    assert.match(detail, /in this transmission/);
    assert.doesNotMatch(detail, /this session|every transmission/i);
  }
});
