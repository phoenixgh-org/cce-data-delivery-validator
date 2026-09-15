/**
 * `adv.short_identifier` — the advisory for an identifier that arrived populated
 * and is still too short to carry enough distinct values for a national fleet
 * (krh).
 *
 * Acceptance, as for every advisory: it fires on a payload that is fully schema-
 * AND requirement-conformant, and moves NO requirement's pass/fail status. Both
 * are proved against the real machinery — the fixtures are validated by the real
 * `SchemaRegistry`, run through the real §6 body stages for their 200 and their
 * zero fail findings, and the §7 summary is computed with and without the
 * advisory findings and compared.
 *
 * THE DIVISION OF LABOUR with `adv.null_identity` and `adv.blank_admin` is the
 * subject of several cases below. A blank value is never "short": this check
 * reads only values whose trimmed length is between one and three, so the three
 * advisories are exclusive by construction and a blank AMID raises
 * `adv.null_identity` alone.
 *
 * The copy assertions are acceptance, not polish: the category's wording rule
 * (observe, never conclude) is held here the same way null-identity.test.ts holds
 * it, plus krh's own bar — the prose must never claim a collision.
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
import { nullIdentityCheck } from './null-identity.js';
import { shortIdentifierCheck } from './short-identifier.js';

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
      : { ABST: `20240115T${hhmm}00Z`, ALRM: null, BEMD: 14.3, EERR: 'none', TVC: 3.2 },
  );
}

/** The fully populated EMS report the fixtures shorten identifiers on. */
function emsReport(): Record<string, unknown> {
  return {
    CID: 'US',
    ADOP: '2020-12-01',
    AMFR: 'Alpha Fridge, Inc',
    AMOD: 'FRIDGE-100',
    APQS: 'E003/998',
    ASER: 'A-SerialNum',
    AID: 'asset-tag-9',
    EDOP: '2021-06-01',
    EMFR: 'EMD_Name',
    EMOD: 'EMD-ModelNo',
    EPQS: 'E006/999',
    ESER: 'EMD-SerialNum',
    EID: 'emd-tag-3',
    EMSV: 'v01.02.123',
    LDOP: '2021-08-15',
    LMFR: 'Logger_Co',
    LMOD: 'Logger_Model',
    LPQS: 'E006/998',
    LSER: 'log4567890asdf',
    LID: 'logger-tag-7',
    LSV: 'v01.02.008',
    records: records('ems'),
  };
}

/** A schema-valid EMS transmission; `over` shortens or clears one identifier. */
function emsPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-short-id-ems',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: [{ ...emsReport(), ...over }],
  };
}

/** The fully populated RTMD report, sensor list included. */
function rtmReport(): Record<string, unknown> {
  return {
    AMID: 'appliance-1',
    ASER: 'A-SerialNum',
    AID: 'asset-tag-9',
    CID: 'US',
    EDOP: '2021-06-01',
    EMFR: 'EMD_Name',
    EMOD: 'EMD-ModelNo',
    EPQS: 'E006/999',
    ESER: 'EMD-SerialNum',
    EID: 'emd-tag-3',
    EMSV: 'v01.02.123',
    DLST: { TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' } },
    records: records('rtm'),
  };
}

/** A schema-valid RTMD transmission; `over` shortens or clears one identifier. */
function rtmPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-short-id-rtm',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: [{ ...rtmReport(), ...over }],
  };
}

/** The EMS shape: a three-character appliance serial number. */
const EMS_SHORT_ID = emsPayload({ ASER: 'A12' });
/** The RTMD shape, and the exercise case's: a three-character AMID. */
const RTM_SHORT_ID = rtmPayload({ AMID: 'A12' });

// ── harnesses ────────────────────────────────────────────────────────────────

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'short-identifier-session',
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

function ctxFor(payload: { meta: { transferType?: unknown } }): PipelineContext {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  ctx.meta = { transferType: String(payload.meta.transferType) };
  return ctx;
}

/** Drive the check alone, with the branch the payload declares. */
function checkOnly(payload: { meta: { transferType?: unknown } }): Finding[] {
  return shortIdentifierCheck(ctxFor(payload));
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
  return findings.filter((f) => f.requirement === 'adv.short_identifier');
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
    ['ems, ASER "A12"', EMS_SHORT_ID],
    ['rtm, AMID "A12"', RTM_SHORT_ID],
  ] as const) {
    assert.equal(
      entry.validate(payload),
      true,
      `${name} is legal: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

test('EMS: it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(EMS_SHORT_ID);
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
  assert.equal(raised[0]?.code, 'adv.short_identifier');
  assert.ok(!raised[0]?.outdated);
  assert.equal(raised[0]?.pointer, '/data/0/ASER', 'points at the value, not the report');
});

test('RTMD: it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(RTM_SHORT_ID);
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 200);
  assert.equal(contractFails(ctx, result.findings).length, 0);

  const raised = advisories(result.findings);
  assert.equal(raised.length, 1);
  assert.equal(raised[0]?.pointer, '/data/0/AMID');
});

// ── a fully populated baseline is silence, on both branches ──────────────────

test('a report whose identifiers are all four characters or longer is silence', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload())), []);
  assert.deepEqual(advisories(checkOnly(rtmPayload())), []);
});

// ── the threshold ────────────────────────────────────────────────────────────

test('one, two and three characters fire; exactly four does not', () => {
  // The boundary IS the decision (see the module header): four characters of a
  // 36-symbol alphabet span 1,679,616 values and clear a national fleet, so a
  // legitimate four-character serial is deliberately left alone.
  for (const value of ['A', 'A1', 'A12']) {
    assert.equal(
      advisories(checkOnly(emsPayload({ ASER: value }))).length,
      1,
      `expected a firing for ASER ${JSON.stringify(value)}`,
    );
  }
  assert.deepEqual(advisories(checkOnly(emsPayload({ ASER: 'A123' }))), [], 'four is not short');
  assert.deepEqual(advisories(checkOnly(emsPayload({ ASER: 'A1234' }))), []);
});

test('the value is trimmed before it is measured', () => {
  // Surrounding whitespace is not identification, and counting it would let
  // padding silence the check.
  assert.match(detailOf(emsPayload({ ASER: '  A1  ' })), /ASER is 2 characters/);
  assert.equal(advisories(checkOnly(emsPayload({ ASER: '   A123   ' }))).length, 0);
});

test('a one-character value reads "1 character", not "1 characters"', () => {
  assert.match(detailOf(emsPayload({ ASER: 'A' })), /ASER is 1 character\b/);
});

// ── which fields are read ────────────────────────────────────────────────────

test('EMS: every identifier the branch declares is read', () => {
  for (const key of ['ASER', 'LSER', 'ESER', 'AID', 'LID', 'EID']) {
    const detail = detailOf(emsPayload({ [key]: 'AB' }));
    assert.match(detail, new RegExp(`${key} is 2 characters`), `${key} is not read`);
  }
});

test('RTMD: every identifier the branch declares is read, AMID included', () => {
  for (const key of ['ASER', 'LSER', 'ESER', 'AMID', 'AID', 'LID', 'EID']) {
    const detail = detailOf(rtmPayload({ [key]: 'AB' }));
    assert.match(detail, new RegExp(`${key} is 2 characters`), `${key} is not read`);
  }
});

test('RTMD: SID is read under every sensor in DLST, and the pointer reaches it', () => {
  const payload = rtmPayload({
    DLST: {
      TVC: { SID: 'AB', SMFR: 'SensMfr', SMOD: 'SensMod' },
      TAMB: { SID: 'sensor-2', SMFR: 'SensMfr', SMOD: 'SensMod' },
    },
  });
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  assert.equal(finding.pointer, '/data/0/DLST/TVC/SID');
  assert.match(finding.detail ?? '', /DLST\.TVC SID is 2 characters/);
  // The populated second sensor is not named.
  assert.doesNotMatch(finding.detail ?? '', /DLST\.TAMB/);

  // Every sensor is walked, not just the required TVC.
  const onTamb = rtmPayload({
    DLST: {
      TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' },
      TAMB: { SID: 'S2', SMFR: 'SensMfr', SMOD: 'SensMod' },
    },
  });
  assert.equal(advisories(checkOnly(onTamb))[0]?.pointer, '/data/0/DLST/TAMB/SID');
});

test('EMS: the sensor walk does not run — ems-report declares no DLST', () => {
  // DLST is an rtmd-report property. An EMS payload carrying one as an
  // additional property is a different observation and not this one.
  const payload = emsPayload({ DLST: { TVC: { SID: 'AB', SMFR: 'M', SMOD: 'X' } } });
  assert.deepEqual(advisories(checkOnly(payload)), []);
});

test('CSER, CSER2, FID and CID are never read', () => {
  // CSER/CSER2 are titled "Compressor Electronic Unit Product Code" — a product
  // code, legitimately short. FID and CID do not identify the monitored unit:
  // CID is a two-letter country code by construction.
  for (const payload of [
    emsPayload({ CSER: 'AB', CSER2: 'AB', FID: 'AB', CID: 'US' }),
    rtmPayload({ CSER: 'AB', CSER2: 'AB', FID: 'AB', CID: 'US' }),
  ]) {
    assert.deepEqual(advisories(checkOnly(payload)), [], 'a product or place code fired');
  }
});

// ── blanks belong to the other two advisories ────────────────────────────────

test('a blank, null or absent identifier is never "short"', () => {
  // Trimmed length zero is a BLANK, and adv.null_identity / adv.blank_admin own
  // it. The three advisories are exclusive by construction.
  for (const over of [{ ASER: '' }, { ASER: '   ' }, { ASER: null }]) {
    assert.deepEqual(
      advisories(checkOnly(emsPayload(over))),
      [],
      `fired on a blank: ${JSON.stringify(over)}`,
    );
  }
  const report = emsReport();
  delete report.ASER;
  const absent = { ...emsPayload(), data: [report] } as { meta: { transferType?: unknown } };
  assert.deepEqual(advisories(checkOnly(absent)), []);
});

test('PIN: a blank AMID raises adv.null_identity and NOT this advisory', () => {
  const payload = rtmPayload({ AMID: '   ' });
  assert.deepEqual(advisories(checkOnly(payload)), [], 'short_identifier stays silent');
  assert.equal(nullIdentityCheck(ctxFor(payload)).length, 1, 'null_identity speaks');
});

test('PIN: the exercise case’s payload trips this advisory and NOT null_identity', () => {
  // What src/exercise/cases/payload.ts declares: AMID shortened but left
  // non-blank, so the case's expectedFindings really is this advisory alone.
  assert.equal(advisories(checkOnly(RTM_SHORT_ID)).length, 1);
  assert.deepEqual(nullIdentityCheck(ctxFor(RTM_SHORT_ID)), []);
});

test('a value that is not a string is not graded', () => {
  // A length in characters is not defined for a value that is not text.
  for (const over of [{ ASER: 12 }, { ASER: { id: 'A1' } }, { ASER: ['A1'] }, { ASER: true }]) {
    assert.deepEqual(
      advisories(checkOnly(emsPayload(over))),
      [],
      `graded a non-string: ${JSON.stringify(over)}`,
    );
  }
  const payload = rtmPayload({ DLST: { TVC: { SID: 7, SMFR: 'M', SMOD: 'X' } } });
  assert.deepEqual(advisories(checkOnly(payload)), []);
});

// ── counting and the pointer ─────────────────────────────────────────────────

test('multiple reports: the count is of reports and the pointer is the first offender', () => {
  const payload = {
    ...emsPayload(),
    data: [emsReport(), { ...emsReport(), ASER: 'A12' }, { ...emsReport(), LID: 'L1' }],
  } as { meta: { transferType?: unknown } };

  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  assert.equal(finding.pointer, '/data/1/ASER', 'the first short value in the transmission');
  assert.match(finding.detail ?? '', /^2 of 3 reports in this transmission carry /);
  // The listed values are the FIRST offender's, and the prose says so rather
  // than letting the list read as a claim about all of them.
  assert.match(finding.detail ?? '', /in the first, ASER is 3 characters/);
  assert.doesNotMatch(finding.detail ?? '', /LID/);
});

test('every short identifier on the first offending report is named', () => {
  const detail = detailOf(rtmPayload({ AMID: 'A1', ESER: 'E12', LID: 'L' }));
  for (const named of ['ESER is 3 characters', 'AMID is 2 characters', 'LID is 1 character']) {
    assert.match(detail, new RegExp(named), `expected the detail to name ${named}`);
  }
});

test('non-object entries in `data` are skipped, not counted', () => {
  const payload = {
    ...emsPayload(),
    data: ['not-a-report', 7, null, { ...emsReport(), ASER: 'A12' }],
  } as { meta: { transferType?: unknown } };

  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  assert.equal(finding.pointer, '/data/3/ASER', 'the index is the position in `data`');
  assert.match(finding.detail ?? '', /^1 of 1 report in this transmission carries /);
});

test('an empty or missing `data` array gives it nothing to observe', () => {
  assert.deepEqual(advisories(checkOnly({ ...emsPayload(), data: [] })), []);
  assert.deepEqual(advisories(checkOnly({ meta: { transferType: 'ems' } })), []);
});

// ── the governing constraint: it moves no requirement's status ───────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(RTM_SHORT_ID);
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

test('the detail carries no defect vocabulary and no synonym for the category', () => {
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must|should)\b/i;
  for (const detail of [detailOf(EMS_SHORT_ID), detailOf(RTM_SHORT_ID)]) {
    assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
    assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
  }
});

test('PIN: the detail never claims a collision — krh’s governing constraint', () => {
  // We cannot prove a short identifier is non-unique, and the validator sees one
  // supplier's sandbox data, so it usually cannot observe an actual collision
  // either. The stronger signal is deferred to cce-data-delivery-validator-0rfk.
  for (const detail of [detailOf(EMS_SHORT_ID), detailOf(RTM_SHORT_ID)]) {
    assert.doesNotMatch(detail, /collid|collision|clash|duplicate|reused|re-used|not unique/i);
    assert.doesNotMatch(detail, /same appliance|two appliances share/i);
    // What it DOES say is arithmetic about the value space, and that it takes no
    // position on the values actually sent.
    assert.match(detail, /too short to distinguish the equipment in a national fleet/);
    assert.match(detail, /whether or not the values sent so far happen to be distinct/);
  }
});

test('the detail states the threshold and the fleet-size reasoning behind it', () => {
  // The threshold is a judgment call, so the wire prose carries its argument
  // rather than leaving the supplier to guess at the number.
  const detail = detailOf(RTM_SHORT_ID);
  assert.match(detail, /fewer than four characters/);
  assert.match(detail, /10,000 to 100,000 appliances/);
  assert.match(detail, /46,656 values and four span 1,679,616/);
});

test('EMS: the detail reads as one whole observation', () => {
  assert.equal(
    detailOf(EMS_SHORT_ID),
    '1 of 1 report in this transmission carries an identifier of fewer than four characters ' +
      '— ASER is 3 characters. These values name the appliance, the logger and the monitoring ' +
      'device, and no identifier object in this schema version carries a minimum length, so a ' +
      'one-character value satisfies it. A national cold chain holds on the order of 10,000 ' +
      'to 100,000 appliances, and the identifiers delivered into one country are allocated ' +
      'across several suppliers, so the value space in use is on the order of a million. ' +
      'Three characters of a 36-symbol alphanumeric alphabet span 46,656 values and four span ' +
      '1,679,616, so a value of this length is too short to distinguish the equipment in a ' +
      'national fleet under any alphabet. The country receiving these readings holds them ' +
      'under an identifier of that width, whether or not the values sent so far happen to be ' +
      'distinct.',
  );
});

test('RTMD: the detail names the sensor list its branch carries', () => {
  const detail = detailOf(RTM_SHORT_ID);
  assert.match(detail, /^1 of 1 report in this transmission carries an identifier of fewer/);
  assert.match(detail, /AMID is 3 characters/);
  assert.match(detail, /each sensor listed under DLST/);
});

test('the detail stands alone per transmission', () => {
  // Recurring advisories fold in the dashboard to the most recent detail only.
  for (const detail of [detailOf(EMS_SHORT_ID), detailOf(RTM_SHORT_ID)]) {
    assert.match(detail, /in this transmission/);
  }
});
