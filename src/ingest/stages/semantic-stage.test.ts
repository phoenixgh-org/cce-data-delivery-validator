/**
 * Stage 8 (semantic) tests (8ji.3 scaffold + §2.1 concurrency check).
 *
 * STAGE-UNIT only (no DB, no HTTP — always run):
 *   - the §2.1 concurrency check: snapshot 1 ⇒ pass (serial); snapshot ≥2 ⇒ fail.
 *   - the orchestrator: never halts, aggregates check findings (the three body
 *     stubs return [], so with a valid body only the concurrency finding lands).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PriorTransmission } from '../../db/repository.js';
import type { PipelineContext, StageOutcome } from '../pipeline.js';
import { semanticStage, type SemanticDeps } from './semantic.js';
import { concurrencyCheck } from './semantic/concurrency.js';

// ── harness ──────────────────────────────────────────────────────────────────

/** A semantic-stage ctx: parse + schema already continued on a valid body. */
function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'test-session',
    rawBody: Buffer.from('{}'),
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody: { meta: {}, data: [] },
    meta: {},
    normalizedSchemaVersion: '0.8.0',
    contentType: 'application/json; charset=utf-8',
    contentEncoding: null,
    parseOk: true,
    schemaOk: true,
    ...overrides,
  };
}

/** Deps whose prior-lookup is a no-op (the duplicate stub never calls it yet). */
function makeDeps(concurrentAtEntry: number): SemanticDeps {
  return {
    concurrentAtEntry,
    findPriorTransmissions: async (): Promise<PriorTransmission[]> => [],
  };
}

// ── §2.1 concurrency check (unit) ────────────────────────────────────────────

test('concurrency: snapshot 1 (serial) → one 2.1 pass finding', async () => {
  const ctx = makeCtx();
  const findings = await concurrencyCheck(ctx, makeDeps(1));
  assert.equal(findings.length, 1, 'exactly one finding');
  assert.equal(findings[0]?.requirement, '2.1');
  assert.equal(findings[0]?.severity, 'pass');
  assert.match(findings[0]?.detail ?? '', /serial delivery by default/, 'cites §2.1 caveat');
});

test('concurrency: snapshot ≥2 (overlap) → one 2.1 fail finding', async () => {
  const ctx = makeCtx();
  for (const observed of [2, 3, 7]) {
    const findings = await concurrencyCheck(ctx, makeDeps(observed));
    assert.equal(findings.length, 1, `one finding for snapshot ${observed}`);
    assert.equal(findings[0]?.requirement, '2.1');
    assert.equal(findings[0]?.severity, 'fail', `snapshot ${observed} ⇒ fail`);
    assert.match(findings[0]?.detail ?? '', /serial delivery by default/, 'cites §2.1 caveat');
    assert.equal(findings[0]?.code, 'tx.concurrent_delivery', 'carries the stable signature code');
  }
});

// ── orchestrator (unit) ──────────────────────────────────────────────────────

test('semantic: never halts and aggregates findings (stubs return [])', async () => {
  const ctx = makeCtx();
  const outcome = (await semanticStage(makeDeps(1)).run(ctx)) as StageOutcome;
  assert.equal(outcome.kind, 'continue', 'semantic stage never halts');
  // Three body stubs return []; only the concurrency check contributes today.
  const concurrency = ctx.findings.filter((f) => f.requirement === '2.1');
  assert.equal(concurrency.length, 1, 'one §2.1 finding pushed onto ctx.findings');
});

test('semantic: concurrent snapshot surfaces a 2.1 fail through the stage', async () => {
  const ctx = makeCtx();
  const outcome = (await semanticStage(makeDeps(3)).run(ctx)) as StageOutcome;
  assert.equal(outcome.kind, 'continue');
  assert.ok(
    ctx.findings.some((f) => f.requirement === '2.1' && f.severity === 'fail'),
    'concurrent delivery → 2.1 fail aggregated',
  );
});

test('semantic: no valid body → still runs concurrency, skips body checks', async () => {
  // Defensive guard: parseOk/schemaOk not both true → body checks skipped, but
  // the concurrency check (body-independent) still emits its finding.
  const ctx = makeCtx({ parseOk: false, schemaOk: null, parsedBody: null });
  const outcome = (await semanticStage(makeDeps(1)).run(ctx)) as StageOutcome;
  assert.equal(outcome.kind, 'continue');
  assert.equal(ctx.findings.filter((f) => f.requirement === '2.1').length, 1);
});
