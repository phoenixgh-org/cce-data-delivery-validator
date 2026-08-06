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
 * THE BRANCH ASYMMETRY IS THE POINT of half these cases. pwd states the case as
 * "ASER and AMID both null", but the two report branches do not carry the same
 * identity fields: `ems-report` has no AMID property at all, and `rtmd-report`
 * makes AMID REQUIRED and non-nullable. So the tests below pin what each branch
 * looks at, that an absent field on a branch that never defined it is not
 * counted as missing, and that an empty AMID — the only blank AMID the rtmd
 * branch permits — is enough.
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

// ── the ems/rtmd asymmetry ───────────────────────────────────────────────────

test('EMS: it names ASER and AID, and says why AMID is not among them', () => {
  assert.equal(
    detailOf(EMS_UNIDENTIFIED),
    '1 of 1 report in this transmission carries no appliance identifier — ASER is null; AID was ' +
      'not sent (an ems-report has no AMID property, so ASER and AID are the only appliance ' +
      'identifiers this branch carries). The 3 records under it arrive complete and fully ' +
      'conformant, and the country receiving them has no appliance to file those readings ' +
      'under — ESER and LSER identify the monitoring device rather than the appliance it watches.',
  );
});

test('EMS: an AMID the branch never defined is never reported as missing', () => {
  // ABSENT IS NOT NULL. ems-report does not carry AMID (measured on
  // src/schemas/cce-interop-0.8.1.json), so a supplier who does not send one has
  // said nothing — claiming they left it null would be a statement about them
  // that the schema, not the supplier, is responsible for.
  const detail = detailOf(EMS_UNIDENTIFIED);
  assert.doesNotMatch(detail, /AMID is null|AMID is empty|AMID was not sent/);
});

test('EMS: an AMID sent anyway still names the appliance, and silences the advisory', () => {
  // ems-report is additionalProperties: true, so a supplier MAY send AMID on
  // this branch. A stable appliance reference is one wherever it rides.
  assert.deepEqual(
    advisories(checkOnly(emsPayload({ ASER: null, AMID: 'cloud-appliance-7' }))),
    [],
  );
});

test('RTMD: it names all three identifiers, and adds no branch note', () => {
  assert.equal(
    detailOf(RTM_UNIDENTIFIED),
    '1 of 1 report in this transmission carries no appliance identifier — AMID is empty; ASER ' +
      'and AID were not sent. The 3 records under it arrive complete and fully conformant, and ' +
      'the country receiving them has no appliance to file those readings under — ESER and LSER ' +
      'identify the monitoring device rather than the appliance it watches.',
  );
});

test('RTMD: a blank AMID is reachable ONLY as an empty string, which is why blanks count', () => {
  // rtmd-report requires AMID and types it ["string"] — non-nullable. If only a
  // literal null counted as blank, this advisory could never fire on the rtmd
  // branch at all; an empty AMID identifies exactly as much equipment as a null
  // one would. Whitespace-only is the same value with a space in it.
  assert.equal(advisories(checkOnly(rtmPayload({ AMID: '   ' }))).length, 1);
  assert.equal(advisories(checkOnly(rtmPayload({ AMID: 'appliance-1' }))).length, 0);
});

test('a named appliance keeps it silent even when the other identifiers are null', () => {
  assert.deepEqual(advisories(checkOnly(rtmPayload({ AMID: 'appliance-1', ASER: null }))), []);
  assert.deepEqual(advisories(checkOnly(emsPayload({ ASER: 'A-SerialNum' }))), []);
  assert.deepEqual(advisories(checkOnly(emsPayload({ ASER: null, AID: 'asset-tag-9' }))), []);
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
    assert.match(detail, /the country receiving them has no appliance to file those readings/);
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
