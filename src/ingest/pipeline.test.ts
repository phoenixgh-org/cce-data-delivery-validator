/**
 * Pipeline framework unit tests (no DB). Exercises the runner's ordering,
 * short-circuit-vs-continue semantics, and finding accumulation in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTINUE,
  DEFAULT_SUCCESS_STATUS,
  buildResponseBody,
  halt,
  record,
  runPipeline,
  type PipelineContext,
  type Stage,
} from './pipeline.js';

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

test('buildResponseBody summarizes status + finding count + transmission id', () => {
  const body = buildResponseBody(200, [{ requirement: '1.2', severity: 'info' }], 'tx-1');
  assert.deepEqual(body, { transmissionId: 'tx-1', status: 200, findings: 1 });

  const noRow = buildResponseBody(404, [], null);
  assert.deepEqual(noRow, { transmissionId: null, status: 404, findings: 0 });
});
