/**
 * Unit tests for the runner's grading logic (8qa.2).
 *
 * These DO run in `npm test`: the assertions are pure functions over synthetic
 * outcomes and finding lists, so the rule that decides whether a live case
 * passed is exercised in CI where no server exists. What is NOT tested here is
 * the HTTP half (./client.ts) — that needs a live instance and belongs to
 * `npm run exercise`.
 *
 * The contract under test is `ExerciseCase.expectedFindings` (bd 27m):
 * PRESENCE-based, pooled per case, matched on `(requirement, severity)` plus the
 * `profile` and `outdated` qualifiers where an expectation names them — and, since
 * 496w, its complement `ExerciseCase.absentFindings`: the findings a case declares
 * its own pool must NOT carry, matched on `(requirement, profile)` alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExerciseCase } from '../case.js';
import {
  judgeCase,
  missingFindings,
  poolCaseFindings,
  tally,
  unexpectedFindings,
  type FindingsByTransmission,
  type ObservedFinding,
  type PostOutcome,
} from './assertions.js';

function post(overrides: Partial<PostOutcome> = {}): PostOutcome {
  return {
    label: '#0',
    expectedStatus: 200,
    status: 200,
    transmissionId: 'tx-1',
    ...overrides,
  };
}

function findings(entries: Record<string, readonly ObservedFinding[]>): FindingsByTransmission {
  return new Map(Object.entries(entries));
}

/** A one-POST case expecting a §3.2 pass. */
function singlePostCase(overrides: Partial<ExerciseCase> = {}): ExerciseCase {
  return {
    id: 'test-case',
    title: 'a synthetic case',
    requirements: ['3.2'],
    direction: 'pass',
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
    ...overrides,
  };
}

// ── pooling ─────────────────────────────────────────────────────────────────

test('a case pools the findings of every transmission its POSTs created', () => {
  const pooled = poolCaseFindings(
    [post({ transmissionId: 'tx-1' }), post({ label: '#1', transmissionId: 'tx-2' })],
    findings({
      'tx-1': [{ requirement: '1.8', severity: 'pass', outdated: false }],
      'tx-2': [{ requirement: '1.8', severity: 'fail', outdated: false }],
      // Another case's transmission — must never leak into this case's pool.
      'tx-9': [{ requirement: '3.2', severity: 'fail', outdated: false }],
    }),
  );
  assert.deepEqual(pooled, [
    { requirement: '1.8', severity: 'pass', outdated: false },
    { requirement: '1.8', severity: 'fail', outdated: false },
  ]);
});

test('a POST that persisted no row contributes nothing to the pool', () => {
  const pooled = poolCaseFindings(
    [post({ status: 405, expectedStatus: 405, transmissionId: null })],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass', outdated: false }] }),
  );
  assert.deepEqual(pooled, []);
});

// ── presence-based matching ─────────────────────────────────────────────────

test('an expected finding is satisfied by a pooled (requirement, severity) match', () => {
  const missing = missingFindings(
    [{ requirement: '1.2', severity: 'fail' }],
    [
      { requirement: '3.2', severity: 'pass', outdated: false },
      { requirement: '1.2', severity: 'fail', outdated: false },
    ],
  );
  assert.deepEqual(missing, []);
});

test('severity is part of the match — a pass does not satisfy an expected fail', () => {
  const missing = missingFindings(
    [{ requirement: '1.8', severity: 'fail' }],
    [{ requirement: '1.8', severity: 'pass', outdated: false }],
  );
  assert.deepEqual(missing, [{ requirement: '1.8', severity: 'fail' }]);
});

test('unlisted pooled findings never fail a case (presence, not exhaustiveness)', () => {
  const verdict = judgeCase(
    singlePostCase(),
    [post()],
    findings({
      'tx-1': [
        { requirement: '3.2', severity: 'pass', outdated: false },
        // Ancillary findings an accepted POST legitimately accumulates.
        { requirement: '1.2', severity: 'pass', outdated: false },
        { requirement: '3.1', severity: 'info', outdated: false },
        { requirement: '1.8', severity: 'pass', outdated: false },
      ],
    }),
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.failures, []);
});

test('a repeated expectation is satisfied once — it names a pair, not a count', () => {
  const missing = missingFindings(
    [
      { requirement: '3.2', severity: 'fail' },
      { requirement: '3.2', severity: 'fail' },
    ],
    [{ requirement: '3.2', severity: 'fail', outdated: false }],
  );
  assert.deepEqual(missing, []);
});

// ── the optional `outdated` matcher (73r) ───────────────────────────────────
//
// The modifier is a FILTER, not a key segment: an expectation that names it is
// satisfied only by a pooled finding carrying the same boolean, and one that
// leaves it unset matches either. That asymmetry is what lets the pass-outdated
// case assert `outdated: true` directly while the other forty cases, which never
// mention the flag, keep grading exactly as they did.

test('an expectation naming outdated: true is satisfied only by an outdated finding', () => {
  const want = { requirement: '3.2', severity: 'info', outdated: true } as const;
  assert.deepEqual(
    missingFindings([want], [{ requirement: '3.2', severity: 'info', outdated: true }]),
    [],
  );
  assert.deepEqual(
    missingFindings([want], [{ requirement: '3.2', severity: 'info', outdated: false }]),
    [want],
  );
});

test('an expectation naming outdated: false is satisfied only by a finding without the flag', () => {
  const want = { requirement: '3.2', severity: 'info', outdated: false } as const;
  assert.deepEqual(
    missingFindings([want], [{ requirement: '3.2', severity: 'info', outdated: false }]),
    [],
  );
  assert.deepEqual(
    missingFindings([want], [{ requirement: '3.2', severity: 'info', outdated: true }]),
    [want],
  );
});

test('an expectation that omits outdated is satisfied by a finding either way', () => {
  const want = { requirement: '3.2', severity: 'info' } as const;
  assert.deepEqual(
    missingFindings([want], [{ requirement: '3.2', severity: 'info', outdated: true }]),
    [],
  );
  assert.deepEqual(
    missingFindings([want], [{ requirement: '3.2', severity: 'info', outdated: false }]),
    [],
  );
});

test('two expectations differing only in outdated are graded separately', () => {
  // The dedupe key has to carry the demand: collapsing these onto the shared
  // triple would let the satisfied one answer for the unsatisfied one.
  const missing = missingFindings(
    [
      { requirement: '3.2', severity: 'info', outdated: true },
      { requirement: '3.2', severity: 'info', outdated: false },
    ],
    [{ requirement: '3.2', severity: 'info', outdated: true }],
  );
  assert.deepEqual(missing, [{ requirement: '3.2', severity: 'info', outdated: false }]);
});

test('a missing outdated expectation names the demand and what the pool carried', () => {
  const verdict = judgeCase(
    singlePostCase({
      expectedFindings: [{ requirement: '3.2', severity: 'info', outdated: true }],
    }),
    [post()],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'info', outdated: false }] }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0]!, /outdated=true/);
  assert.doesNotMatch(verdict.failures[0]!, /\+outdated/);
});

test('an empty expectation list passes whatever the pool holds', () => {
  const verdict = judgeCase(
    singlePostCase({ expectedFindings: [], posts: [{ expectedStatus: 405 }] }),
    [post({ expectedStatus: 405, status: 405, transmissionId: null })],
    findings({}),
  );
  assert.equal(verdict.ok, true);
});

// ── declared silence (496w) ─────────────────────────────────────────────────
//
// The complement of the presence rule, and deliberately NOT a step towards
// exhaustive matching: only the ids a case NAMES are judged, so a pooled finding
// nothing names is ignored exactly as it always was. Severity is not part of the
// key — a check that spoke at an unexpected severity still spoke.

test('a pooled finding a case declared absent fails it and names the finding', () => {
  const verdict = judgeCase(
    singlePostCase({ absentFindings: [{ requirement: 'adv.null_padding' }] }),
    [post()],
    findings({
      'tx-1': [
        { requirement: '3.2', severity: 'pass', outdated: false },
        { requirement: 'adv.null_padding', severity: 'info', outdated: false },
      ],
    }),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.unexpected, [
    { requirement: 'adv.null_padding', severity: 'info', outdated: false },
  ]);
  assert.equal(verdict.failures.length, 1);
  assert.match(
    verdict.failures[0]!,
    /unexpected finding §adv\.null_padding info \[2025\] — case declared it absent/,
  );
});

test('a case whose absent finding really is absent passes', () => {
  const verdict = judgeCase(
    singlePostCase({ absentFindings: [{ requirement: 'adv.null_padding' }] }),
    [post()],
    findings({
      'tx-1': [
        { requirement: '3.2', severity: 'pass', outdated: false },
        // A DIFFERENT advisory the case never named: presence-based grading is
        // untouched, so this must not fail anything.
        { requirement: 'adv.date_format', severity: 'info', outdated: false },
      ],
    }),
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unexpected, []);
});

test('severity is not part of the absence key — silent means silent', () => {
  assert.deepEqual(
    unexpectedFindings(
      [{ requirement: 'adv.sample_gap' }],
      [{ requirement: 'adv.sample_gap', severity: 'fail', outdated: false }],
    ),
    [{ requirement: 'adv.sample_gap', severity: 'fail', outdated: false }],
  );
});

test('a ds013 finding does not violate a contract absence, nor the other way round', () => {
  // The profile is part of the key for the same reason it is part of the
  // expectation key (by1c.15): one transmission carries findings of both
  // lineages, and a case asserting that the CONTRACT stayed quiet says nothing
  // about what an unpublished draft would have recorded.
  const shadowFinding = {
    requirement: '5.3.2',
    severity: 'fail',
    profile: 'ds013',
    outdated: false,
  } as const;
  const contractFinding = { requirement: '5.3.2', severity: 'fail', outdated: false } as const;

  assert.deepEqual(unexpectedFindings([{ requirement: '5.3.2' }], [shadowFinding]), []);
  assert.deepEqual(
    unexpectedFindings([{ requirement: '5.3.2', profile: 'ds013' }], [contractFinding]),
    [],
  );
  // Same lineage on both sides: the violation stands.
  assert.deepEqual(
    unexpectedFindings([{ requirement: '5.3.2', profile: 'ds013' }], [shadowFinding]),
    [shadowFinding],
  );
});

test('a case that declares no absences grades exactly as it did before (496w)', () => {
  // The whole table predates the field, so the undefined case is the one that
  // must not move: every pooled finding stays ignorable.
  const verdict = judgeCase(
    singlePostCase(),
    [post()],
    findings({
      'tx-1': [
        { requirement: '3.2', severity: 'pass', outdated: false },
        { requirement: 'adv.null_padding', severity: 'info', outdated: false },
        { requirement: '5.3.2', severity: 'fail', profile: 'ds013', outdated: false },
      ],
    }),
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.unexpected, []);
  assert.deepEqual(unexpectedFindings([], verdict.pooled), []);
});

test('every violating occurrence is reported, not one per absence', () => {
  const verdict = judgeCase(
    singlePostCase({
      posts: [{ expectedStatus: 200 }, { expectedStatus: 200 }],
      absentFindings: [{ requirement: 'adv.sample_gap' }],
    }),
    [post(), post({ label: '#1', transmissionId: 'tx-2' })],
    findings({
      'tx-1': [
        { requirement: '3.2', severity: 'pass', outdated: false },
        { requirement: 'adv.sample_gap', severity: 'info', outdated: false },
      ],
      'tx-2': [{ requirement: 'adv.sample_gap', severity: 'info', outdated: false }],
    }),
  );
  assert.equal(verdict.unexpected.length, 2, 'both POSTs drew the finding the case forbade');
  assert.equal(verdict.failures.length, 2);
});

// ── verdicts ────────────────────────────────────────────────────────────────

test('a status mismatch fails the case and names both statuses', () => {
  const verdict = judgeCase(
    singlePostCase(),
    [post({ label: 'replay', status: 422 })],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass', outdated: false }] }),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0]!, /replay/);
  assert.match(verdict.failures[0]!, /expected HTTP 200, got 422/);
});

test('a missing expected finding fails the case and reports what was observed', () => {
  const verdict = judgeCase(
    singlePostCase({ expectedFindings: [{ requirement: '1.2', severity: 'fail' }] }),
    [post()],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass', outdated: false }] }),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, [{ requirement: '1.2', severity: 'fail' }]);
  assert.match(verdict.failures[0]!, /missing finding §1\.2 fail/);
  assert.match(verdict.failures[0]!, /observed: 3\.2\/pass/);
});

test('a multi-POST case is judged on the pool of both POSTs, not on either alone', () => {
  const duplicateCase = singlePostCase({
    id: '1.8-fail-repeated-transfer-id',
    direction: 'fail',
    requirements: ['1.8'],
    posts: [
      { label: 'novel', expectedStatus: 200 },
      { label: 'replay', expectedStatus: 200 },
    ],
    expectedFindings: [
      { requirement: '1.8', severity: 'pass' },
      { requirement: '1.8', severity: 'fail' },
    ],
  });
  const outcomes = [
    post({ label: 'novel', transmissionId: 'tx-1' }),
    post({ label: 'replay', transmissionId: 'tx-2' }),
  ];
  const observed = findings({
    'tx-1': [{ requirement: '1.8', severity: 'pass', outdated: false }],
    'tx-2': [{ requirement: '1.8', severity: 'fail', outdated: false }],
  });

  assert.equal(judgeCase(duplicateCase, outcomes, observed).ok, true);

  // Drop the second POST's evidence: the pooled expectation must now miss.
  const halfObserved = findings({
    'tx-1': [{ requirement: '1.8', severity: 'pass', outdated: false }],
  });
  const verdict = judgeCase(duplicateCase, outcomes, halfObserved);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, [{ requirement: '1.8', severity: 'fail' }]);
});

test('fewer outcomes than declared POSTs is itself a failure', () => {
  const verdict = judgeCase(
    singlePostCase({
      posts: [{ expectedStatus: 200 }, { expectedStatus: 200 }],
    }),
    [post()],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass', outdated: false }] }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0]!, /played 1 of 2 POST\(s\)/);
});

// ── totals ──────────────────────────────────────────────────────────────────

test('tally counts cases, POSTs and accepted vs rejected by actual status', () => {
  const passing = judgeCase(
    singlePostCase(),
    [post()],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass', outdated: false }] }),
  );
  const failing = judgeCase(
    singlePostCase({ id: 'other' }),
    [post({ status: 422 }), post({ label: '#1', expectedStatus: 413, status: 413 })],
    findings({}),
  );

  assert.deepEqual(tally([passing, failing]), {
    cases: 2,
    casesPassed: 1,
    casesFailed: 1,
    posts: 3,
    accepted: 1,
    rejected: 2,
  });
});
