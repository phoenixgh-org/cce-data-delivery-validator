/**
 * `adv.identifier_collision` — the advisory for an appliance-side identifier that
 * arrived in this session beside a different companion identifier than an earlier
 * accepted delivery carried it beside (0rfk).
 *
 * Acceptance, as for every advisory: it fires on a payload that is fully schema-
 * AND requirement-conformant, and moves NO requirement's pass/fail status. The
 * fixtures are validated by the real `SchemaRegistry` and the firing case runs
 * through the real §6 body stages for its 200 and its zero contract-profile fail
 * findings, the way abst-window-overlap.test.ts does.
 *
 * THE DEP IS STUBBED, exactly as it is for the other read-path advisory: the prior
 * identities a real run would fetch from `transmission_unit_identity` are handed in
 * directly, so the comparison rule, the copy and the exclusions the check ASKS FOR
 * are pinned here without a database. What the SQL does with those exclusions is
 * pinned against real Postgres in src/db/repository.test.ts.
 *
 * The copy assertions are acceptance, not polish: the approved sentences are pinned
 * verbatim, including the ISO-8601-to-the-second `received_at` and the "most recent
 * colliding prior" rule.
 */

import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeComplianceSummary } from '../../../api/compliance-matrix.js';
import type { PriorUnitIdentity } from '../../../db/repository.js';
import type { UnitIdentity } from '../../../identity/unit-key.js';
import { SchemaRegistry } from '../../../schema-registry.js';
import { runPipeline, type Finding, type PipelineContext, type Stage } from '../../pipeline.js';
import { contentTypeStage } from '../content-type.js';
import { encodingStage } from '../encoding.js';
import { parseStage } from '../parse.js';
import { schemaStage } from '../schema.js';
import { semanticStage, type SemanticDeps } from '../semantic.js';
import { sizeStage } from '../size.js';
import { findAdvisoryCopyViolation } from './advisory-finding.js';
import { isAdvisoryId } from './advisory.js';
import {
  IDENTIFIER_COLLISION_ID,
  IDENTIFIER_COLLISION_RATIONALE,
  identifierCollisionCheck,
} from './identifier-collision.js';

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
      transferId: 'T-collision-second',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: reports,
  };
}

/** The SECOND delivery: serial `S-1` reported this time under `fridge-b`. */
const SECOND_DELIVERY = rtmPayload(rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }));

/** Two appliances in one body — only the first has a colliding prior below. */
const TWO_APPLIANCES = rtmPayload(
  rtmReport({ ASER: 'S-1', AMID: 'fridge-b' }),
  rtmReport({ ASER: 'S-2', AMID: 'fridge-2' }),
);

/** A prior identity row as the repository returns one. */
function priorIdentity(over: Partial<PriorUnitIdentity> = {}): PriorUnitIdentity {
  return {
    transmission_id: '11111111-1111-4111-8111-111111111111',
    unit_key: 'aser:S-1',
    aser: 'S-1',
    amid: 'fridge-a',
    aid: null,
    received_at: new Date('2026-09-18T09:14:07.512Z'),
    transfer_id: 'T-collision-first',
    ...over,
  };
}

// ── harnesses ────────────────────────────────────────────────────────────────

/** What one call to the stubbed lookup was asked for. */
interface LookupCall {
  sessionUuid: string;
  identities: readonly UnitIdentity[];
  opts: { excludeContentHash?: Buffer | null; excludeTransferId?: string | null };
}

const calls: LookupCall[] = [];

/** Deps whose identity lookup returns `priors` and records what it was asked. */
function depsWith(priors: readonly PriorUnitIdentity[]): SemanticDeps {
  return {
    concurrentAtEntry: 1,
    findPriorTransmissions: async () => [],
    findPriorUnitWindows: async () => [],
    findPriorUnitIdentities: async (sessionUuid, identities, opts) => {
      calls.push({ sessionUuid, identities, opts });
      return [...priors];
    },
  };
}

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'identifier-collision-session',
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

function bodyStages(deps: SemanticDeps): Stage[] {
  return [
    sizeStage(),
    contentTypeStage(),
    encodingStage(),
    parseStage(),
    schemaStage(),
    semanticStage(deps),
  ];
}

/** Drive the check alone against a stubbed prior list. */
async function checkOnly(
  payload: Record<string, unknown>,
  priors: readonly PriorUnitIdentity[],
): Promise<Finding[]> {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  ctx.meta = {
    transferType: String((payload.meta as { transferType?: unknown }).transferType),
    transferId: String((payload.meta as { transferId?: unknown }).transferId),
  };
  return identifierCollisionCheck(ctx, depsWith(priors));
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
  return findings.filter((f) => f.requirement === IDENTIFIER_COLLISION_ID);
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
  // The advisory observes a relationship BETWEEN two deliveries; each body on its
  // own is ordinary conformant traffic, and that is what makes this an advisory
  // rather than a §3.2 finding. If a future contract version rejected one of these
  // bodies, the copy pinned below would be unreachable on the wire while its test
  // kept passing (b8dm).
  const fixtures = [
    { label: 'SECOND_DELIVERY', payload: SECOND_DELIVERY },
    { label: 'TWO_APPLIANCES', payload: TWO_APPLIANCES },
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

test('it fires through the real §6 body stages on a 200 with zero contract fails', async () => {
  const ctx = makeCtx(SECOND_DELIVERY);
  const result = await runPipeline(ctx, bodyStages(depsWith([priorIdentity()])));

  assert.equal(result.status, 200);
  assert.equal(
    contractFails(ctx, result.findings).length,
    0,
    `expected no contract-profile fail findings, got ${JSON.stringify(contractFails(ctx, result.findings))}`,
  );

  const raised = advisories(result.findings);
  assert.equal(raised.length, 1, 'one finding per colliding appliance');
  assert.equal(raised[0]?.severity, 'info');
  assert.equal(raised[0]?.code, IDENTIFIER_COLLISION_ID);
  assert.ok(!raised[0]?.outdated);
  assert.equal(raised[0]?.pointer, '/data/0', 'points at the report that named the appliance');
  assert.ok(isAdvisoryId(raised[0]?.requirement));
});

test('the advisory moves no §7 requirement', async () => {
  const ctx = makeCtx(SECOND_DELIVERY);
  const result = await runPipeline(ctx, bodyStages(depsWith([priorIdentity()])));

  const withAdvisory = computeComplianceSummary(countsOf(result.findings));
  const withoutAdvisory = computeComplianceSummary(
    countsOf(result.findings.filter((f) => !isAdvisoryId(f.requirement))),
  );
  assert.deepEqual(withAdvisory, withoutAdvisory, 'the §7 summary is identical either way');
});

// ── the observation, pinned ─────────────────────────────────────────────────

test('a colliding prior raises the approved copy verbatim', async () => {
  const [finding, ...rest] = await checkOnly(SECOND_DELIVERY, [priorIdentity()]);
  assert.equal(rest.length, 0, 'one advisory per unit');
  assert.ok(finding);

  // The identifiers and the receipt time are the OBSERVATION (synm): they describe
  // this delivery and the one it repeats a value from, so they move with the
  // finding rather than with the advisory id.
  assert.equal(
    finding.summary,
    'This report carries appliance serial ASER S-1 beside appliance id AMID fridge-b. ' +
      'A report received at 2026-09-18T09:14:07Z carried the same appliance serial ASER ' +
      'beside appliance id AMID fridge-a.',
  );
  // The rationale is static per advisory id, so the finding carries the catalogue
  // text and nothing of this payload.
  assert.equal(finding.detail, IDENTIFIER_COLLISION_RATIONALE);
  assert.equal(
    finding.detail,
    'An appliance identifier that arrives beside a different companion identifier than an ' +
      'earlier delivery carried leaves the receiving country holding two deliveries it cannot ' +
      'attribute to one appliance. From the receiving side an identifier that was corrected ' +
      'between deliveries and two appliances that share one identifier look the same, so this ' +
      'observation names neither: only the supplier can say which reading applies, and until ' +
      'it does the country cannot place either delivery against a single unit in its ' +
      'inventory. Exact retransmissions are excluded from this observation and are graded ' +
      'under §1.8.',
  );
});

test('the rationale names no identifier and no timestamp', async () => {
  // Static per id means it has to read correctly on a row that has no payload in
  // front of it: an interpolated serial or receipt time would be a claim about
  // whichever transmission happened to arrive last.
  const [finding] = await checkOnly(SECOND_DELIVERY, [priorIdentity()]);
  assert.doesNotMatch(finding?.detail ?? '', /\d{4}-\d{2}-\d{2}T/, 'no timestamp');
  assert.doesNotMatch(finding?.detail ?? '', /S-1|fridge-[ab]|AMID|ASER|AID/, 'no identity');
});

test('the receipt time renders ISO 8601 UTC to the second', async () => {
  const [finding] = await checkOnly(SECOND_DELIVERY, [priorIdentity()]);
  const stamps = (finding?.summary ?? '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) ?? [];
  assert.equal(stamps.length, 1, "only the prior's received_at is a timestamp here");
  assert.ok(!/\.\d{3}Z/.test(finding?.summary ?? ''), 'no milliseconds survive into the copy');
});

test('the copy observes and never concludes', async () => {
  const [finding] = await checkOnly(SECOND_DELIVERY, [priorIdentity()]);
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
    !/collision|collide/i.test(copy),
    'the prose quotes the values; "collision" is the id’s word, not the copy’s',
  );
  assert.ok(
    !/two appliances (exist|are)|different appliances/i.test(copy),
    'the observation never claims two appliances exist',
  );
  assert.ok(!/duplicat/i.test(copy), 'the copy never says "duplicate" — §1.8 owns that word');
});

// ── the comparison rule ─────────────────────────────────────────────────────

test('a shared AMID under a different serial fires in the reverse direction', async () => {
  // The prior keyed on its own serial, so the unit keys never match: the shared
  // value is the platform handle, and the companion that disagrees is the serial.
  const [finding, ...rest] = await checkOnly(SECOND_DELIVERY, [
    priorIdentity({ unit_key: 'aser:S-9', aser: 'S-9', amid: 'fridge-b' }),
  ]);
  assert.equal(rest.length, 0);
  assert.equal(
    finding?.summary,
    'This report carries appliance id AMID fridge-b beside appliance serial ASER S-1. ' +
      'A report received at 2026-09-18T09:14:07Z carried the same appliance id AMID ' +
      'beside appliance serial ASER S-9.',
  );
});

test('a shared AID under a different serial fires, and names the asset id', async () => {
  // The employer's asset id is the shared value here, so it leads the sentence and
  // the serial is the companion that disagrees.
  const body = rtmPayload(rtmReport({ ASER: 'S-1', AID: 'asset-7' }));
  const [finding] = await checkOnly(body, [
    priorIdentity({ unit_key: 'aser:S-9', aser: 'S-9', amid: null, aid: 'asset-7' }),
  ]);
  assert.equal(
    finding?.summary,
    'This report carries asset id AID asset-7 beside appliance serial ASER S-1. ' +
      'A report received at 2026-09-18T09:14:07Z carried the same asset id AID ' +
      'beside appliance serial ASER S-9.',
  );
});

test('a companion absent on either side is not compared', async () => {
  // This body names no AMID, so a prior under the same serial with a different one
  // says nothing: absence is neither agreement nor disagreement.
  const noCompanion = rtmPayload(rtmReport({ ASER: 'S-1' }));
  assert.deepEqual(await checkOnly(noCompanion, [priorIdentity()]), [], 'absent here');
  assert.deepEqual(
    await checkOnly(SECOND_DELIVERY, [priorIdentity({ amid: null })]),
    [],
    'absent on the prior',
  );
});

test('a prior that agrees on every companion it carries raises nothing', async () => {
  // The ordinary case: one appliance delivering twice under the same names.
  assert.deepEqual(await checkOnly(SECOND_DELIVERY, [priorIdentity({ amid: 'fridge-b' })]), []);
});

test('a prior sharing no value at all raises nothing', async () => {
  assert.deepEqual(
    await checkOnly(SECOND_DELIVERY, [
      priorIdentity({ unit_key: 'aser:S-9', aser: 'S-9', amid: 'fridge-9' }),
    ]),
    [],
  );
});

test('the logger and monitoring-device identifiers are never compared', async () => {
  // LSER/ESER/LID/EID: one appliance re-instrumented, or one logger moved, is
  // ordinary operation — see unitKey's docblock.
  const body = rtmPayload(rtmReport({ ASER: 'S-1', AMID: 'fridge-b', ESER: 'EMD-other' }));
  assert.deepEqual(
    await checkOnly(body, [priorIdentity({ amid: 'fridge-b' })]),
    [],
    'a changed EMD serial beside identical appliance identifiers is silent',
  );
});

test('one advisory per appliance, and only for the appliance with a colliding prior', async () => {
  const findings = await checkOnly(TWO_APPLIANCES, [priorIdentity()]);
  assert.equal(findings.length, 1, 'S-2 has no prior and draws nothing');
  assert.ok(findings[0]?.summary?.includes('ASER S-1'));
  assert.equal(findings[0]?.pointer, '/data/0');
});

test('several colliding priors raise ONE advisory naming the most recent', async () => {
  // The repository orders newest first; the check takes the first match rather
  // than one finding per pair, so the count never measures session age.
  const findings = await checkOnly(SECOND_DELIVERY, [
    priorIdentity({ received_at: new Date('2026-09-18T11:00:00Z'), amid: 'fridge-c' }),
    priorIdentity({ received_at: new Date('2026-09-18T09:14:07Z') }),
  ]);
  assert.equal(findings.length, 1, 'one advisory per unit, however many priors collide');
  assert.ok(
    findings[0]?.summary?.includes('received at 2026-09-18T11:00:00Z'),
    `expected the most recent prior, got: ${findings[0]?.summary}`,
  );
  assert.ok(findings[0]?.summary?.endsWith('appliance id AMID fridge-c.'));
});

test('a body naming no appliance never reaches the lookup', async () => {
  calls.length = 0;
  const anonymous = rtmPayload(rtmReport({ AMID: null, AID: 'asset-1' }));
  const findings = await checkOnly(anonymous, [priorIdentity()]);
  assert.deepEqual(findings, []);
  assert.equal(calls.length, 0, 'no unit key, no query');
});

// ── the exclusions this check asks for ──────────────────────────────────────

test('the lookup is asked for this session, these identities, and both exclusions', async () => {
  calls.length = 0;
  await checkOnly(TWO_APPLIANCES, [priorIdentity()]);

  assert.equal(calls.length, 1, 'one lookup per transmission, not one per report');
  const call = calls[0]!;
  assert.equal(call.sessionUuid, 'identifier-collision-session');
  assert.deepEqual(
    [...call.identities],
    [
      { unitKey: 'aser:S-1', aser: 'S-1', amid: 'fridge-b', aid: null },
      { unitKey: 'aser:S-2', aser: 'S-2', amid: 'fridge-2', aid: null },
    ],
    'the whole identity goes to the lookup, so it can match on any of the three arms',
  );

  // The exclusions are what keep §1.8's ground — an exact replay and a re-used
  // transferId — out of this observation entirely.
  assert.equal(call.opts.excludeTransferId, 'T-collision-second');
  const expected = createHash('sha256')
    .update(Buffer.from(JSON.stringify(TWO_APPLIANCES), 'utf8'))
    .digest();
  assert.ok(
    Buffer.isBuffer(call.opts.excludeContentHash) && call.opts.excludeContentHash.equals(expected),
    'the sha256 of the raw body is excluded, the way duplicate.ts derives it',
  );
});
