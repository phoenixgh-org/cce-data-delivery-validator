/**
 * `adv.identifier_disagreement` — the advisory for two reports of ONE transmission
 * that carry the same appliance-side identifier beside different companion
 * identifiers (7yuv).
 *
 * Acceptance, as for every advisory: it fires on a payload that is fully schema-
 * AND requirement-conformant, and moves NO requirement's pass/fail status. The
 * fixtures are validated by the real `SchemaRegistry` and the firing case runs
 * through the real §6 body stages for its 200 and its zero contract-profile fail
 * findings, the way identifier-collision.test.ts does.
 *
 * NO DEP IS STUBBED, and that is the difference from the sibling: the observation
 * is a fact about one body, so the check is a pure function of `ctx.parsedBody` and
 * needs neither a lookup nor a database.
 *
 * The copy assertions are acceptance, not polish: the approved sentences are pinned
 * verbatim, including the roughly-90-character figure this id keeps — it cites no
 * prior delivery, so the guidance applies to it in full.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeComplianceSummary } from '../../../api/compliance-matrix.js';
import { computeUnitIdentities } from '../../../identity/unit-key.js';
import { SchemaRegistry } from '../../../schema-registry.js';
import { runPipeline, type Finding, type PipelineContext, type Stage } from '../../pipeline.js';
import { contentTypeStage } from '../content-type.js';
import { encodingStage } from '../encoding.js';
import { parseStage } from '../parse.js';
import { schemaStage } from '../schema.js';
import { semanticStage, type SemanticDeps } from '../semantic.js';
import { sizeStage } from '../size.js';
import { findAdvisoryCopyViolation } from './advisory-finding.js';
import { ADVISORY_IDS_CITING_A_PRIOR, isAdvisoryId } from './advisory.js';
import {
  IDENTIFIER_DISAGREEMENT_ID,
  IDENTIFIER_DISAGREEMENT_RATIONALE,
  identifierDisagreementCheck,
} from './identifier-disagreement.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

// ── fixtures ─────────────────────────────────────────────────────────────────

/** One RTMD record, so every fixture report carries the records the schema wants. */
function rtmRecord(): Record<string, unknown> {
  return { ABST: '20200115T040000Z', ALRM: 'HEAT', BEMD: 14.3, EERR: 'none', TVC: 3.2 };
}

/** An RTMD report carrying whichever of the three appliance identifiers are given. */
function rtmReport(ids: Record<string, unknown>): Record<string, unknown> {
  return {
    CID: 'US',
    EDOP: '2021-06-01',
    EMFR: 'EMD_Name',
    EMOD: 'EMD-ModelNo',
    EPQS: 'E006/999',
    ESER: 'EMD-SerialNum',
    EMSV: 'v01.02.123',
    DLST: { TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' } },
    ...ids,
    records: [rtmRecord()],
  };
}

/** An RTMD transmission carrying the given reports. */
function rtmPayload(...reports: Record<string, unknown>[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-disagreement',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: reports,
  };
}

/** One serial, two platform handles, inside one body — the motivating shape. */
const ONE_SERIAL_TWO_HANDLES = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
);

/**
 * Two reports naming no serial at all, which `rtmd-report` allows — `ASER` is
 * optional there while `AMID` is required. It is the shape the ('amid','aid') and
 * ('aid','amid') comparisons exist for (3m8r).
 */
const NO_SERIAL_TWO_ASSET_IDS = rtmPayload(
  rtmReport({ AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ AMID: 'fridge-a', AID: 'asset-8' }),
);

/** The ordinary shape: one appliance named the same way in both reports. */
const ONE_APPLIANCE_TWICE = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
);

// ── harnesses ────────────────────────────────────────────────────────────────

/** Deps with every lookup stubbed empty: this check asks for none of them. */
function deps(): SemanticDeps {
  return {
    concurrentAtEntry: 1,
    findPriorTransmissions: async () => [],
    findPriorUnitWindows: async () => [],
    findPriorUnitIdentities: async () => [],
  };
}

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'identifier-disagreement-session',
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
    semanticStage(deps()),
  ];
}

/** Drive the check alone against one body. */
async function checkOnly(payload: Record<string, unknown>): Promise<Finding[]> {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  // The check reads neither, and setting them keeps the context honest anyway.
  ctx.meta = { transferType: 'rtm', transferId: 'T-disagreement' };
  return identifierDisagreementCheck(ctx, deps());
}

/**
 * The fail findings of a run under the CONTRACT profile only — the schema stage
 * grades every transmission twice since by1c.6, so a "zero fails" claim about this
 * advisory has to say which profile it speaks for.
 */
function contractFails(ctx: PipelineContext, findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'fail' && f.profile !== ctx.shadowProfile);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === IDENTIFIER_DISAGREEMENT_ID);
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

// ── acceptance: the fixtures are conformant traffic ──────────────────────────

test('the fixtures really are schema-conformant on both registered contract versions', () => {
  // The advisory observes a relationship BETWEEN two reports of one body, and the
  // body itself is ordinary conformant traffic — which is what makes this an
  // advisory rather than a §3.2 finding. If a future contract version rejected one
  // of these bodies, the copy pinned below would be unreachable on the wire while
  // its test kept passing (b8dm).
  const fixtures = [
    { label: 'ONE_SERIAL_TWO_HANDLES', payload: ONE_SERIAL_TWO_HANDLES },
    { label: 'ONE_APPLIANCE_TWICE', payload: ONE_APPLIANCE_TWICE },
    { label: 'NO_SERIAL_TWO_ASSET_IDS', payload: NO_SERIAL_TWO_ASSET_IDS },
  ];
  for (const version of ['0.8.0', '0.8.1']) {
    const entry = registry.get(version);
    assert.ok(entry, `${version} is registered`);
    for (const { label, payload } of fixtures) {
      assert.equal(
        entry.validate(payload),
        true,
        `${version}/${label}: ${JSON.stringify(entry.validate.errors)}`,
      );
    }
  }
});

test('the extractor keeps its first-wins contract, which is why this check reads the reports', () => {
  // The premise of the whole module (7yuv): `computeUnitIdentities` keeps ONE
  // identity per unit key, so the second report of this body — the half that
  // disagrees — never reaches the cross-delivery lookup. That contract is
  // deliberately unchanged, and this pins the reason the check does its own read.
  assert.deepEqual(computeUnitIdentities(ONE_SERIAL_TWO_HANDLES), [
    { unitKey: 'aser:S-1', aser: 'S-1', amid: 'fridge-a', aid: null },
  ]);
});

test('it fires through the real §6 body stages on a 200 with zero contract fails', async () => {
  const ctx = makeCtx(ONE_SERIAL_TWO_HANDLES);
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 200);
  assert.equal(
    contractFails(ctx, result.findings).length,
    0,
    `expected no contract-profile fail findings, got ${JSON.stringify(contractFails(ctx, result.findings))}`,
  );

  const raised = advisories(result.findings);
  assert.equal(raised.length, 1, 'one finding per pair of disagreeing reports');
  assert.equal(raised[0]?.severity, 'info');
  assert.equal(raised[0]?.code, IDENTIFIER_DISAGREEMENT_ID);
  assert.ok(!raised[0]?.outdated);
  assert.equal(raised[0]?.pointer, '/data/0', 'points at the earlier of the two reports named');
  assert.ok(isAdvisoryId(raised[0]?.requirement));
});

test('the advisory moves no §7 requirement', async () => {
  const ctx = makeCtx(ONE_SERIAL_TWO_HANDLES);
  const result = await runPipeline(ctx, bodyStages());

  const withAdvisory = computeComplianceSummary(countsOf(result.findings));
  const withoutAdvisory = computeComplianceSummary(
    countsOf(result.findings.filter((f) => !isAdvisoryId(f.requirement))),
  );
  assert.deepEqual(withAdvisory, withoutAdvisory, 'the §7 summary is identical either way');
});

// ── the observation, pinned ─────────────────────────────────────────────────

test('one serial under two platform handles raises the approved copy verbatim', async () => {
  const [finding, ...rest] = await checkOnly(ONE_SERIAL_TWO_HANDLES);
  assert.equal(rest.length, 0, 'one advisory per pair of reports');
  assert.ok(finding);

  // The identifiers are the OBSERVATION (synm): they describe this delivery, so
  // they move with the finding rather than with the advisory id.
  assert.equal(
    finding.summary,
    'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
  );
  // The rationale is static per advisory id, so the finding carries the catalogue
  // text and nothing of this payload.
  assert.equal(finding.detail, IDENTIFIER_DISAGREEMENT_RATIONALE);
  assert.equal(
    finding.detail,
    'A receiving country matches each report to an appliance in its inventory using ' +
      'the identifiers the report carries, such as the serial number and the appliance ' +
      'id. In this transmission, two reports carry the same value for one of those ' +
      'identifiers but different values for another. For example, both reports give the ' +
      'same serial number, yet each gives a different appliance id. Both reports left ' +
      "the supplier's system in a single transmission, so that system held both " +
      'versions when it sent them. The receiving side cannot tell what lies behind ' +
      'this. The reports may describe one appliance whose identifier changed during the ' +
      'period they cover, or two appliances that share an identifier. Until the ' +
      'supplier clarifies, the country cannot tell whether to file these records under ' +
      'one appliance or two. Review how these identifiers are assigned, and check that ' +
      'every report for one appliance carries one consistent set.',
  );
});

test('the summary keeps to the roughly-90-character guidance at ordinary values', async () => {
  // This id cites NO prior delivery — both reports are in the body the supplier is
  // already looking at — so the figure on `AdvisoryInput` applies in full and the
  // id stays off `ADVISORY_IDS_CITING_A_PRIOR` (yjni). Three values on the line
  // rather than four is what pays for it: the shared identifier and the two
  // companions, with no receipt time to carry.
  //
  // The figure is 90 and reads "roughly", which is what admits the 91 characters
  // these values produce. The slack is TWO characters and no more, so a rewording
  // that starts carrying a fourth value fails here rather than drifting into the
  // cross-transmission shape the exception was written for.
  const [finding] = await checkOnly(ONE_SERIAL_TWO_HANDLES);
  const length = finding?.summary?.length ?? 0;
  assert.ok(length <= 92, `summary is ${length} characters: ${finding?.summary}`);
  assert.ok(
    !(ADVISORY_IDS_CITING_A_PRIOR as readonly string[]).includes(IDENTIFIER_DISAGREEMENT_ID),
    'the observation names no prior delivery, so the exception does not apply to it',
  );
});

test('the rationale names no identifier and no report index', async () => {
  // Static per id means it has to read correctly on a row that has no payload in
  // front of it: an interpolated serial would be a claim about whichever
  // transmission happened to arrive last.
  const [finding] = await checkOnly(ONE_SERIAL_TWO_HANDLES);
  assert.doesNotMatch(finding?.detail ?? '', /S-1|fridge-[ab]|AMID|ASER|AID/, 'no identity');
  assert.doesNotMatch(finding?.detail ?? '', /\/data\//, 'no pointer');
});

test('the copy observes and never concludes', async () => {
  const [finding] = await checkOnly(ONE_SERIAL_TWO_HANDLES);
  for (const [label, copy] of [
    ['summary', finding?.summary ?? ''],
    ['detail', finding?.detail ?? ''],
  ] as const) {
    // The bar is applied through its one helper (agj.28), so the exempt phrases
    // come out of the copy first the way a live run removes them; the finder hands
    // back the offending word so the message can still name it.
    const banned = findAdvisoryCopyViolation(copy);
    assert.equal(banned, null, `${label} uses the verdict word "${banned}"`);
  }
  const copy = `${finding?.summary} ${finding?.detail}`;
  assert.ok(
    !/disagree|collision|collide/i.test(copy),
    'the prose quotes the values; "disagreement" is the id’s word, not the copy’s',
  );
  assert.ok(
    !/two appliances (exist|are)|different appliances/i.test(copy),
    'the observation never claims two appliances exist',
  );
  assert.ok(!/duplicat/i.test(copy), 'the copy never says "duplicate" — §1.8 owns that word');
});

// ── the comparison rule ─────────────────────────────────────────────────────

test('a shared platform handle under two serials fires in the reverse direction', async () => {
  // Neither report keys on the handle — `unitKey` prefers the serial — so this is
  // the disagreement no unit-keyed reading would find.
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
    rtmReport({ ASER: 'S-2', AMID: 'fridge-a' }),
  );
  const [finding, ...rest] = await checkOnly(body);
  assert.equal(rest.length, 0);
  assert.equal(
    finding?.summary,
    'Two reports carry appliance id AMID fridge-a beside appliance serial ASER S-1 and S-2.',
  );
});

test('a shared asset id under two serials fires, and names the asset id', async () => {
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1', AID: 'asset-7' }),
    rtmReport({ ASER: 'S-2', AID: 'asset-7' }),
  );
  const [finding] = await checkOnly(body);
  assert.equal(
    finding?.summary,
    'Two reports carry asset id AID asset-7 beside appliance serial ASER S-1 and S-2.',
  );
});

test('a shared serial under two asset ids fires, and names the asset id', async () => {
  // The ('aser','aid') direction (3m8r). Both reports name the same platform
  // handle, so ('aser','amid') finds nothing to disagree about and the comparison
  // that does hold is the one on the employer's asset id.
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-8' }),
  );
  const [finding, ...rest] = await checkOnly(body);
  assert.equal(rest.length, 0);
  assert.equal(
    finding?.summary,
    'Two reports carry appliance serial ASER S-1 beside asset id AID asset-7 and asset-8.',
  );
});

test('a shared platform handle under two asset ids fires when no serial is present', async () => {
  // The ('amid','aid') direction (3m8r), and the only shape available when the
  // supplier sends no serial at all: `ASER` is optional on `rtmd-report` while
  // `AMID` is required, so this is ordinary conformant traffic rather than a
  // degenerate fixture. No comparison anchored on the serial can hold here.
  const [finding, ...rest] = await checkOnly(NO_SERIAL_TWO_ASSET_IDS);
  assert.equal(rest.length, 0);
  assert.equal(
    finding?.summary,
    'Two reports carry appliance id AMID fridge-a beside asset id AID asset-7 and asset-8.',
  );
});

test('a shared asset id under two platform handles fires when no serial is present', async () => {
  // The ('aid','amid') direction (3m8r) — the reverse of the one above, and the
  // last of the six. AID is the COMPANION in neither of the two before it, so
  // without this pair a typo in either row would be silent.
  const body = rtmPayload(
    rtmReport({ AMID: 'fridge-a', AID: 'asset-7' }),
    rtmReport({ AMID: 'fridge-b', AID: 'asset-7' }),
  );
  const [finding, ...rest] = await checkOnly(body);
  assert.equal(rest.length, 0);
  assert.equal(
    finding?.summary,
    'Two reports carry asset id AID asset-7 beside appliance id AMID fridge-a and fridge-b.',
  );
});

test('when two comparisons hold on one pair, the earlier entry of the table names it', async () => {
  // COMPARISONS order is the reporting priority the module's header pins as a
  // decision, so it is pinned here through what the copy says rather than by
  // reading the table. Each body below satisfies two comparisons at once; the
  // summary names the earlier one. The three boundaries a pair of reports can
  // actually reach are all here — the other two are unreachable, because they
  // would need one pair to share an identifier and disagree on it at the same
  // time.
  const boundaries = [
    {
      label: "('aser','amid') ahead of ('aser','aid')",
      body: rtmPayload(
        rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
        rtmReport({ ASER: 'S-1', AMID: 'fridge-b', AID: 'asset-8' }),
      ),
      summary:
        'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
    },
    {
      label: "('amid','aser') ahead of ('amid','aid')",
      body: rtmPayload(
        rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
        rtmReport({ ASER: 'S-2', AMID: 'fridge-a', AID: 'asset-8' }),
      ),
      summary:
        'Two reports carry appliance id AMID fridge-a beside appliance serial ASER S-1 and S-2.',
    },
    {
      label: "('aid','aser') ahead of ('aid','amid')",
      body: rtmPayload(
        rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
        rtmReport({ ASER: 'S-2', AMID: 'fridge-b', AID: 'asset-7' }),
      ),
      summary: 'Two reports carry asset id AID asset-7 beside appliance serial ASER S-1 and S-2.',
    },
  ];
  for (const { label, body, summary } of boundaries) {
    const findings = await checkOnly(body);
    assert.equal(findings.length, 1, `${label}: one finding per pair of reports`);
    assert.equal(findings[0]?.summary, summary, label);
  }
});

test('a companion absent on either report is not compared', async () => {
  // The second report names no handle, so the two reports disagree about nothing:
  // absence is neither agreement nor disagreement.
  const body = rtmPayload(rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }), rtmReport({ ASER: 'S-1' }));
  assert.deepEqual(await checkOnly(body), []);
});

test('two reports naming one appliance the same way raise nothing', async () => {
  assert.deepEqual(await checkOnly(ONE_APPLIANCE_TWICE), []);
});

test('two reports sharing no identifier at all raise nothing', async () => {
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
    rtmReport({ ASER: 'S-2', AMID: 'fridge-b' }),
  );
  assert.deepEqual(await checkOnly(body), []);
});

test('a single-report body raises nothing, however it is identified', async () => {
  assert.deepEqual(await checkOnly(rtmPayload(rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }))), []);
});

test('a blank identifier joins no group', async () => {
  // `identifier` trims and yields null for a blank, so two reports whose serials
  // are whitespace are not two reports sharing a serial.
  const body = rtmPayload(
    rtmReport({ ASER: '  ', AMID: 'fridge-a' }),
    rtmReport({ ASER: '', AMID: 'fridge-b' }),
  );
  assert.deepEqual(await checkOnly(body), []);
});

test('values are trimmed but never case-folded', async () => {
  const trimmed = rtmPayload(
    rtmReport({ ASER: ' S-1 ', AMID: 'fridge-a' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
  );
  const [finding] = await checkOnly(trimmed);
  assert.equal(
    finding?.summary,
    'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
    'surrounding whitespace is not part of a serial',
  );

  const cased = rtmPayload(
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
    rtmReport({ ASER: 's-1', AMID: 'fridge-b' }),
  );
  assert.deepEqual(await checkOnly(cased), [], '"S-1" and "s-1" are different serials');
});

test('the logger and monitoring-device identifiers are never compared', async () => {
  // LSER/ESER/LID/EID: one appliance re-instrumented, or one logger moved, is
  // ordinary operation — see unitKey's docblock.
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a', ESER: 'EMD-one' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a', ESER: 'EMD-two' }),
  );
  assert.deepEqual(
    await checkOnly(body),
    [],
    'a changed EMD serial beside identical appliance identifiers is silent',
  );
});

// ── one advisory per pair of reports ────────────────────────────────────────

test('reports disagreeing under two comparisons are reported once, under the serial', async () => {
  // Both reports carry the same ASER and the same AID and differ on AMID, so
  // (ASER, AMID) and (AID, AMID) both hold. The pair is named once, and the
  // appliance's own serial leads because COMPARISONS order is reporting priority.
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-b', AID: 'asset-7' }),
  );
  const findings = await checkOnly(body);
  assert.equal(findings.length, 1, 'one finding per pair of reports, not one per comparison');
  assert.equal(
    findings[0]?.summary,
    'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
  );
});

test('two separate disagreements in one body raise one finding each', async () => {
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
    rtmReport({ ASER: 'S-2', AMID: 'fridge-c' }),
    rtmReport({ ASER: 'S-2', AMID: 'fridge-d' }),
  );
  const findings = await checkOnly(body);
  assert.deepEqual(
    findings.map((f) => f.summary),
    [
      'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
      'Two reports carry appliance serial ASER S-2 beside appliance id AMID fridge-c and fridge-d.',
    ],
  );
  assert.deepEqual(
    findings.map((f) => f.pointer),
    ['/data/0', '/data/2'],
  );
});

test('a third disagreeing report is not named — the advisory is not a census', async () => {
  // The first report carrying a companion anchors the observation and the first
  // later one that differs is named; a supplier holding that pair has what it
  // needs to go and look at the whole body.
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-c' }),
  );
  const findings = await checkOnly(body);
  assert.equal(findings.length, 1);
  assert.equal(
    findings[0]?.summary,
    'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
  );
});

test('the anchor is the first report that carries the companion at all', async () => {
  // The first report names no handle, so it anchors nothing; the observation is
  // about the two reports that do, and the pointer follows the anchor.
  const body = rtmPayload(
    rtmReport({ ASER: 'S-1' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
    rtmReport({ ASER: 'S-1', AMID: 'fridge-c' }),
  );
  const [finding] = await checkOnly(body);
  assert.equal(
    finding?.summary,
    'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-b and fridge-c.',
  );
  assert.equal(finding?.pointer, '/data/1');
});

test('an entry of data[] that is not an object is not a report', async () => {
  const body = rtmPayload(rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }));
  (body.data as unknown[]).push('not a report');
  assert.deepEqual(await checkOnly(body), []);
});
