/**
 * Scope helper tests (4h4.4) — PURE, no DB. Covers window parsing + default
 * fallback, the scope predicate (time bound + source filter), the engine.js
 * rollup/passTrend ports, scope totals, and window-aware source counts not
 * narrowed by the selected source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SOURCE,
  DEFAULT_WINDOW,
  inScope,
  parseSource,
  parseWindow,
  passTrend,
  rollup,
  scopeTotals,
  scopeTransmissions,
  txFailing,
  windowLowerBound,
} from './scope.js';
import { computeComplianceSummary } from './compliance-matrix.js';
import type { ComplianceRow } from './compliance-matrix.js';
import { sourceCounts } from './source.js';

// ── window parsing ──────────────────────────────────────────────────────────

test('parseWindow accepts the four known tokens', () => {
  assert.equal(parseWindow('15m'), '15m');
  assert.equal(parseWindow('1h'), '1h');
  assert.equal(parseWindow('6h'), '6h');
  assert.equal(parseWindow('all'), 'all');
});

test('parseWindow falls back to default for unknown/absent/invalid values (no throw)', () => {
  assert.equal(DEFAULT_WINDOW, 'all');
  assert.equal(parseWindow(undefined), 'all');
  assert.equal(parseWindow('30m'), 'all');
  assert.equal(parseWindow(''), 'all');
  assert.equal(parseWindow(42), 'all');
  assert.equal(parseWindow(null), 'all');
});

test('parseSource preserves a source key, the empty unknown bucket, and falls back', () => {
  assert.equal(parseSource('org.kano'), 'org.kano');
  assert.equal(parseSource(''), ''); // the canonical unknown bucket key
  assert.equal(parseSource('all'), 'all');
  assert.equal(DEFAULT_SOURCE, 'all');
  assert.equal(parseSource(undefined), 'all');
  assert.equal(parseSource(123), 'all');
});

// ── window lower bound (the SQL time-bound, shared with inScope) ─────────────

const NOW = Date.parse('2026-06-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('windowLowerBound returns null for all, else now - span', () => {
  assert.equal(windowLowerBound('all', NOW), null);
  assert.equal(windowLowerBound('15m', NOW), NOW - 15 * 60 * 1000);
  assert.equal(windowLowerBound('1h', NOW), NOW - 60 * 60 * 1000);
  assert.equal(windowLowerBound('6h', NOW), NOW - 6 * 60 * 60 * 1000);
});

test('windowLowerBound agrees with inScope time bound (single source of window math)', () => {
  // A tx exactly at the bound is in scope; one a ms older is not — the SQL bound
  // (received_at >= lo) must match inScope, which is the summary endpoint's path.
  for (const w of ['15m', '1h', '6h'] as const) {
    const lo = windowLowerBound(w, NOW)!;
    assert.equal(
      inScope({ received_at: new Date(lo).toISOString(), source: 'a' }, w, 'all', NOW),
      true,
    );
    assert.equal(
      inScope({ received_at: new Date(lo - 1).toISOString(), source: 'a' }, w, 'all', NOW),
      false,
    );
  }
});

// ── scope predicate (time bound + source filter) ────────────────────────────

test('inScope: all window has no time bound', () => {
  assert.equal(
    inScope({ received_at: ago(99 * 60 * 60 * 1000), source: 'a' }, 'all', 'all', NOW),
    true,
  );
});

test('inScope: bounded window excludes tx older than now - window', () => {
  const within = { received_at: ago(10 * 60 * 1000), source: 'a' }; // 10m ago
  const outside = { received_at: ago(20 * 60 * 1000), source: 'a' }; // 20m ago
  assert.equal(inScope(within, '15m', 'all', NOW), true);
  assert.equal(inScope(outside, '15m', 'all', NOW), false);
  // 1h window admits the 20m-ago tx.
  assert.equal(inScope(outside, '1h', 'all', NOW), true);
});

test('inScope: source filter matches exact raw key; all admits every source', () => {
  const tx = { received_at: ago(1000), source: 'org.kano' };
  assert.equal(inScope(tx, 'all', 'org.kano', NOW), true);
  assert.equal(inScope(tx, 'all', 'org.other', NOW), false);
  assert.equal(inScope(tx, 'all', 'all', NOW), true);
  // The unknown bucket ('') is a real, selectable source.
  assert.equal(inScope({ received_at: ago(1000), source: '' }, 'all', '', NOW), true);
  assert.equal(inScope({ received_at: ago(1000), source: 'x' }, 'all', '', NOW), false);
});

test('scopeTransmissions narrows on BOTH time bound and source', () => {
  const txs = [
    { received_at: ago(5 * 60 * 1000), source: 'a' }, // in 15m, src a
    { received_at: ago(5 * 60 * 1000), source: 'b' }, // in 15m, src b
    { received_at: ago(60 * 60 * 1000), source: 'a' }, // out of 15m, src a
  ];
  assert.equal(scopeTransmissions(txs, '15m', 'all', NOW).length, 2);
  assert.equal(scopeTransmissions(txs, '15m', 'a', NOW).length, 1);
  assert.equal(scopeTransmissions(txs, 'all', 'a', NOW).length, 2);
});

// ── rollup (engine.js spec) ─────────────────────────────────────────────────

test('rollup matches the engine.js spec: gradeable=verified|heuristic, failing folds mixed', () => {
  // Build a real summary, then override statuses for a few gradeable rows.
  const summary = computeComplianceSummary();
  const set = (req: string, status: ComplianceRow['status']) => {
    const row = summary.find((r) => r.requirement === req)!;
    (row as { status: ComplianceRow['status'] }).status = status;
  };
  // gradeable rows: 1.2/1.4 (verified), 1.8/2.1 (heuristic).
  set('1.2', 'pass');
  set('1.4', 'fail');
  set('1.8', 'mixed');
  set('2.1', 'untested');

  const r = rollup(summary);
  assert.equal(r.total, summary.length); // all 27 rows
  // gradeable = every verified|heuristic row (status-independent).
  const gradeable = summary.filter(
    (row) => row.classes[0] === 'verified' || row.classes[0] === 'heuristic',
  ).length;
  assert.equal(r.gradeable, gradeable);
  assert.equal(r.passing, 1, '1.2');
  assert.equal(r.failing, 2, '1.4 fail + 1.8 mixed fold in');
  // untested = remaining gradeable (defaults to untested) + the 2.1 override.
  assert.equal(
    r.untested,
    gradeable - 3,
    'every gradeable row except the 3 pass/fail/mixed ones is untested',
  );
});

// ── passTrend (30 buckets, {tot,fail,rate}) ─────────────────────────────────

const tx = (mins: number, fail: boolean) => ({
  received_at: new Date(NOW + mins * 60 * 1000).toISOString(),
  findings: fail ? [{ severity: 'fail' }] : [{ severity: 'pass' }],
});

test('txFailing keys off severity===fail', () => {
  assert.equal(txFailing(tx(0, true)), true);
  assert.equal(txFailing(tx(0, false)), false);
  assert.equal(txFailing({ received_at: ago(0), findings: [{ severity: 'info' }] }), false);
});

test('passTrend returns exactly 30 buckets with {tot,fail,rate}, empty buckets null', () => {
  // Two tx far apart so most of the 30 buckets are empty (→ rate null).
  const buckets = passTrend([tx(0, false), tx(290, true)]);
  assert.equal(buckets.length, 30);
  // first bucket: 1 pass → rate 1; last bucket: 1 fail → rate 0.
  assert.deepEqual(buckets[0], { tot: 1, fail: 0, rate: 1 });
  assert.deepEqual(buckets[29], { tot: 1, fail: 1, rate: 0 });
  // at least one interior empty bucket has rate === null (NOT carried forward).
  const empties = buckets.filter((b) => b.tot === 0);
  assert.ok(empties.length > 0, 'has empty buckets');
  for (const b of empties) assert.equal(b.rate, null);
});

test('passTrend on the empty set returns []', () => {
  assert.deepEqual(passTrend([]), []);
});

test('passTrend rate = pass/(pass+fail) for mixed buckets', () => {
  // All at the same instant → all land in bucket 0 (span clamps to 1).
  const buckets = passTrend([tx(0, false), tx(0, false), tx(0, true)]);
  assert.equal(buckets[0]!.tot, 3);
  assert.equal(buckets[0]!.fail, 1);
  assert.equal(buckets[0]!.rate, 2 / 3);
});

// ── scope totals ────────────────────────────────────────────────────────────

test('scopeTotals reports scoped / withFailures / distinctIssues', () => {
  const scoped = [tx(0, false), tx(1, true), tx(2, true)];
  const totals = scopeTotals(scoped, 4 /* distinct sig count passed in */);
  assert.deepEqual(totals, { scoped: 3, withFailures: 2, distinctIssues: 4 });
});

// ── window-aware source counts (not narrowed by the selected source) ────────

test('sourceCounts over the window show ALL sources, regardless of selected source', () => {
  // The handler counts sources over the WINDOW-only set (scopeTransmissions with
  // source='all'), so the dropdown lists every in-window source even when one is
  // selected. Simulate that window set here.
  const windowSet = [
    { transfer_src: 'org.kano' },
    { transfer_src: 'org.kano' },
    { transfer_src: 'org.lagos' },
    { transfer_src: null }, // unknown bucket
  ];
  const counts = sourceCounts(windowSet);
  const byKey = Object.fromEntries(counts.map((c) => [c.source, c.count]));
  assert.equal(byKey['org.kano'], 2);
  assert.equal(byKey['org.lagos'], 1);
  assert.equal(byKey[''], 1, 'unknown bucket counted');
  // Three distinct sources present even though a real request might select one.
  assert.equal(counts.length, 3);
});
