/**
 * §1.8 duplicate-detection stage-unit tests (8ji.1).
 *
 * Pure stage-unit: no DB, no HTTP. We hand-build a {@link PipelineContext}
 * (mirroring the harness in schema-stage.test.ts) and pass a FAKE
 * `deps.findPriorTransmissions` so we control exactly what priors the check
 * grades against. Covers the three branches: both-novel → pass; same-transferId
 * → fail; identical body (matching content_hash) → fail naming exact replay.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { PriorTransmission } from '../../../db/repository.js';
import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticDeps } from '../semantic.js';
import { duplicateCheck } from './duplicate.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** A parse+schema-valid PipelineContext for the duplicate check. */
function makeCtx(body: Record<string, unknown>, transferId: string | null): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'session-1',
    rawBody: Buffer.from(JSON.stringify(body)),
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody: body,
    meta: { transferId },
    normalizedSchemaVersion: '0.8.0',
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: true,
    schemaOk: true,
  };
}

/** A fake deps whose lookup returns a fixed list of priors. */
function fakeDeps(priors: PriorTransmission[]): SemanticDeps {
  return {
    concurrentAtEntry: 1,
    findPriorTransmissions: async () => priors,
  };
}

function only(findings: Finding[]): Finding {
  assert.equal(findings.length, 1, 'duplicate check returns exactly one finding');
  assert.equal(findings[0]?.requirement, '1.8');
  return findings[0]!;
}

test('duplicate: novel transferId + body (no priors) → one 1.8 pass', async () => {
  const ctx = makeCtx({ meta: { transferId: 'T-1' }, data: [1] }, 'T-1');
  const findings = await duplicateCheck(ctx, fakeDeps([]));
  const f = only(findings);
  assert.equal(f.severity, 'pass');
  assert.match(f.detail ?? '', /novel/);
});

test('duplicate: prior with same transferId → 1.8 fail naming repeated transferId', async () => {
  const ctx = makeCtx({ meta: { transferId: 'T-2' }, data: [1] }, 'T-2');
  const prior: PriorTransmission = {
    id: 'prior-1',
    transfer_id: 'T-2',
    // Different bytes from the current body → only the transferId repeats.
    content_hash: createHash('sha256').update('something else').digest(),
    received_at: new Date('2026-05-01T00:00:00Z'),
  };
  const findings = await duplicateCheck(ctx, fakeDeps([prior]));
  const f = only(findings);
  assert.equal(f.severity, 'fail');
  assert.match(f.detail ?? '', /transferId/);
  assert.match(f.detail ?? '', /T-2/);
  // Not an exact replay — the detail must not claim byte-identical content.
  assert.doesNotMatch(f.detail ?? '', /exact content replay/);
  // Honesty caveat present.
  assert.match(f.detail ?? '', /cannot judge/);
});

test('duplicate: prior with identical body (matching content_hash) → 1.8 fail naming exact replay', async () => {
  const ctx = makeCtx({ meta: { transferId: 'T-3' }, data: [1] }, 'T-3');
  // Build the prior's content_hash to match the CURRENT body exactly.
  const matchingHash = createHash('sha256').update(ctx.rawBody).digest();
  const prior: PriorTransmission = {
    id: 'prior-2',
    // Different transferId so ONLY the content replay trips.
    transfer_id: 'T-other',
    content_hash: matchingHash,
    received_at: new Date('2026-05-01T00:00:00Z'),
  };
  const findings = await duplicateCheck(ctx, fakeDeps([prior]));
  const f = only(findings);
  assert.equal(f.severity, 'fail');
  assert.match(f.detail ?? '', /exact content replay/);
  assert.match(f.detail ?? '', /cannot judge/);
});

test('duplicate: prior matching BOTH transferId and content → fail names both', async () => {
  const ctx = makeCtx({ meta: { transferId: 'T-4' }, data: [1] }, 'T-4');
  const prior: PriorTransmission = {
    id: 'prior-3',
    transfer_id: 'T-4',
    content_hash: createHash('sha256').update(ctx.rawBody).digest(),
    received_at: new Date('2026-05-01T00:00:00Z'),
  };
  const f = only(await duplicateCheck(ctx, fakeDeps([prior])));
  assert.equal(f.severity, 'fail');
  assert.match(f.detail ?? '', /exact content replay/);
  assert.match(f.detail ?? '', /transferId/);
});
