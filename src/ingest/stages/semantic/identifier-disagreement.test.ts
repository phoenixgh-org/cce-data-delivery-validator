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
import { readFileSync } from 'node:fs';

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

/** One platform handle under two serials — the reverse of ONE_SERIAL_TWO_HANDLES. */
const ONE_HANDLE_TWO_SERIALS = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-a' }),
);

/**
 * One serial under two asset ids. Both reports name the same handle, so the only
 * comparison left to hold is ('aser','aid').
 */
const ONE_SERIAL_TWO_ASSET_IDS = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-8' }),
);

/** One asset id under two handles, with neither report naming a serial. */
const ONE_ASSET_ID_TWO_HANDLES = rtmPayload(
  rtmReport({ AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ AMID: 'fridge-b', AID: 'asset-7' }),
);

// The three boundaries one PAIR of reports can reach: each body satisfies two
// comparisons at once, so COMPARISONS order alone decides which one is named.

/** ('aser','amid') and ('aser','aid') both hold on the pair. */
const ONE_SERIAL_TWO_HANDLES_TWO_ASSET_IDS = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-b', AID: 'asset-8' }),
);

/** ('amid','aser') and ('amid','aid') both hold on the pair. */
const ONE_HANDLE_TWO_SERIALS_TWO_ASSET_IDS = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-a', AID: 'asset-8' }),
);

/**
 * ('aid','aser') and ('aid','amid') both hold on the pair. The two handles have
 * to DIFFER for the asset id to lead: with one shared handle ('amid','aser')
 * would outrank ('aid','aser') and name the handle instead. That also makes this
 * the plain shared-asset-id fixture, so the two tests share one body.
 */
const ONE_ASSET_ID_TWO_SERIALS_TWO_HANDLES = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-b', AID: 'asset-7' }),
);

// The remaining two boundaries, which need THREE reports: the two comparisons
// hold on DIFFERENT pairs, so no single pair has to share an identifier and
// disagree on it at once (bmuc). Each body raises two findings, and the order of
// the two is what COMPARISONS decides.

/** ('aser','aid') on reports 0 and 1, ahead of ('amid','aser') on reports 0 and 2. */
const TWO_PAIRS_UNDER_SERIAL_AND_HANDLE = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-8' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-a', AID: 'asset-7' }),
);

/** ('amid','aid') on reports 0 and 1, ahead of ('aid','aser') on reports 0 and 2. */
const TWO_PAIRS_UNDER_HANDLE_AND_ASSET_ID = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ AMID: 'fridge-a', AID: 'asset-8' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-b', AID: 'asset-7' }),
);

// Bodies the advisory stays silent on, and the two that pin how a value is read.

/** The asset id is carried by one report only, so nothing is compared under it. */
const ASSET_ID_ON_ONE_REPORT_ONLY = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
);

/** Two appliances sharing no identifier at all. */
const TWO_APPLIANCES_NOTHING_SHARED = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-b' }),
);

/** A single report, which has nothing to disagree with. */
const ONE_REPORT_ONLY = rtmPayload(rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }));

/** Two serials that are whitespace, which `identifier` reads as absent. */
const BLANK_SERIALS = rtmPayload(
  rtmReport({ ASER: '  ', AMID: 'fridge-a' }),
  rtmReport({ ASER: '', AMID: 'fridge-b' }),
);

/** One serial written with surrounding space on one report and without on the other. */
const SERIAL_WITH_SURROUNDING_SPACE = rtmPayload(
  rtmReport({ ASER: ' S-1 ', AMID: 'fridge-a' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
);

/** Two serials differing only in case, which are two serials. */
const SERIALS_DIFFERING_ONLY_IN_CASE = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
  rtmReport({ ASER: 's-1', AMID: 'fridge-b' }),
);

/** One appliance whose monitoring-device serial changed between the two reports. */
const ONE_APPLIANCE_TWO_MONITORING_DEVICES = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', ESER: 'EMD-one' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', ESER: 'EMD-two' }),
);

// Bodies with more than one disagreeing pair, or more than two reports in one.

/** One pair disagreeing under ('aser','amid') and ('aid','amid') at once. */
const ONE_SERIAL_ONE_ASSET_ID_TWO_HANDLES = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-b', AID: 'asset-7' }),
);

/** Two separate disagreements, one per serial. */
const TWO_SERIALS_EACH_UNDER_TWO_HANDLES = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-c' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-d' }),
);

/** Three reports under one serial, the third disagreeing with the first two. */
const ONE_SERIAL_THREE_HANDLES = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
  rtmReport({ ASER: 'S-1', AMID: 'fridge-c' }),
);

/**
 * Three reports under one handle, the first of them carrying no asset id. The
 * companion has to be an OPTIONAL identifier for this shape to be conformant
 * traffic: `AMID` is required on `rtmd-report`, so a report that names no handle
 * never reaches the check at all (mlr4).
 */
const ASSET_ID_ABSENT_ON_THE_FIRST_OF_THREE = rtmPayload(
  rtmReport({ AMID: 'fridge-a' }),
  rtmReport({ AMID: 'fridge-a', AID: 'asset-7' }),
  rtmReport({ AMID: 'fridge-a', AID: 'asset-8' }),
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
  //
  // THE LIST IS EXHAUSTIVE, which is why every body in this file is a named
  // fixture rather than an inline literal (mlr4): an unlisted body is one this
  // gate does not cover, and two of them were rejected by both registered
  // versions for months while their tests kept passing. The one deliberate
  // omission is the malformed-entry body of the last test, which pushes a string
  // into `data[]` and so cannot be conformant by design — it pins what the check
  // does with an entry no contract version accepts.
  const fixtures = [
    { label: 'ONE_SERIAL_TWO_HANDLES', payload: ONE_SERIAL_TWO_HANDLES },
    { label: 'NO_SERIAL_TWO_ASSET_IDS', payload: NO_SERIAL_TWO_ASSET_IDS },
    { label: 'ONE_APPLIANCE_TWICE', payload: ONE_APPLIANCE_TWICE },
    { label: 'ONE_HANDLE_TWO_SERIALS', payload: ONE_HANDLE_TWO_SERIALS },
    { label: 'ONE_SERIAL_TWO_ASSET_IDS', payload: ONE_SERIAL_TWO_ASSET_IDS },
    { label: 'ONE_ASSET_ID_TWO_HANDLES', payload: ONE_ASSET_ID_TWO_HANDLES },
    {
      label: 'ONE_SERIAL_TWO_HANDLES_TWO_ASSET_IDS',
      payload: ONE_SERIAL_TWO_HANDLES_TWO_ASSET_IDS,
    },
    {
      label: 'ONE_HANDLE_TWO_SERIALS_TWO_ASSET_IDS',
      payload: ONE_HANDLE_TWO_SERIALS_TWO_ASSET_IDS,
    },
    {
      label: 'ONE_ASSET_ID_TWO_SERIALS_TWO_HANDLES',
      payload: ONE_ASSET_ID_TWO_SERIALS_TWO_HANDLES,
    },
    { label: 'TWO_PAIRS_UNDER_SERIAL_AND_HANDLE', payload: TWO_PAIRS_UNDER_SERIAL_AND_HANDLE },
    {
      label: 'TWO_PAIRS_UNDER_HANDLE_AND_ASSET_ID',
      payload: TWO_PAIRS_UNDER_HANDLE_AND_ASSET_ID,
    },
    { label: 'ASSET_ID_ON_ONE_REPORT_ONLY', payload: ASSET_ID_ON_ONE_REPORT_ONLY },
    { label: 'TWO_APPLIANCES_NOTHING_SHARED', payload: TWO_APPLIANCES_NOTHING_SHARED },
    { label: 'ONE_REPORT_ONLY', payload: ONE_REPORT_ONLY },
    { label: 'BLANK_SERIALS', payload: BLANK_SERIALS },
    { label: 'SERIAL_WITH_SURROUNDING_SPACE', payload: SERIAL_WITH_SURROUNDING_SPACE },
    { label: 'SERIALS_DIFFERING_ONLY_IN_CASE', payload: SERIALS_DIFFERING_ONLY_IN_CASE },
    {
      label: 'ONE_APPLIANCE_TWO_MONITORING_DEVICES',
      payload: ONE_APPLIANCE_TWO_MONITORING_DEVICES,
    },
    { label: 'ONE_SERIAL_ONE_ASSET_ID_TWO_HANDLES', payload: ONE_SERIAL_ONE_ASSET_ID_TWO_HANDLES },
    { label: 'TWO_SERIALS_EACH_UNDER_TWO_HANDLES', payload: TWO_SERIALS_EACH_UNDER_TWO_HANDLES },
    { label: 'ONE_SERIAL_THREE_HANDLES', payload: ONE_SERIAL_THREE_HANDLES },
    {
      label: 'ASSET_ID_ABSENT_ON_THE_FIRST_OF_THREE',
      payload: ASSET_ID_ABSENT_ON_THE_FIRST_OF_THREE,
    },
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

  // What keeps the exhaustiveness claim above true rather than merely true today
  // (qmdh): this file reads its own source and holds the list to it. A fixture
  // added without its label, or a body built inline inside a test, fails here
  // instead of going unvalidated for months, which is the failure mlr4 was filed
  // for. The precedent is TransmissionsCard.test.ts, which reads its component's
  // source the same way, and Setup.test.ts, which reads the README's.
  //
  // Every pattern below writes the builder's opening parenthesis ESCAPED, so none
  // of them counts its own source text: the unescaped token occurs only at a real
  // declaration or call site.
  const source = readFileSync(
    new URL('./identifier-disagreement.test.ts', import.meta.url),
    'utf8',
  );

  const declared = [...source.matchAll(/^const ([A-Z][A-Z0-9_]*) = rtmPayload\(/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    [...declared].sort(),
    fixtures.map((f) => f.label).sort(),
    'the named payload fixtures and the list above have diverged — add the new fixture to' +
      ' `fixtures`, or make its label match the name of the const it points at',
  );

  const builders = (source.match(/^function rtmPayload\(/gm) ?? []).length;
  assert.equal(builders, 1, `expected 1 payload builder in this file, found ${builders}`);
  const calls = (source.match(/rtmPayload\(/g) ?? []).length - builders;
  assert.equal(
    calls,
    declared.length + 1,
    `expected ${declared.length} named fixtures plus the 1 exemption below, found ${calls}` +
      ' payload builder calls — a body is being built outside the list, most likely inline in a' +
      ' test; give it a name at module scope and add it to `fixtures` above',
  );

  // The one exemption, pinned to the test it belongs to so that the arithmetic
  // cannot be satisfied by an inline body elsewhere while the exemption quietly
  // disappears. The title occurs twice: once in the line below, once on the test.
  const exemptTitle = "test('an entry of data[] that is not an object is not a report'";
  const titles = source.split(exemptTitle).length - 1;
  assert.equal(
    titles,
    2,
    `expected the exempt test's title twice — here and on the test itself — found ${titles};` +
      ' the malformed-entry test was renamed or removed, so this exemption names nothing',
  );
  const exemptCalls = (source.slice(source.lastIndexOf(exemptTitle)).match(/rtmPayload\(/g) ?? [])
    .length;
  assert.equal(
    exemptCalls,
    1,
    `expected the malformed-entry test to build exactly 1 body, found ${exemptCalls} — if it` +
      ' needs another, that one is conformant traffic and belongs in the list above',
  );
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
  const [finding, ...rest] = await checkOnly(ONE_HANDLE_TWO_SERIALS);
  assert.equal(rest.length, 0);
  assert.equal(
    finding?.summary,
    'Two reports carry appliance id AMID fridge-a beside appliance serial ASER S-1 and S-2.',
  );
});

test('a shared asset id under two serials fires, and names the asset id', async () => {
  // Each report also names its own handle, because `AMID` is required on
  // `rtmd-report` and a body without it is traffic the service never accepts
  // (mlr4). The two handles differ, so the asset id still leads.
  const [finding] = await checkOnly(ONE_ASSET_ID_TWO_SERIALS_TWO_HANDLES);
  assert.equal(
    finding?.summary,
    'Two reports carry asset id AID asset-7 beside appliance serial ASER S-1 and S-2.',
  );
});

test('a shared serial under two asset ids fires, and names the asset id', async () => {
  // The ('aser','aid') direction (3m8r). Both reports name the same platform
  // handle, so ('aser','amid') finds nothing to disagree about and the comparison
  // that does hold is the one on the employer's asset id.
  const [finding, ...rest] = await checkOnly(ONE_SERIAL_TWO_ASSET_IDS);
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
  const [finding, ...rest] = await checkOnly(ONE_ASSET_ID_TWO_HANDLES);
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
  // summary names the earlier one. These are the three boundaries one PAIR of
  // reports can reach: the other two would need that pair to share an identifier
  // and disagree on it at the same time, which no pair can do. They are reachable
  // across three reports, where the two comparisons hold on different pairs, and
  // the test below pins them (bmuc).
  const boundaries = [
    {
      label: "('aser','amid') ahead of ('aser','aid')",
      body: ONE_SERIAL_TWO_HANDLES_TWO_ASSET_IDS,
      summary:
        'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
    },
    {
      label: "('amid','aser') ahead of ('amid','aid')",
      body: ONE_HANDLE_TWO_SERIALS_TWO_ASSET_IDS,
      summary:
        'Two reports carry appliance id AMID fridge-a beside appliance serial ASER S-1 and S-2.',
    },
    {
      label: "('aid','aser') ahead of ('aid','amid')",
      body: ONE_ASSET_ID_TWO_SERIALS_TWO_HANDLES,
      summary: 'Two reports carry asset id AID asset-7 beside appliance serial ASER S-1 and S-2.',
    },
  ];
  for (const { label, body, summary } of boundaries) {
    const findings = await checkOnly(body);
    assert.equal(findings.length, 1, `${label}: one finding per pair of reports`);
    assert.equal(findings[0]?.summary, summary, label);
  }
});

test('the last two boundaries take three reports, and the two summaries come out in table order', async () => {
  // The same pinned decision, one step wider (bmuc). A boundary that no PAIR can
  // reach is still reachable across three reports, because the two comparisons
  // then hold on different pairs — and the check walks a whole body in
  // COMPARISONS order, so the table decides which finding is emitted first.
  // Pinning the ARRAY rather than one summary is what makes a reordering of
  // either row fail here instead of passing silently.
  const boundaries = [
    {
      label: "('aser','aid') ahead of ('amid','aser')",
      body: TWO_PAIRS_UNDER_SERIAL_AND_HANDLE,
      summaries: [
        'Two reports carry appliance serial ASER S-1 beside asset id AID asset-7 and asset-8.',
        'Two reports carry appliance id AMID fridge-a beside appliance serial ASER S-1 and S-2.',
      ],
    },
    {
      label: "('amid','aid') ahead of ('aid','aser')",
      body: TWO_PAIRS_UNDER_HANDLE_AND_ASSET_ID,
      summaries: [
        'Two reports carry appliance id AMID fridge-a beside asset id AID asset-7 and asset-8.',
        'Two reports carry asset id AID asset-7 beside appliance serial ASER S-1 and S-2.',
      ],
    },
  ];
  for (const { label, body, summaries } of boundaries) {
    const findings = await checkOnly(body);
    assert.deepEqual(
      findings.map((f) => f.summary),
      summaries,
      label,
    );
  }
});

test('a companion absent on either report is not compared', async () => {
  // The second report names no asset id, so the two reports disagree about
  // nothing: absence is neither agreement nor disagreement. The absent companion
  // is the asset id rather than the handle because `AMID` is required on
  // `rtmd-report`, so a handle-less report is not traffic the service accepts
  // and the silence would be pinned on a body the check never sees (mlr4).
  assert.deepEqual(await checkOnly(ASSET_ID_ON_ONE_REPORT_ONLY), []);
});

test('two reports naming one appliance the same way raise nothing', async () => {
  assert.deepEqual(await checkOnly(ONE_APPLIANCE_TWICE), []);
});

test('two reports sharing no identifier at all raise nothing', async () => {
  assert.deepEqual(await checkOnly(TWO_APPLIANCES_NOTHING_SHARED), []);
});

test('a single-report body raises nothing, however it is identified', async () => {
  assert.deepEqual(await checkOnly(ONE_REPORT_ONLY), []);
});

test('a blank identifier joins no group', async () => {
  // `identifier` trims and yields null for a blank, so two reports whose serials
  // are whitespace are not two reports sharing a serial.
  assert.deepEqual(await checkOnly(BLANK_SERIALS), []);
});

test('values are trimmed but never case-folded', async () => {
  const [finding] = await checkOnly(SERIAL_WITH_SURROUNDING_SPACE);
  assert.equal(
    finding?.summary,
    'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
    'surrounding whitespace is not part of a serial',
  );

  assert.deepEqual(
    await checkOnly(SERIALS_DIFFERING_ONLY_IN_CASE),
    [],
    '"S-1" and "s-1" are different serials',
  );
});

test('the logger and monitoring-device identifiers are never compared', async () => {
  // LSER/ESER/LID/EID: one appliance re-instrumented, or one logger moved, is
  // ordinary operation — see unitKey's docblock.
  assert.deepEqual(
    await checkOnly(ONE_APPLIANCE_TWO_MONITORING_DEVICES),
    [],
    'a changed EMD serial beside identical appliance identifiers is silent',
  );
});

// ── one advisory per pair of reports ────────────────────────────────────────

test('reports disagreeing under two comparisons are reported once, under the serial', async () => {
  // Both reports carry the same ASER and the same AID and differ on AMID, so
  // (ASER, AMID) and (AID, AMID) both hold. The pair is named once, and the
  // appliance's own serial leads because COMPARISONS order is reporting priority.
  const findings = await checkOnly(ONE_SERIAL_ONE_ASSET_ID_TWO_HANDLES);
  assert.equal(findings.length, 1, 'one finding per pair of reports, not one per comparison');
  assert.equal(
    findings[0]?.summary,
    'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
  );
});

test('two separate disagreements in one body raise one finding each', async () => {
  const findings = await checkOnly(TWO_SERIALS_EACH_UNDER_TWO_HANDLES);
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
  const findings = await checkOnly(ONE_SERIAL_THREE_HANDLES);
  assert.equal(findings.length, 1);
  assert.equal(
    findings[0]?.summary,
    'Two reports carry appliance serial ASER S-1 beside appliance id AMID fridge-a and fridge-b.',
  );
});

test('the anchor is the first report that carries the companion at all', async () => {
  // The first report names no asset id, so it anchors nothing; the observation is
  // about the two reports that do, and the pointer follows the anchor. The rule
  // is pinned on an OPTIONAL companion because a required one cannot be absent in
  // conformant traffic — `AMID` is required on `rtmd-report`, and the body checks
  // run on schema-valid bodies only (mlr4).
  const [finding] = await checkOnly(ASSET_ID_ABSENT_ON_THE_FIRST_OF_THREE);
  assert.equal(
    finding?.summary,
    'Two reports carry appliance id AMID fridge-a beside asset id AID asset-7 and asset-8.',
  );
  assert.equal(finding?.pointer, '/data/1');
});

test('an entry of data[] that is not an object is not a report', async () => {
  // The one body deliberately kept out of the conformance list above: a string in
  // `data[]` is rejected by every contract version, which is the point of the
  // test — the check has to be safe on an entry the schema stage already failed.
  const body = rtmPayload(rtmReport({ ASER: 'S-1', AMID: 'fridge-a' }));
  (body.data as unknown[]).push('not a report');
  assert.deepEqual(await checkOnly(body), []);
});
