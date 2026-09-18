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
import { advisoryCopyBannedWordsWith, violatesAdvisoryCopyBar } from './advisory-finding.js';
import { isAdvisoryId } from './advisory.js';
import { nullIdentityCheck } from './null-identity.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
  findPriorUnitWindows: async () => [],
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
/** The same report cut to ONE record — `records` has minItems 1, and the repo's rtm baseline
 * (src/ingest/fixtures/transmissions.ts) sends exactly one, so this is the ordinary shape. */
const RTM_ONE_RECORD = ((): Record<string, unknown> => {
  const payload = rtmPayload({ AMID: '' });
  const [report] = payload.data as Record<string, unknown>[];
  report!.records = records('rtm').slice(0, 1);
  return payload;
})();

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
  return nullIdentityCheck(ctx);
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
  return findings.filter((f) => f.requirement === 'adv.null_identity');
}

function detailOf(payload: { meta: { transferType?: unknown } }): string {
  const [finding] = advisories(checkOnly(payload));
  assert.ok(finding, 'expected the advisory to be raised');
  return finding.detail ?? '';
}

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
    contractFails(ctx, result.findings).length,
    0,
    `expected no contract-profile fail findings, got ${JSON.stringify(contractFails(ctx, result.findings))}`,
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
  assert.equal(contractFails(ctx, result.findings).length, 0);
  assert.equal(advisories(result.findings).length, 1);
});

// ── one identifier per branch (2km, 38p) ─────────────────────────────────────

test('EMS: the observation names the count and how ASER arrived; the rationale is the why', () => {
  // The approved agj.17 copy, split: summary is the one-line observation shown
  // on the advisory row, detail the rationale behind its expander.
  assert.equal(
    summaryOf(EMS_UNIDENTIFIED),
    '1 of 1 report carries no appliance serial number — ASER is null.',
  );
  assert.equal(
    detailOf(EMS_UNIDENTIFIED),
    'ASER is the appliance serial number, as assigned by the manufacturer. No other ID is an ' +
      'adequate substitute. Without this attribute, the receiving country cannot tie the ' +
      'records to the appliance.',
  );
});

test('EMS: the observation pluralises reports and the verb independently', () => {
  // The noun agrees with the TOTAL, the verb with how many of them are unnamed,
  // so a mixed transmission reads correctly either way round.
  const payload = emsPayload({ ASER: null }) as { data: Record<string, unknown>[] };
  payload.data.push({ ...payload.data[0]!, ASER: 'A-SerialNum' }, { ...payload.data[0]! });
  assert.equal(
    summaryOf(payload as never),
    '2 of 3 reports carry no appliance serial number — in the first, ASER is null.',
  );
});

test('EMS: with one report unnamed the observation makes no claim about the others', () => {
  // "in the first, …" appears only in the plural: with several unnamed reports
  // the states can differ, and a bare "ASER is null" would be a claim about all
  // of them that the check has not made.
  assert.doesNotMatch(summaryOf(EMS_UNIDENTIFIED), /in the first/);
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
  const copy = `${summaryOf(EMS_UNIDENTIFIED)} ${detailOf(EMS_UNIDENTIFIED)}`;
  assert.doesNotMatch(copy, /AMID is null|AMID is empty|AMID was not sent/);
});

test('RTMD: the observation names AMID, and the rationale is the branch’s own', () => {
  // NOT "no appliance identifier" (67tf). This advisory reads AMID alone, and
  // fires while ASER and AID may be populated — see the RTMD case below — so the
  // claim is scoped to the supplier's own platform handle and nothing wider.
  assert.equal(
    summaryOf(RTM_UNIDENTIFIED),
    '1 of 1 report carries no supplier-platform appliance identifier — AMID is empty.',
  );
  assert.equal(
    detailOf(RTM_UNIDENTIFIED),
    "AMID is the identifier under which the supplier's platform holds the appliance. The " +
      'schema requires it as a non-null string, so a blank is the only form that passes, and ' +
      'neither ASER nor AID stands in for it on a retrofitted logger. Without this attribute, ' +
      "the receiving country cannot tie the records to an appliance in the supplier's platform.",
  );
});

test('RTMD: the rationale is third person — no "your platform" (decided 2026-09-15)', () => {
  // The blurb addresses the supplier directly; the per-advisory rationales do
  // not. Benson settled this one explicitly when approving the copy.
  assert.doesNotMatch(detailOf(RTM_UNIDENTIFIED), /\byour\b/i);
});

test('RTMD: how many records sat under the report is no longer part of the copy', () => {
  // The approved observation stops at the identifier (agj.17); a one-record
  // report and a three-record one therefore read identically, and the records
  // themselves are reached through the finding's pointer.
  assert.equal(summaryOf(RTM_ONE_RECORD), summaryOf(RTM_UNIDENTIFIED));
  assert.doesNotMatch(summaryOf(RTM_ONE_RECORD), /record/);
});

test('RTMD: the one-record report the singular is rendered for really is conformant', () => {
  const entry = registry.get('0.8.1');
  assert.ok(entry);
  assert.equal(
    entry.validate(RTM_ONE_RECORD),
    true,
    `one record is legal: ${JSON.stringify(entry.validate.errors)}`,
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
  // The shared bar plus `should` (7qjf): nothing in this check's approved
  // prose recommends anything, so a recommendation here would be the copy
  // drifting toward a verdict. Composed from the shared list rather than
  // spelled out, so a word added there reaches this stricter bar too, and
  // applied through the shared helper (agj.25) so the exempt phrases are
  // removed the way a live run removes them.
  const defectWords = advisoryCopyBannedWordsWith('should');
  for (const copy of [
    summaryOf(EMS_UNIDENTIFIED),
    detailOf(EMS_UNIDENTIFIED),
    summaryOf(RTM_UNIDENTIFIED),
    detailOf(RTM_UNIDENTIFIED),
  ]) {
    assert.ok(!violatesAdvisoryCopyBar(copy, defectWords), `copy reads as a defect: ${copy}`);
    assert.doesNotMatch(copy, /data quality|practice note|observation/i, 'no renaming');
  }
});

test('the rationale concludes nothing about the supplier’s equipment or their records', () => {
  for (const detail of [detailOf(EMS_UNIDENTIFIED), detailOf(RTM_UNIDENTIFIED)]) {
    // Word-bounded: the approved rtm rationale names a "retrofitted logger",
    // which is a fact about how RTMDs are installed, not a conclusion about this
    // supplier's hardware.
    assert.doesNotMatch(
      detail,
      /\b(sensor|fitted|hardware)\b|equipment is/i,
      `concludes: ${detail}`,
    );
    // It says what the RECEIVING side cannot do, which is the only thing we can
    // speak to — never that the supplier lost track of the appliance.
    assert.match(detail, /the receiving country cannot tie the records to/);
  }
});

test('the observation stands alone per transmission', () => {
  // Recurring advisories fold in the dashboard to the most recent occurrence, so
  // the observation carries this transmission's own numbers and no wider claim.
  for (const summary of [summaryOf(EMS_UNIDENTIFIED), summaryOf(RTM_UNIDENTIFIED)]) {
    assert.match(summary, /^1 of 1 report carries/);
    assert.doesNotMatch(summary, /this session|every transmission/i);
  }
});
