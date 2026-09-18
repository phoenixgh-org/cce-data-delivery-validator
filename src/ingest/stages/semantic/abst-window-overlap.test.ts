/**
 * `adv.abst_window_overlap` — the advisory for two transmissions in one session
 * whose `ABST` windows intersect for the same appliance while their bodies
 * differ (agj.24).
 *
 * Acceptance, as for every advisory: it fires on a payload that is fully schema-
 * AND requirement-conformant, and moves NO requirement's pass/fail status. The
 * fixtures are validated by the real `SchemaRegistry` and the firing case runs
 * through the real §6 body stages for its 200 and its zero contract-profile fail
 * findings, the way null-accumulator.test.ts does.
 *
 * THE DEP IS STUBBED, and that is the whole difference from every other advisory
 * test: this is the one check with a read path. The prior windows a real run
 * would fetch from `transmission_unit_window` are handed in directly, so the
 * intersection rule, the copy and the exclusions the check ASKS FOR are pinned
 * here without a database. What the SQL does with those exclusions is pinned
 * against real Postgres in src/db/repository.test.ts.
 *
 * The copy assertions are acceptance, not polish: the approved sentences
 * (2026-09-18) are pinned verbatim, including the ISO-8601-to-the-second
 * rendering of every timestamp and the "most recent overlapping prior" rule.
 */

import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeComplianceSummary } from '../../../api/compliance-matrix.js';
import type { PriorUnitWindow } from '../../../db/repository.js';
import { SchemaRegistry } from '../../../schema-registry.js';
import { runPipeline, type Finding, type PipelineContext, type Stage } from '../../pipeline.js';
import { contentTypeStage } from '../content-type.js';
import { encodingStage } from '../encoding.js';
import { parseStage } from '../parse.js';
import { schemaStage } from '../schema.js';
import { semanticStage, type SemanticDeps } from '../semantic.js';
import { sizeStage } from '../size.js';
import { ABST_WINDOW_OVERLAP_ID, abstWindowOverlapCheck } from './abst-window-overlap.js';
import { ADVISORY_COPY_BANNED_WORDS } from './advisory-finding.js';
import { isAdvisoryId } from './advisory.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

// ── fixtures ─────────────────────────────────────────────────────────────────

/** One RTMD record at the compact `ABST` instant given. */
function rtmRecord(abst: string): Record<string, unknown> {
  return { ABST: abst, ALRM: 'HEAT', BEMD: 14.3, EERR: 'none', TVC: 3.2 };
}

/** An RTMD report for `amid`, carrying the records stamped at `absts`. */
function rtmReport(amid: string, absts: readonly string[]): Record<string, unknown> {
  return {
    AMID: amid,
    CID: 'US',
    EDOP: '2021-06-01',
    EMFR: 'EMD_Name',
    EMOD: 'EMD-ModelNo',
    EPQS: 'E006/999',
    ESER: 'EMD-SerialNum',
    EMSV: 'v01.02.123',
    DLST: { TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' } },
    records: absts.map((abst) => rtmRecord(abst)),
  };
}

/** An RTMD transmission carrying the given reports. */
function rtmPayload(...reports: Record<string, unknown>[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-abst-window-second',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: reports,
  };
}

/**
 * The SECOND delivery for `appliance-1`: four readings covering 04:00 to 04:45
 * on 2020-01-15. The prior fixtures below decide whether that intersects.
 */
const SECOND_DELIVERY = rtmPayload(
  rtmReport('appliance-1', [
    '20200115T040000Z',
    '20200115T041500Z',
    '20200115T043000Z',
    '20200115T044500Z',
  ]),
);

/** The same delivery keyed on `ASER`, to pin the other half of the unit-key rule. */
const SECOND_DELIVERY_BY_SERIAL = rtmPayload({
  ...rtmReport('appliance-1', ['20200115T040000Z', '20200115T044500Z']),
  ASER: 'A-SerialNum',
});

/** Two appliances in one body — only the first has a prior below. */
const TWO_APPLIANCES = rtmPayload(
  rtmReport('appliance-1', ['20200115T040000Z', '20200115T044500Z']),
  rtmReport('appliance-2', ['20200115T040000Z', '20200115T044500Z']),
);

/** A prior window row as the repository returns one (timestamps as `Date`). */
function priorWindow(over: Partial<PriorUnitWindow> = {}): PriorUnitWindow {
  return {
    transmission_id: '11111111-1111-4111-8111-111111111111',
    unit_key: 'amid:appliance-1',
    abst_min: new Date('2020-01-15T03:30:00Z'),
    abst_max: new Date('2020-01-15T04:15:00Z'),
    received_at: new Date('2026-09-18T09:14:07.512Z'),
    transfer_id: 'T-abst-window-first',
    ...over,
  };
}

// ── harnesses ────────────────────────────────────────────────────────────────

/** What one call to the stubbed lookup was asked for. */
interface LookupCall {
  sessionUuid: string;
  unitKeys: readonly string[];
  opts: { excludeContentHash?: Buffer | null; excludeTransferId?: string | null };
}

const calls: LookupCall[] = [];

/** Deps whose window lookup returns `priors` and records what it was asked. */
function depsWith(priors: readonly PriorUnitWindow[]): SemanticDeps {
  return {
    concurrentAtEntry: 1,
    findPriorTransmissions: async () => [],
    findPriorUnitWindows: async (sessionUuid, unitKeys, opts) => {
      calls.push({ sessionUuid, unitKeys, opts });
      return [...priors];
    },
  };
}

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'abst-window-session',
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
  priors: readonly PriorUnitWindow[],
): Promise<Finding[]> {
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  ctx.meta = {
    transferType: String((payload.meta as { transferType?: unknown }).transferType),
    transferId: String((payload.meta as { transferId?: unknown }).transferId),
  };
  return abstWindowOverlapCheck(ctx, depsWith(priors));
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
  return findings.filter((f) => f.requirement === ABST_WINDOW_OVERLAP_ID);
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
  // The advisory observes a relationship BETWEEN two deliveries; each body on
  // its own is ordinary conformant traffic, and that is what makes this an
  // advisory rather than a §3.2 finding. If a future contract version rejected
  // one of these bodies, the copy pinned below would be unreachable on the wire
  // while its test kept passing (b8dm).
  const fixtures = [
    { label: 'SECOND_DELIVERY', payload: SECOND_DELIVERY },
    { label: 'SECOND_DELIVERY_BY_SERIAL', payload: SECOND_DELIVERY_BY_SERIAL },
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
  const result = await runPipeline(ctx, bodyStages(depsWith([priorWindow()])));

  assert.equal(result.status, 200);
  assert.equal(
    contractFails(ctx, result.findings).length,
    0,
    `expected no contract-profile fail findings, got ${JSON.stringify(contractFails(ctx, result.findings))}`,
  );

  const raised = advisories(result.findings);
  assert.equal(raised.length, 1, 'one finding per overlapping appliance');
  assert.equal(raised[0]?.severity, 'info');
  assert.equal(raised[0]?.code, ABST_WINDOW_OVERLAP_ID);
  assert.ok(!raised[0]?.outdated);
  assert.equal(raised[0]?.pointer, '/data/0', 'points at the report that named the appliance');
  assert.ok(isAdvisoryId(raised[0]?.requirement));
});

test('the advisory moves no §7 requirement', async () => {
  const ctx = makeCtx(SECOND_DELIVERY);
  const result = await runPipeline(ctx, bodyStages(depsWith([priorWindow()])));

  const withAdvisory = computeComplianceSummary(countsOf(result.findings));
  const withoutAdvisory = computeComplianceSummary(
    countsOf(result.findings.filter((f) => !isAdvisoryId(f.requirement))),
  );
  assert.deepEqual(withAdvisory, withoutAdvisory, 'the §7 summary is identical either way');
});

// ── the observation, pinned ─────────────────────────────────────────────────

test('an overlapping prior raises the approved copy verbatim', async () => {
  const [finding, ...rest] = await checkOnly(SECOND_DELIVERY, [priorWindow()]);
  assert.equal(rest.length, 0, 'one advisory per unit');
  assert.ok(finding);

  assert.equal(
    finding.summary,
    'The timestamps in this report overlap a report received earlier in this session for the ' +
      'same appliance.',
  );
  assert.equal(
    finding.detail,
    'Records for appliance id AMID appliance-1 span 2020-01-15T04:00:00Z to ' +
      '2020-01-15T04:45:00Z. A report received at 2026-09-18T09:14:07Z for the same appliance ' +
      'spans 2020-01-15T03:30:00Z to 2020-01-15T04:15:00Z, and the two bodies differ. ' +
      'Overlapping windows are what a record chunk appended to the previous delivery looks ' +
      'like from the receiving side; they are also what two deliveries that legitimately cover ' +
      'adjoining periods look like when a clock or a boundary is off by a little. Exact ' +
      'retransmissions are excluded from this observation and are graded under §1.8.',
  );
});

test('every timestamp renders ISO 8601 UTC to the second', async () => {
  // The bounds arrived as compact ABST strings and the received_at carries
  // milliseconds; both are read beside each other, so both are rendered one way.
  const [finding] = await checkOnly(SECOND_DELIVERY, [priorWindow()]);
  const stamps = (finding?.detail ?? '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) ?? [];
  assert.equal(
    stamps.length,
    5,
    "this body's two bounds, the prior's received_at, and the prior's two bounds",
  );
  assert.ok(
    !/\d{8}T\d{6}Z/.test(finding?.detail ?? ''),
    'no compact ABST form survives into the copy',
  );
  assert.ok(!/\.\d{3}Z/.test(finding?.detail ?? ''), 'no milliseconds survive into the copy');
});

test('an ASER-keyed report names the serial namespace', async () => {
  const [finding] = await checkOnly(SECOND_DELIVERY_BY_SERIAL, [
    priorWindow({ unit_key: 'aser:A-SerialNum' }),
  ]);
  assert.ok(
    finding?.detail?.startsWith('Records for appliance serial ASER A-SerialNum span '),
    `expected the ASER namespace, got: ${finding?.detail}`,
  );
});

test('the copy observes and never concludes', async () => {
  const [finding] = await checkOnly(SECOND_DELIVERY, [priorWindow()]);
  for (const [label, copy] of [
    ['summary', finding?.summary ?? ''],
    ['detail', finding?.detail ?? ''],
  ] as const) {
    const banned = ADVISORY_COPY_BANNED_WORDS.exec(copy);
    assert.equal(banned, null, `${label} uses the verdict word "${banned?.[0]}"`);
  }
  assert.ok(
    !/duplicat/i.test(`${finding?.summary} ${finding?.detail}`),
    'the overlap copy never says "duplicate" — §1.8 owns that word',
  );
});

// ── the intersection rule ───────────────────────────────────────────────────

test('a disjoint prior window raises nothing', async () => {
  // The prior ends at 03:59:59, one second before this body starts.
  const findings = await checkOnly(SECOND_DELIVERY, [
    priorWindow({
      abst_min: new Date('2020-01-15T03:00:00Z'),
      abst_max: new Date('2020-01-15T03:59:59Z'),
    }),
  ]);
  assert.deepEqual(findings, []);
});

test('windows that merely touch at one instant do intersect', async () => {
  // A record delivered in both halves of a boundary is the shape PQS describes,
  // so the closed-interval test is deliberate.
  const findings = await checkOnly(SECOND_DELIVERY, [
    priorWindow({
      abst_min: new Date('2020-01-15T03:00:00Z'),
      abst_max: new Date('2020-01-15T04:00:00Z'),
    }),
  ]);
  assert.equal(findings.length, 1);
});

test('a prior for a different appliance raises nothing', async () => {
  const findings = await checkOnly(SECOND_DELIVERY, [
    priorWindow({ unit_key: 'amid:appliance-9' }),
  ]);
  assert.deepEqual(findings, []);
});

test('one advisory per appliance, and only for the appliance with a prior', async () => {
  const findings = await checkOnly(TWO_APPLIANCES, [priorWindow()]);
  assert.equal(findings.length, 1, 'appliance-2 has no prior and draws nothing');
  assert.ok(findings[0]?.detail?.includes('AMID appliance-1'));
  assert.equal(findings[0]?.pointer, '/data/0');
});

test('several overlapping priors raise ONE advisory naming the most recent', async () => {
  // The repository orders newest first; the check takes the first match rather
  // than one finding per pair, so the count never measures session age.
  const findings = await checkOnly(SECOND_DELIVERY, [
    priorWindow({
      received_at: new Date('2026-09-18T11:00:00Z'),
      abst_min: new Date('2020-01-15T04:30:00Z'),
      abst_max: new Date('2020-01-15T05:00:00Z'),
    }),
    priorWindow({ received_at: new Date('2026-09-18T09:14:07Z') }),
  ]);
  assert.equal(findings.length, 1, 'one advisory per unit, however many priors overlap');
  assert.ok(
    findings[0]?.detail?.includes('received at 2026-09-18T11:00:00Z'),
    `expected the most recent prior, got: ${findings[0]?.detail}`,
  );
});

test('a body naming no appliance never reaches the lookup', async () => {
  calls.length = 0;
  const anonymous = rtmPayload({
    ...rtmReport('appliance-1', ['20200115T040000Z']),
    AMID: null,
  });
  const findings = await checkOnly(anonymous, [priorWindow()]);
  assert.deepEqual(findings, []);
  assert.equal(calls.length, 0, 'no unit key, no query');
});

// ── the exclusions this check asks for ──────────────────────────────────────

test('the lookup is asked for this session, these units, and both exclusions', async () => {
  calls.length = 0;
  await checkOnly(TWO_APPLIANCES, [priorWindow()]);

  assert.equal(calls.length, 1, 'one lookup per transmission, not one per report');
  const call = calls[0]!;
  assert.equal(call.sessionUuid, 'abst-window-session');
  assert.deepEqual([...call.unitKeys], ['amid:appliance-1', 'amid:appliance-2']);

  // The exclusions are what keep §1.8's ground — an exact replay and a re-used
  // transferId — out of this observation entirely.
  assert.equal(call.opts.excludeTransferId, 'T-abst-window-second');
  const expected = createHash('sha256')
    .update(Buffer.from(JSON.stringify(TWO_APPLIANCES), 'utf8'))
    .digest();
  assert.ok(
    Buffer.isBuffer(call.opts.excludeContentHash) && call.opts.excludeContentHash.equals(expected),
    'the sha256 of the raw body is excluded, the way duplicate.ts derives it',
  );
});
