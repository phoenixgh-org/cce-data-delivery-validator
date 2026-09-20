/**
 * The semantic checks against a MULTI-REPORT transmission (frk).
 *
 * `data` is an array — the schema titles it "Cold chain data reports", "Array of
 * data reports for one or more pieces of cold-chain equipment", `minItems: 1`.
 * One report per POST is the common case, and every fixture in this directory
 * sends exactly one, so nothing until now had run the stage-8 checks against a
 * supplier who batches several CCEs into a single delivery. frk's second
 * acceptance clause asks for that reading to be done against a real payload
 * rather than by inspection.
 *
 * WHAT THIS PINS. One clean two-report RTM batch through the real §6 body
 * stages, asserting three things: no check throws, no check fires on a payload
 * that broke no rule, and the checks whose prose COUNTS reports say two.
 *
 * ── THE FIXTURE IS BUILT TO CATCH POOLING ───────────────────────────────────
 * Two reports whose readings do not merely differ but are a DAY APART, with the
 * SECOND report's window EARLIER than the first's. That shape turns three
 * separate "does this check respect report boundaries?" questions into
 * assertions that fail loudly if it does not:
 *
 *   - ./time-order.ts walks records in document order. Pooled across reports,
 *     report 1's first reading (Jan 14) follows report 0's last (Jan 15) and
 *     steps ~18 h back — `adv.time_not_increasing` would fire.
 *   - ./sample-gap.ts sorts and measures consecutive deltas. Pooled, the stretch
 *     between the two windows is ~18 h against a 900 s period —
 *     `adv.sample_gap` would fire.
 *   - ./interval.ts grades the coefficient of variation. Pooled, three 15-minute
 *     intervals plus one 18-hour one blows the 25 % tolerance — §3.4 would FAIL
 *     a batch in which every device sampled perfectly regularly.
 *
 * All three grade per report today, so all three stay silent; the fixture is
 * what makes that a measurement rather than a claim.
 *
 * ── WHAT WAS READ, AND THE VERDICT ──────────────────────────────────────────
 * The five modules frk names, read with batching in mind:
 *
 *   - ./duplicate.ts (§1.8) — transmission-level BY DESIGN: content hash of the
 *     whole body plus `meta.transferId`, which the format carries once per
 *     transmission. Correct for the clause it grades (§1.8 is about re-sending a
 *     transmission). The limit is under-detection, not mis-grading: a report
 *     replayed inside a differently-shaped batch is not noticed. No defect.
 *   - ./concurrency.ts (§2.1) — reads no body at all, only the in-flight count.
 *     Batching cannot affect it. No defect.
 *   - ./interval.ts (§3.4) — one series per report, one overall finding, and the
 *     prose already says "N of M report series". No defect.
 *   - ./sample-gap.ts (`adv.sample_gap`) — `scanReport` per report, gaps pooled
 *     only AFTER the per-report walk. No defect.
 *   - ./time-order.ts (`adv.time_not_increasing`) — same shape, `scanReport` per
 *     report, and the pointer carries the report index. No defect.
 *
 * So nothing here is filed as a batching bug. The identity seam frk points at is
 * real but sits elsewhere: a transmission has ONE `meta` block over potentially
 * many CCEs, which is what p98 (the distinct-CCE count) turns on, and is a
 * question about what the dashboard REPORTS rather than about how these checks
 * grade.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaRegistry } from '../../../schema-registry.js';
import { runPipeline, type Finding, type PipelineContext, type Stage } from '../../pipeline.js';
import { contentTypeStage } from '../content-type.js';
import { encodingStage } from '../encoding.js';
import { parseStage } from '../parse.js';
import { schemaStage } from '../schema.js';
import { semanticStage, type SemanticDeps } from '../semantic.js';
import { sizeStage } from '../size.js';
import { isAdvisoryId } from './advisory.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
  findPriorUnitWindows: async () => [],
  findPriorUnitIdentities: async () => [],
};

// ── fixture ──────────────────────────────────────────────────────────────────

/** Three rtmd records at a 15-minute cadence, stamped on the given date. */
function records(date: string, hhmm: readonly [string, string, string]): Record<string, unknown>[] {
  return hhmm.map((t) => ({
    ABST: `${date}T${t}00Z`,
    ALRM: null,
    BEMD: 14.3,
    EERR: null,
    TVC: 3.2,
  }));
}

/**
 * One rtmd-report for a distinct piece of equipment. Every identifier differs
 * between the two so the batch is two CCEs and not the same one twice, and the
 * windows are a day apart in descending order — see the header.
 */
function report(n: 0 | 1, over: Record<string, unknown> = {}): Record<string, unknown> {
  const [date, times] =
    n === 0
      ? (['20240115', ['0330', '0345', '0400']] as const)
      : (['20240114', ['0900', '0915', '0930']] as const);
  return {
    CID: 'US',
    AMID: `appliance-${n}`,
    EDOP: '2021-06-01',
    EMFR: 'EMD_Name',
    EMOD: 'EMD-ModelNo',
    EPQS: 'E006/999',
    ESER: `EMD-Serial-${n}`,
    EMSV: 'v01.02.123',
    DLST: { TVC: { SID: `sensor-${n}`, SMFR: 'SensMfr', SMOD: 'SensMod' } },
    ...over,
    records: records(date, times),
  };
}

/** A schema-valid RTM transmission carrying TWO reports for two distinct CCEs. */
function rtmBatch(secondReportOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-multi-report',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: [report(0), report(1, secondReportOver)],
  };
}

// ── harness ──────────────────────────────────────────────────────────────────

function makeCtx(payload: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'multi-report-session',
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

/**
 * The fail findings of a run under the CONTRACT profile only — the shadow
 * lineage's fails are a statement about an unpublished draft and say nothing
 * about whether these checks handled the batch (mirrors null-identity.test.ts).
 */
function contractFails(ctx: PipelineContext, findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'fail' && f.profile !== ctx.shadowProfile);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => isAdvisoryId(f.requirement));
}

function one(findings: readonly Finding[], requirement: string): Finding {
  const matched = findings.filter((f) => f.requirement === requirement);
  assert.equal(matched.length, 1, `expected exactly one §${requirement} finding`);
  return matched[0]!;
}

// ── the batch is legal in the first place ────────────────────────────────────

test('the two-report batch is schema-conformant on the registered 0.8.1', () => {
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  assert.equal(
    entry.validate(rtmBatch()),
    true,
    `batch is legal: ${JSON.stringify(entry.validate.errors)}`,
  );
});

// ── every check survives a batch, and none of them fires on a clean one ──────

test('a clean two-report batch runs every semantic check without throwing or failing', async () => {
  const ctx = makeCtx(rtmBatch());
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 200, 'the batch is accepted');
  assert.equal(
    contractFails(ctx, result.findings).length,
    0,
    `no contract fail is earned: ${JSON.stringify(contractFails(ctx, result.findings))}`,
  );

  // The transmission-level pair: unaffected by how many reports rode along.
  assert.equal(one(result.findings, '1.8').severity, 'pass', '§1.8 novel transmission');
  assert.equal(one(result.findings, '2.1').severity, 'pass', '§2.1 serial delivery');

  // No advisory fires on a payload that broke no rule. A pooled walk over the
  // two reports' timestamps would trip time-order and sample-gap here.
  assert.deepEqual(
    advisories(result.findings).map((f) => f.requirement),
    [],
    'no advisory fires on a clean batch',
  );
});

test('§3.4 grades each report as its own series and says how many there were', async () => {
  const ctx = makeCtx(rtmBatch());
  const result = await runPipeline(ctx, bodyStages());

  const interval = one(result.findings, '3.4');
  assert.equal(interval.severity, 'pass', 'both series are regular on their own terms');
  assert.match(
    interval.detail ?? '',
    /2 report series/,
    'the count names both reports, not one series of six readings',
  );
});

test('§3.3 inventories the data objects of both reports, not just the first', async () => {
  const ctx = makeCtx(rtmBatch());
  const result = await runPipeline(ctx, bodyStages());

  const inventory = one(result.findings, '3.3');
  assert.equal(inventory.severity, 'info');
  // One report-level AMID each; three records each carrying TVC.
  assert.match(inventory.detail ?? '', /\bAMID×2\b/, 'report-level codes tallied across reports');
  assert.match(inventory.detail ?? '', /\bTVC×6\b/, 'record-level codes tallied across reports');
});

// ── a report-naming advisory counts the whole batch ──────────────────────────

test('an advisory raised by ONE report of two says "1 of 2 reports" and points at it', async () => {
  // AMID blank on the second report only — the one blank an rtmd-report admits,
  // and still schema-valid, so the batch is accepted and only the advisory moves.
  const ctx = makeCtx(rtmBatch({ AMID: '' }));
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 200);
  assert.equal(contractFails(ctx, result.findings).length, 0, 'a blank AMID breaks no rule');

  const raised = one(result.findings, 'adv.null_identity');
  assert.match(
    raised.summary ?? '',
    /^1 of 2 reports carries /,
    'the denominator is the batch, and the verb agrees with the one affected',
  );
  assert.equal(raised.pointer, '/data/1', 'the pointer names the report that tripped it');
});
