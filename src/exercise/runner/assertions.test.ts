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
 * PRESENCE-based, pooled per case, matched on `(requirement, severity)`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExerciseCase } from '../case.js';
import {
  judgeCase,
  missingFindings,
  poolCaseFindings,
  tally,
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
      'tx-1': [{ requirement: '1.8', severity: 'pass' }],
      'tx-2': [{ requirement: '1.8', severity: 'fail' }],
      // Another case's transmission — must never leak into this case's pool.
      'tx-9': [{ requirement: '3.2', severity: 'fail' }],
    }),
  );
  assert.deepEqual(pooled, [
    { requirement: '1.8', severity: 'pass' },
    { requirement: '1.8', severity: 'fail' },
  ]);
});

test('a POST that persisted no row contributes nothing to the pool', () => {
  const pooled = poolCaseFindings(
    [post({ status: 405, expectedStatus: 405, transmissionId: null })],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass' }] }),
  );
  assert.deepEqual(pooled, []);
});

// ── presence-based matching ─────────────────────────────────────────────────

test('an expected finding is satisfied by a pooled (requirement, severity) match', () => {
  const missing = missingFindings(
    [{ requirement: '1.2', severity: 'fail' }],
    [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '1.2', severity: 'fail' },
    ],
  );
  assert.deepEqual(missing, []);
});

test('severity is part of the match — a pass does not satisfy an expected fail', () => {
  const missing = missingFindings(
    [{ requirement: '1.8', severity: 'fail' }],
    [{ requirement: '1.8', severity: 'pass' }],
  );
  assert.deepEqual(missing, [{ requirement: '1.8', severity: 'fail' }]);
});

test('unlisted pooled findings never fail a case (presence, not exhaustiveness)', () => {
  const verdict = judgeCase(
    singlePostCase(),
    [post()],
    findings({
      'tx-1': [
        { requirement: '3.2', severity: 'pass' },
        // Ancillary findings an accepted POST legitimately accumulates.
        { requirement: '1.2', severity: 'pass' },
        { requirement: '3.1', severity: 'info' },
        { requirement: '1.8', severity: 'pass' },
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
    [{ requirement: '3.2', severity: 'fail' }],
  );
  assert.deepEqual(missing, []);
});

test('an empty expectation list passes whatever the pool holds', () => {
  const verdict = judgeCase(
    singlePostCase({ expectedFindings: [], posts: [{ expectedStatus: 405 }] }),
    [post({ expectedStatus: 405, status: 405, transmissionId: null })],
    findings({}),
  );
  assert.equal(verdict.ok, true);
});

// ── verdicts ────────────────────────────────────────────────────────────────

test('a status mismatch fails the case and names both statuses', () => {
  const verdict = judgeCase(
    singlePostCase(),
    [post({ label: 'replay', status: 422 })],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass' }] }),
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
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass' }] }),
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
    'tx-1': [{ requirement: '1.8', severity: 'pass' }],
    'tx-2': [{ requirement: '1.8', severity: 'fail' }],
  });

  assert.equal(judgeCase(duplicateCase, outcomes, observed).ok, true);

  // Drop the second POST's evidence: the pooled expectation must now miss.
  const halfObserved = findings({ 'tx-1': [{ requirement: '1.8', severity: 'pass' }] });
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
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass' }] }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0]!, /played 1 of 2 POST\(s\)/);
});

// ── totals ──────────────────────────────────────────────────────────────────

test('tally counts cases, POSTs and accepted vs rejected by actual status', () => {
  const passing = judgeCase(
    singlePostCase(),
    [post()],
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'pass' }] }),
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
