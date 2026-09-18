/**
 * Scope helper tests (4h4.4) — PURE, no DB. Covers window parsing + default
 * fallback, the scope predicate (time bound + source filter), the engine.js
 * rollup/txFailing ports, scope totals, and window-aware source counts not
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
  rollup,
  scopeTotals,
  scopeTransmissions,
  txFailing,
  unitTotals,
  windowLowerBound,
} from './scope.js';
import { computeComplianceSummary } from './compliance-matrix.js';
import type { ComplianceRow } from './compliance-matrix.js';
import { sourceCounts } from './source.js';
import type { Profile } from '../schema-registry.js';

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

test('rollup folds pass-outdated into passing (2kx) — it must not fall out of every bucket', () => {
  const summary = computeComplianceSummary();
  const set = (req: string, status: ComplianceRow['status']) => {
    const row = summary.find((r) => r.requirement === req)!;
    (row as { status: ComplianceRow['status'] }).status = status;
  };
  set('1.2', 'pass');
  set('3.2', 'pass-outdated'); // validated, passed, but on an older schema version

  const r = rollup(summary);
  assert.equal(r.passing, 2, 'pass + pass-outdated');
  assert.equal(r.failing, 0);
  assert.equal(
    r.passing + r.failing + r.untested,
    r.gradeable,
    'every gradeable row lands in exactly one scorecard bucket',
  );
});

// ── txFailing (the contract verdict) ────────────────────────────────────────

/**
 * A finding fixture. Findings carry a requirement and a PROFILE because
 * `txFailing` is the contract verdict now (by1c.8), not a bare severity scan.
 */
const f = (severity: string, profile: Profile = '2025', requirement = '3.2') => ({
  requirement,
  severity,
  profile,
});

const tx = (mins: number, fail: boolean) => ({
  received_at: new Date(NOW + mins * 60 * 1000).toISOString(),
  findings: fail ? [f('fail')] : [f('pass')],
});

test('txFailing keys off a contract-profile severity===fail', () => {
  assert.equal(txFailing(tx(0, true)), true);
  assert.equal(txFailing(tx(0, false)), false);
  assert.equal(txFailing({ received_at: ago(0), findings: [f('info')] }), false);
});

/**
 * THE PROPERTY by1c.8 EXISTS FOR: a transmission that conforms under the
 * contract and fails only the DS01.3 shadow run is NOT a failing transmission.
 * Everything above the list — `withFailures` and the counts derived from it —
 * reads this predicate, so a leak here would restate a preview of the next
 * revision as a defect against the obligations in force.
 */
test('a shadow-only failure does not make a transmission failing', () => {
  const shadowOnly = {
    received_at: ago(0),
    findings: [f('pass'), f('fail', 'ds013', '5.3.2')],
  };
  assert.equal(txFailing(shadowOnly), false);
  assert.deepEqual(scopeTotals([shadowOnly], 0).withFailures, 0);
});

// ── scope totals ────────────────────────────────────────────────────────────

/** One `rtmd-report`-shaped report: AMID, the supplier-platform appliance id. */
const rtmdReport = (amid: unknown) => ({ AMID: amid, records: [] });

/** One `ems-report`-shaped report: ASER (with AMFR alongside), and no AMID. */
const emsReport = (amfr: unknown, aser: unknown) => ({ AMFR: amfr, ASER: aser, records: [] });

/** A transmission carrying an already-parsed body of `data[]` reports. */
const withReports = (...reports: unknown[]) => ({ body: { data: reports } });

test('scopeTotals reports scoped / withFailures / distinctIssues / units', () => {
  const scoped = [tx(0, false), tx(1, true), tx(2, true)];
  const totals = scopeTotals(scoped, 4 /* distinct sig count passed in */);
  // These fixtures carry no body at all, so the unit pair is the empty answer:
  // the verdict fixtures predate p98 and must keep meaning what they meant.
  assert.deepEqual(totals, {
    scoped: 3,
    withFailures: 2,
    distinctIssues: 4,
    units: 0,
    unidentifiedReports: 0,
  });
});

test('scopeTotals folds the unit pair off the bodies it was handed', () => {
  const totals = scopeTotals(
    [
      { ...tx(0, false), ...withReports(rtmdReport('fridge-1')) },
      { ...tx(1, true), ...withReports(rtmdReport('fridge-2')) },
      // Failing, and still a unit: the count is what was RECEIVED, not what passed.
      { ...tx(2, true), ...withReports(emsReport('Alpha', 'sn-9')) },
    ],
    0,
  );
  assert.equal(totals.units, 3);
  assert.equal(totals.withFailures, 2);
  assert.equal(totals.unidentifiedReports, 0);
});

// ── distinct CCE units (p98) ────────────────────────────────────────────────

test('unitTotals keys an EMS report on ASER, the appliance manufacturer serial', () => {
  assert.deepEqual(unitTotals([withReports(emsReport('Alpha Fridge, Inc', 'sn-1'))]), {
    units: 1,
    unidentifiedReports: 0,
  });
  assert.equal(unitTotals([withReports({ ASER: 'sn-1' })]).units, 1, 'AMFR need not be there');
});

test('unitTotals falls back to AMID when an RTMD report sent no serial', () => {
  assert.deepEqual(unitTotals([withReports(rtmdReport('fridge-1'))]), {
    units: 1,
    unidentifiedReports: 0,
  });
  // A null ASER is the ordinary shape, not an edge case: the schema types it
  // ["string","null"], so the fallback has to survive a present-but-null field.
  assert.equal(unitTotals([withReports({ AMID: 'fridge-1', ASER: null })]).units, 1);
});

/**
 * AMFR IS NOT PART OF THE KEY. The decision (p98, 2026-08-04) is that CCE
 * identity is the equipment id, and the serial carries that on its own here —
 * this counts identifier values as they arrived rather than trying to make them
 * globally unique. Two makers that both stamp a unit `sn-1` therefore collapse
 * into one unit, which is a known consequence, not an oversight.
 */
test('unitTotals ignores AMFR: the same ASER under two manufacturers is one unit', () => {
  const two = withReports(emsReport('Alpha', 'sn-1'), emsReport('Beta', 'sn-1'));
  assert.equal(unitTotals([two]).units, 1);
  // …and a missing manufacturer changes nothing either.
  const mixed = withReports(emsReport('Alpha', 'sn-1'), { ASER: 'sn-1' });
  assert.equal(unitTotals([mixed]).units, 1);
});

/**
 * ASER wins when both arrive. `rtmd-report` permits both, and the two live in
 * DIFFERENT NAMESPACES (a manufacturer serial vs a supplier-platform handle), so
 * the rule has to be fixed rather than "whichever is present" — otherwise one
 * appliance would key two ways across two reports from the same supplier.
 */
test('unitTotals prefers ASER when a report carries both identifiers', () => {
  const both = { AMID: 'fridge-1', AMFR: 'Alpha', ASER: 'sn-1' };
  assert.equal(unitTotals([withReports(both, emsReport('Alpha', 'sn-1'))]).units, 1);
  // The AMID on that report never becomes a second unit of its own — but a
  // SEPARATE report carrying only the supplier's id does, and that is the
  // disclosed limitation, not a bug: a passive receiver cannot reconcile the
  // two namespaces (resolving them is what a device-identity service is for).
  assert.equal(unitTotals([withReports(both, rtmdReport('fridge-1'))]).units, 2);
});

test('unitTotals treats blank, null, missing and non-string identifiers as unidentified', () => {
  const totals = unitTotals([
    withReports(
      rtmdReport('   '), // whitespace-only
      rtmdReport(''), // empty
      { AMID: null, ASER: null }, // both null (the adv.null_identity shape)
      { records: [] }, // neither sent
      rtmdReport(42), // not a string
      emsReport('Alpha', '  '), // blank serial, manufacturer present
    ),
  ]);
  assert.deepEqual(totals, { units: 0, unidentifiedReports: 6 });
});

test('unitTotals trims an identifier but does not case-fold it', () => {
  assert.equal(unitTotals([withReports({ ASER: ' sn-1 ' }, { ASER: 'sn-1' })]).units, 1);
  assert.equal(unitTotals([withReports({ ASER: 'sn-1' }, { ASER: 'SN-1' })]).units, 2);
  // The same rule on the fallback key.
  assert.equal(
    unitTotals([withReports(rtmdReport(' fridge-1 '), rtmdReport('fridge-1'))]).units,
    1,
  );
  assert.equal(unitTotals([withReports(rtmdReport('fridge-1'), rtmdReport('FRIDGE-1'))]).units, 2);
});

test('unitTotals dedupes within one transmission and across transmissions', () => {
  const within = withReports(rtmdReport('a'), rtmdReport('a'), rtmdReport('b'));
  assert.equal(unitTotals([within]).units, 2);
  const across = [
    withReports(rtmdReport('a')),
    withReports(rtmdReport('a')),
    withReports(rtmdReport('b')),
  ];
  assert.equal(unitTotals(across).units, 2);
});

test('unitTotals ignores a body that is not an object with an array data', () => {
  const empty = { units: 0, unidentifiedReports: 0 };
  assert.deepEqual(unitTotals([{ body: null }]), empty, 'unparsed body');
  assert.deepEqual(unitTotals([{}]), empty, 'no body at all');
  assert.deepEqual(unitTotals([{ body: 'not json' }]), empty);
  assert.deepEqual(unitTotals([{ body: [] }]), empty, 'array body is not an object');
  assert.deepEqual(unitTotals([{ body: { data: 'nope' } }]), empty);
  assert.deepEqual(unitTotals([{ body: { meta: {} } }]), empty, 'no data[]');
  assert.deepEqual(unitTotals([]), empty, 'empty scope');
  // Entries of data[] that are not report OBJECTS are not reports: skipped, not
  // counted as unidentified (the treatment null-identity.ts gives them).
  assert.deepEqual(unitTotals([withReports(null, 'x', 7, [])]), empty);
});

/**
 * The verdict is irrelevant by design. A schema-INVALID transmission still told
 * the receiving country which refrigerator the readings came from, and the
 * headline is "what was received" — not "what passed".
 */
test('unitTotals counts units regardless of verdict', () => {
  const failing = { ...tx(0, true), ...withReports(rtmdReport('fridge-1')) };
  assert.equal(txFailing(failing), true);
  assert.equal(unitTotals([failing]).units, 1);
});

/**
 * Scoping is the CALLER's job: the function is handed the already-narrowed set,
 * which is exactly how the window/source filter reaches this number.
 */
test('unit totals move with the scope because the scoped set is what is counted', () => {
  const all = [
    { received_at: ago(0), source: 'org.kano', ...withReports(rtmdReport('fridge-1')) },
    {
      received_at: ago(60 * 60 * 1000),
      source: 'org.kano',
      ...withReports(rtmdReport('fridge-2')),
    },
    { received_at: ago(0), source: 'org.lagos', ...withReports(rtmdReport('fridge-3')) },
  ];
  assert.equal(unitTotals(scopeTransmissions(all, 'all', 'all', NOW)).units, 3);
  // The 15m window drops the hour-old transmission…
  assert.equal(unitTotals(scopeTransmissions(all, '15m', 'all', NOW)).units, 2);
  // …and selecting one source drops the other's unit too.
  assert.equal(unitTotals(scopeTransmissions(all, '15m', 'org.kano', NOW)).units, 1);
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
