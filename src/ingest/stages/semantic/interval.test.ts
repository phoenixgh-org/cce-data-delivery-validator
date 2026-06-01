/**
 * Stage-8 interval-regularity check tests (8ji.2).
 *
 * STAGE-UNIT only (node:test, no DB): drive `intervalCheck` against a
 * hand-built {@link PipelineContext}, mirroring schema-stage.test.ts's harness.
 * The check is body-only and never touches `deps`, so we pass a stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PipelineContext } from '../../pipeline.js';
import type { SemanticDeps } from '../semantic.js';
import { intervalCheck, parseAbst } from './interval.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** deps stub — intervalCheck inspects only the body, never these. */
const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

/** A parse+schema-valid PipelineContext carrying `parsedBody`. */
function makeCtx(parsedBody: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'test-session',
    rawBody: Buffer.from(JSON.stringify(parsedBody)),
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody,
    meta: {},
    normalizedSchemaVersion: null,
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: true,
    schemaOk: true,
  };
}

/** Build a report whose records carry the given ABST strings. */
function report(absts: string[]): Record<string, unknown> {
  return { AMID: 'dev-1', records: absts.map((ABST) => ({ ABST })) };
}

/** Format an epoch-ms back into the compact ABST form (for generating regular series). */
function abstAt(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

function findingsBy(ctx: PipelineContext, severity: string) {
  return ctx.findings.filter((f) => f.requirement === '3.4' && f.severity === severity);
}

// ── ABST parser ───────────────────────────────────────────────────────────────

test('parseAbst: compact UTC form → correct epoch-ms', () => {
  // 2020-01-15 04:05:54 UTC
  assert.equal(parseAbst('20200115T040554Z'), Date.UTC(2020, 0, 15, 4, 5, 54, 0));
});

test('parseAbst: fractional-seconds variant is parsed', () => {
  assert.equal(parseAbst('20200115T040554.250Z'), Date.UTC(2020, 0, 15, 4, 5, 54, 250));
});

test('parseAbst: non-string / malformed → null', () => {
  assert.equal(parseAbst(undefined), null);
  assert.equal(parseAbst(12345), null);
  assert.equal(parseAbst('2020-01-15T04:05:54Z'), null, 'ISO-with-separators is not the ABST form');
  assert.equal(parseAbst('garbage'), null);
});

// ── regular series → pass ──────────────────────────────────────────────────────

test('interval: regular 15-min cadence → one 3.4 pass', () => {
  const start = Date.UTC(2020, 0, 15, 4, 0, 0);
  const fifteenMin = 15 * 60 * 1000;
  const absts = [0, 1, 2, 3, 4, 5].map((i) => abstAt(start + i * fifteenMin));
  const ctx = makeCtx({ meta: {}, data: [report(absts)] });

  const findings = intervalCheck(ctx, deps) as ReturnType<typeof intervalCheck> & unknown[];
  for (const f of findings) ctx.findings.push(f);

  assert.equal(findingsBy(ctx, 'fail').length, 0, 'no fail');
  assert.equal(findingsBy(ctx, 'pass').length, 1, 'one pass');
  assert.match(findingsBy(ctx, 'pass')[0]?.detail ?? '', /regular/);
});

// ── irregular series → fail ─────────────────────────────────────────────────────

test('interval: uneven gaps → one 3.4 fail with the honesty caveat', () => {
  // Gaps of 1 min, 1 min, then a 60-min jump, then 1 min → high CV.
  const t = Date.UTC(2020, 0, 15, 4, 0, 0);
  const min = 60 * 1000;
  const absts = [
    abstAt(t),
    abstAt(t + 1 * min),
    abstAt(t + 2 * min),
    abstAt(t + 62 * min),
    abstAt(t + 63 * min),
  ];
  const ctx = makeCtx({ meta: {}, data: [report(absts)] });

  const findings = intervalCheck(ctx, deps) as unknown[];
  for (const f of findings) ctx.findings.push(f as never);

  assert.equal(findingsBy(ctx, 'pass').length, 0, 'no pass');
  const fails = findingsBy(ctx, 'fail');
  assert.equal(fails.length, 1, 'one fail');
  assert.match(fails[0]?.detail ?? '', /irregular/);
  assert.match(fails[0]?.detail ?? '', /Heuristic only/, 'carries the §3.4 honesty caveat');
});

// ── multi-report aggregation: any irregular ⇒ fail ──────────────────────────────

test('interval: one regular + one irregular report → fail naming the count', () => {
  const start = Date.UTC(2020, 0, 15, 4, 0, 0);
  const hour = 60 * 60 * 1000;
  const regular = report([0, 1, 2, 3].map((i) => abstAt(start + i * hour)));

  const t = Date.UTC(2020, 0, 16, 4, 0, 0);
  const min = 60 * 1000;
  const irregular = report([
    abstAt(t),
    abstAt(t + 1 * min),
    abstAt(t + 90 * min),
    abstAt(t + 91 * min),
  ]);

  const ctx = makeCtx({ meta: {}, data: [regular, irregular] });
  for (const f of intervalCheck(ctx, deps) as unknown[]) ctx.findings.push(f as never);

  const fails = findingsBy(ctx, 'fail');
  assert.equal(fails.length, 1, 'one overall fail');
  assert.match(fails[0]?.detail ?? '', /1 of 2/, 'names how many series were irregular');
});

// ── sparse / empty → no finding ──────────────────────────────────────────────────

test('interval: fewer than 2 ABST in the whole payload → no finding', () => {
  const ctx = makeCtx({ meta: {}, data: [report(['20200115T040554Z'])] });
  const findings = intervalCheck(ctx, deps) as unknown[];
  assert.equal(findings.length, 0, 'nothing to judge → empty');
});

test('interval: empty data array → no finding', () => {
  const ctx = makeCtx({ meta: {}, data: [] });
  assert.equal((intervalCheck(ctx, deps) as unknown[]).length, 0);
});

test('interval: missing data / unparseable ABST → no finding (defensive)', () => {
  assert.equal((intervalCheck(makeCtx({ meta: {} }), deps) as unknown[]).length, 0);
  const ctx = makeCtx({ meta: {}, data: [report(['garbage', 'also-bad'])] });
  assert.equal((intervalCheck(ctx, deps) as unknown[]).length, 0);
});
