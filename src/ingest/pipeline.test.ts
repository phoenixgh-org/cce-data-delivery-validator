/**
 * Pipeline framework unit tests (no DB). Exercises the runner's ordering,
 * short-circuit-vs-continue semantics, and finding accumulation in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTINUE,
  DEFAULT_SUCCESS_STATUS,
  SYNTHETIC_DATA_NOTICE,
  buildResponseBody,
  halt,
  record,
  runPipeline,
  type PipelineContext,
  type Stage,
} from './pipeline.js';
import { advisory } from './stages/semantic/advisory.js';

/** A bare context sufficient for runner tests (stages here ignore most fields). */
function fakeCtx(): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'test',
    rawBody: Buffer.alloc(0),
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
    contentType: null,
    contentEncoding: null,
    parseOk: null,
    schemaOk: null,
  };
}

test('runner continues through all stages → default success status', async () => {
  const order: string[] = [];
  const mk = (name: string): Stage => ({
    name,
    run() {
      order.push(name);
      return CONTINUE;
    },
  });
  const ctx = fakeCtx();
  const result = await runPipeline(ctx, [mk('a'), mk('b'), mk('c')]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(result.status, DEFAULT_SUCCESS_STATUS);
  assert.equal(result.haltedAt, null);
});

test('runner stops at the first halt and reports its status + stage name', async () => {
  const order: string[] = [];
  const mk = (name: string, out = CONTINUE): Stage => ({
    name,
    run() {
      order.push(name);
      return out;
    },
  });
  const ctx = fakeCtx();
  const result = await runPipeline(ctx, [mk('a'), mk('b', halt(413)), mk('c')]);
  assert.deepEqual(order, ['a', 'b'], 'c must not run after b halts');
  assert.equal(result.status, 413);
  assert.equal(result.haltedAt, 'b');
});

test('findings accumulate on ctx, including from the halting stage', async () => {
  const ctx = fakeCtx();
  const continuer: Stage = {
    name: 'note',
    run(c) {
      return record(c, { requirement: '1.2', severity: 'info', detail: 'observed' });
    },
  };
  const halter: Stage = {
    name: 'cap',
    run(c) {
      c.findings.push({ requirement: '1.4', severity: 'fail', detail: 'too big' });
      return halt(413);
    },
  };
  const result = await runPipeline(ctx, [continuer, halter]);
  assert.equal(result.findings.length, 2);
  assert.equal(ctx.findings.length, 2);
  assert.equal(result.status, 413);
});

test('buildResponseBody echoes id, status, count, and per-finding details (teaching surface)', () => {
  const findings = [
    { requirement: '1.4', severity: 'pass', detail: 'wire body is 12 bytes, within the 1MB cap' },
    { requirement: '3.3', severity: 'info', detail: 'present DS01 objects: AMID×1' },
  ] as const;
  const body = buildResponseBody(200, findings, 'tx-1');

  assert.equal(body.transmissionId, 'tx-1');
  assert.equal(body.status, 200);
  assert.equal(body.findings, 2, 'count is preserved from the original shape');
  // Per-finding echo carries requirement/severity/detail (no internal pointer).
  assert.deepEqual(body.findingDetails, [
    { requirement: '1.4', severity: 'pass', detail: 'wire body is 12 bytes, within the 1MB cap' },
    { requirement: '3.3', severity: 'info', detail: 'present DS01 objects: AMID×1' },
  ]);
});

test('buildResponseBody: advisories are carried in their own field, out of the tally (7rv)', () => {
  // An advisory never moves a requirement's status (DESIGN §7.1), so it must not
  // move the one number the response reports as the outcome either — the same
  // exclusion the dashboard's verdict cell makes (`findingsCell`). It is carried
  // rather than dropped: this body is the only surface some integrators read.
  const body = buildResponseBody(
    200,
    [
      { requirement: '1.2', severity: 'pass' },
      advisory({ id: 'adv.null_padding', detail: 'TCON was null in all 480 records' }),
    ],
    'tx-adv',
  );

  assert.equal(body.findings, 1, 'graded findings only');
  assert.deepEqual(
    body.findingDetails.map((f) => f.requirement),
    ['1.2'],
  );
  assert.deepEqual(body.advisories, [
    {
      requirement: 'adv.null_padding',
      severity: 'info',
      detail: 'TCON was null in all 480 records',
    },
  ]);
  // The tally is what a lone graded pass would have produced, plus a separate
  // sentence for the advisory — never "2 findings (1 info)".
  assert.match(body.message, /^Accepted \(200\): data recorded; 1 finding\./);
  assert.match(body.message, /1 advisory, not graded and not counted above\.$/);
});

test('buildResponseBody: advisories alone leave a zero tally and no info count (7rv)', () => {
  const body = buildResponseBody(
    200,
    [advisory({ id: 'adv.date_format', detail: 'd' })],
    'tx-adv2',
  );

  assert.equal(body.findings, 0);
  assert.deepEqual(body.findingDetails, []);
  assert.equal(body.advisories.length, 1);
  assert.match(body.message, /^Accepted \(200\): data recorded; 0 findings\. /);
  assert.doesNotMatch(body.message, /info/, 'an advisory is never counted as an info finding');
});

test('buildResponseBody carries the synthetic-data-only notice on accepted AND rejected bodies', () => {
  // dkz.1 — the sandbox constraint has to reach an integrator who never opens
  // the dashboard, so it rides every response, not just the 2xx path.
  assert.equal(buildResponseBody(200, [], 'tx-2').notice, SYNTHETIC_DATA_NOTICE);
  assert.equal(buildResponseBody(422, [], 'tx-2').notice, SYNTHETIC_DATA_NOTICE);
  assert.match(SYNTHETIC_DATA_NOTICE, /Synthetic test data only/);
});

test('buildResponseBody message: accepted 2xx leads with "Accepted" and the tally', () => {
  const body = buildResponseBody(
    200,
    [
      { requirement: '1.2', severity: 'pass' },
      { requirement: '3.3', severity: 'info' },
    ],
    'tx-1',
  );
  assert.match(body.message, /^Accepted \(200\)/);
  assert.match(body.message, /2 findings/);
  assert.match(body.message, /1 info/, 'breaks down the info count');
});

test('buildResponseBody message: short-circuit leads with "Rejected (NNN)" + fail count', () => {
  const body = buildResponseBody(
    422,
    [
      { requirement: '1.1', severity: 'pass' },
      { requirement: '3.2', severity: 'fail', detail: 'schema violation at (root): is invalid' },
    ],
    'tx-2',
  );
  assert.match(body.message, /^Rejected \(422\)/);
  assert.match(body.message, /2 findings/);
  assert.match(body.message, /1 fail/, 'surfaces the fail count');
});

test('buildResponseBody: no-row pre-body halt (404) → null id, empty details, singular wording', () => {
  const body = buildResponseBody(404, [], null);
  assert.equal(body.transmissionId, null);
  assert.equal(body.status, 404);
  assert.equal(body.findings, 0);
  assert.deepEqual(body.findingDetails, []);
  assert.deepEqual(body.advisories, []);
  assert.match(body.message, /Rejected \(404\): 0 findings\./);
});

test('buildResponseBody: a single finding uses singular "finding"', () => {
  const body = buildResponseBody(200, [{ requirement: '1.2', severity: 'pass' }], 'tx-3');
  assert.match(body.message, /1 finding\./);
  assert.doesNotMatch(body.message, /1 findings/);
});

test('runPipeline result feeds buildResponseBody end-to-end (no DB)', async () => {
  const stage: Stage = {
    name: 'fail-stage',
    run(c) {
      c.findings.push({ requirement: '1.6', severity: 'fail', detail: 'undecodable' });
      return halt(400);
    },
  };
  const ctx = fakeCtx();
  const result = await runPipeline(ctx, [stage]);
  const body = buildResponseBody(result.status, result.findings, 'tx-4');

  assert.equal(body.status, 400);
  assert.equal(body.findings, 1);
  assert.equal(body.findingDetails[0]?.detail, 'undecodable');
  assert.match(body.message, /^Rejected \(400\): 1 finding \(1 fail\)\./);
});
