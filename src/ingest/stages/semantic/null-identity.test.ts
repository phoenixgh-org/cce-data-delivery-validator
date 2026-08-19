/**
 * `adv.null_identity` — the advisory for a report that names no appliance
 * (pwd, bite bva slice C).
 *
 * bva's acceptance: it fires on a payload that is fully schema- AND
 * requirement-conformant, and moves NO requirement's pass/fail status. Both are
 * proved against the real machinery — the fixtures are validated by the real
 * `SchemaRegistry`, run through the real §6 body stages for their 200 and their
 * zero fail findings, and the §7 summary is computed with and without the
 * advisory findings and compared.
 *
 * ONE IDENTIFIER PER BRANCH IS THE POINT of half these cases (2km, 38p). pwd
 * states the case as "ASER and AMID both null", but the two report branches do
 * not carry the same identity fields and the other identifiers are not
 * substitutes: on `ems-report` the advisory reads ASER ALONE (AID is a
 * programme asset id, and the branch has no AMID property at all), and on
 * `rtmd-report` it reads AMID ALONE (ASER and AID are frequently never captured
 * on a retrofitted device). So the tests below pin each branch's single trigger
 * across null / absent / blank / populated, pin that populating the OTHER
 * identifiers no longer buys silence, and pin that on rtmd a blank AMID is the
 * advisory's whole conformant surface.
 *
 * The copy assertions are acceptance, not polish: slice B's tests guard
 * `ADVISORY_COPY` only, so the finding prose is held to the same bar here.
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
 * A schema-valid EMS transmission. `identity` is spread over the report, so a
 * case can send `ASER: null` (legal — the shared $defs is ["string","null"], and
 * ems-report requires the key, not a value) or add an AMID the branch does not
 * define (legal — ems-report is additionalProperties: true).
 */
function emsPayload(identity: Record<string, unknown>): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-null-identity-ems',
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
        ...identity,
        records: records('ems'),
      },
    ],
  };
}

/** A schema-valid RTMD transmission carrying the given identity fields. */
function rtmPayload(identity: Record<string, unknown>): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-null-identity-rtm',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: [
      {
        CID: 'US',
        EDOP: '2021-06-01',
        EMFR: 'EMD_Name',
        EMOD: 'EMD-ModelNo',
        EPQS: 'E006/999',
        ESER: 'EMD-SerialNum',
        EMSV: 'v01.02.123',
        DLST: { TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' } },
        ...identity,
        records: records('rtm'),
      },
    ],
  };
}

/** The EMS report that names nothing: ASER null, AID never sent. */
const EMS_UNIDENTIFIED = emsPayload({ ASER: null });
/** The RTMD report that names nothing: AMID present but empty (the only blank it allows). */
const RTM_UNIDENTIFIED = rtmPayload({ AMID: '' });

// ── harnesses ────────────────────────────────────────────────────────────────

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'null-identity-session',
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    registry,
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
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
  return nullIdentityCheck(ctx);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.null_identity');
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
    ['ems, ASER null', EMS_UNIDENTIFIED],
    ['rtm, AMID empty', RTM_UNIDENTIFIED],
  ] as const) {
    assert.equal(
      entry.validate(payload),
      true,
      `${name} is legal: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

test('EMS: it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(EMS_UNIDENTIFIED);
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
  assert.equal(raised[0]?.code, 'adv.null_identity');
  assert.ok(!raised[0]?.outdated);
  assert.equal(raised[0]?.pointer, '/data/0', 'points at the report that names nothing');
});

test('RTMD: it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(RTM_UNIDENTIFIED);
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 200);
  assert.equal(result.findings.filter((f) => f.severity === 'fail').length, 0);
  assert.equal(advisories(result.findings).length, 1);
});

// ── one identifier per branch (2km, 38p) ─────────────────────────────────────

test('EMS: the detail names ASER and what nothing else on the branch can stand in for', () => {
  assert.equal(
    detailOf(EMS_UNIDENTIFIED),
    '1 of 1 report in this transmission carries no appliance serial number — ASER is null. ' +
      "ASER is the serial number the appliance's manufacturer assigned, and nothing else on an " +
      'ems-report stands in for it: an ems-report has no AMID property, AID is an asset ' +
      'identifier a programme assigns, and ESER and LSER name the monitoring device and the ' +
      'logger rather than the appliance they watch. The 3 records under it arrive complete and ' +
      'fully conformant, and the country receiving them cannot tie those readings to the ' +
      "appliance by its manufacturer's serial number.",
  );
});

test('EMS: a populated AID does NOT silence it — AID is not the manufacturer serial', () => {
  // THE BEHAVIOUR CHANGE (2km). Before this, any one of AMID/ASER/AID kept the
  // advisory quiet. AID is a programme asset-tracking identifier the employer
  // assigns; it is not what the appliance's manufacturer programmed, so it is
  // not a substitute for ASER and no longer buys silence.
  assert.equal(advisories(checkOnly(emsPayload({ ASER: null, AID: 'asset-tag-9' }))).length, 1);
});

test('EMS: an AMID sent as an extra property does NOT silence it either', () => {
  // ems-report is additionalProperties: true, so a supplier MAY send AMID here.
  // It is still not the branch's appliance serial, and the branch does not
  // define it at all, so it is neither counted against them nor read as ASER.
  assert.equal(
    advisories(checkOnly(emsPayload({ ASER: null, AMID: 'cloud-appliance-7' }))).length,
    1,
  );
});

test('EMS: null, absent and blank ASER all fire; a populated ASER is silence', () => {
  for (const identity of [
    { ASER: null },
    {},
    { ASER: '' },
    { ASER: '   ' },
    // Every other identifier populated, and it still fires: only ASER is read.
    { ASER: null, AID: 'asset-tag-9', AMID: 'cloud-appliance-7' },
  ]) {
    assert.equal(
      advisories(checkOnly(emsPayload(identity))).length,
      1,
      `expected a firing for ${JSON.stringify(identity)}`,
    );
  }
  for (const identity of [
    { ASER: 'A-SerialNum' },
    // Silent even when everything else on the report is blank.
    { ASER: 'A-SerialNum', AID: null },
  ]) {
    assert.deepEqual(advisories(checkOnly(emsPayload(identity))), []);
  }
});

test('EMS: AMID is never reported as missing on a branch that never defined it', () => {
  // ABSENT IS NOT NULL. ems-report does not carry AMID (measured on
  // src/schemas/cce-interop-0.8.1.json), so a supplier who does not send one has
  // said nothing. The prose may explain that the property does not exist here;
  // it may never state that the supplier left it blank.
  const detail = detailOf(EMS_UNIDENTIFIED);
  assert.doesNotMatch(detail, /AMID is null|AMID is empty|AMID was not sent/);
});

test('RTMD: the detail names AMID and the narrow surface the schema leaves it', () => {
  assert.equal(
    detailOf(RTM_UNIDENTIFIED),
    '1 of 1 report in this transmission carries no appliance identifier — AMID is empty. AMID ' +
      "is the handle the supplier's own platform holds the appliance under, and an rtmd-report " +
      'carries it as a required, non-null string, so a blank value is the only form of this ' +
      'the schema itself lets through. ASER and AID are frequently never captured where the ' +
      'monitoring device was added to an appliance already in service, so neither is read as ' +
      'standing in for AMID. The 3 records under it arrive complete and fully conformant, and ' +
      'the country receiving them cannot tie those ' +
      "readings to an appliance in the supplier's platform.",
  );
});

test('RTMD: a populated ASER or AID does NOT silence it', () => {
  // THE BEHAVIOUR CHANGE (38p). Most RTMDs are retrofitted rather than
  // integrated at the factory, so appliance-side identifiers were often never
  // captured and are not reliable. AMID is the one graded, alone.
  assert.equal(advisories(checkOnly(rtmPayload({ AMID: '', ASER: 'A-SerialNum' }))).length, 1);
  assert.equal(
    advisories(checkOnly(rtmPayload({ AMID: '   ', ASER: 'A-SerialNum', AID: 'asset-tag-9' })))
      .length,
    1,
  );
});

test('RTMD: null, absent and blank AMID all fire; a populated AMID is silence', () => {
  for (const identity of [{ AMID: '' }, { AMID: '   ' }, { AMID: null }, {}]) {
    assert.equal(
      advisories(checkOnly(rtmPayload(identity))).length,
      1,
      `expected a firing for ${JSON.stringify(identity)}`,
    );
  }
  assert.deepEqual(advisories(checkOnly(rtmPayload({ AMID: 'appliance-1' }))), []);
  assert.deepEqual(
    advisories(checkOnly(rtmPayload({ AMID: 'appliance-1', ASER: null, AID: null }))),
    [],
  );
});

test('RTMD: a blank AMID is the advisory’s ONLY conformant surface on this branch', () => {
  // rtmd-report requires AMID and types it ["string"] — non-nullable — so null
  // and absent are already §3.2 failures and can only be reached by a payload
  // the schema stage rejects. That leaves the empty/whitespace string as the
  // whole conformant surface here (38p), which is why blanks count at all.
  const entry = registry.get('0.8.1');
  assert.ok(entry);
  assert.equal(entry.validate(rtmPayload({ AMID: '   ' })), true, 'whitespace-only is legal');
  assert.equal(entry.validate(rtmPayload({ AMID: null })), false, 'null is a §3.2 failure');
  assert.equal(entry.validate(rtmPayload({})), false, 'absent is a §3.2 failure');
});

test('ESER and LSER are not appliance identifiers', () => {
  // Both fixtures carry ESER (and the EMS one carries LSER, which ems-report
  // requires and types non-nullable). They name the device doing the watching,
  // so a report can carry both and still name no appliance — as these do.
  assert.equal(advisories(checkOnly(EMS_UNIDENTIFIED)).length, 1);
  assert.equal(advisories(checkOnly(RTM_UNIDENTIFIED)).length, 1);
});

// ── the governing constraint: it moves no requirement's status ───────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(EMS_UNIDENTIFIED);
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
  for (const detail of [detailOf(EMS_UNIDENTIFIED), detailOf(RTM_UNIDENTIFIED)]) {
    assert.doesNotMatch(detail, defectWords, `detail reads as a defect: ${detail}`);
    assert.doesNotMatch(detail, /data quality|practice note|observation/i, 'no renaming');
  }
});

test('the detail concludes nothing about the supplier’s equipment or their records', () => {
  for (const detail of [detailOf(EMS_UNIDENTIFIED), detailOf(RTM_UNIDENTIFIED)]) {
    assert.doesNotMatch(detail, /sensor|fitted|hardware|equipment is/i, `concludes: ${detail}`);
    // It says what the RECEIVING side cannot do, which is the only thing we can
    // speak to — never that the supplier lost track of the appliance.
    assert.match(detail, /the country receiving them cannot tie those readings to/);
    assert.match(detail, /arrive complete and fully conformant/, 'the payload is not faulted');
  }
});

test('the detail stands alone per transmission', () => {
  // Recurring advisories fold in the dashboard to the most recent detail only.
  for (const detail of [detailOf(EMS_UNIDENTIFIED), detailOf(RTM_UNIDENTIFIED)]) {
    assert.match(detail, /in this transmission/);
    assert.doesNotMatch(detail, /this session|every transmission/i);
  }
});
