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
  auditAdvisoryCopy,
  auditLensRows,
  judgeCase,
  missingFindings,
  poolCaseFindings,
  tally,
  unexpectedFindings,
  type FindingsByTransmission,
  type LensSummaryRow,
  type ObservedFinding,
  type PostOutcome,
  type VerdictsByProfile,
  type VerdictsByTransmission,
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

// ── the advisory-copy audit (y0w4) ──────────────────────────────────────────

/**
 * One observed advisory, wired into a one-transmission finding map. The copy is
 * the subject here, so everything else is a default.
 */
function advisoryFindings(
  entries: readonly Partial<ObservedFinding>[],
): ReturnType<typeof findings> {
  return findings({
    'tx-1': entries.map((entry) => ({
      requirement: 'adv.null_padding',
      severity: 'info' as const,
      outdated: false,
      summary: 'A summary that observes and concludes nothing.',
      detail: 'Why a receiving country cares, in a sentence.',
      ...entry,
    })),
  });
}

test('a blank summary is a violation, and a served one that observes is clean', () => {
  const clean = auditAdvisoryCopy(advisoryFindings([{}]));
  assert.deepEqual(clean.violations, []);
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.notes, []);
  assert.equal(clean.observed, 1);

  const blank = auditAdvisoryCopy(advisoryFindings([{ summary: '   ' }]));
  assert.equal(blank.violations.length, 1);
  assert.match(blank.violations[0]!, /adv\.null_padding: summary is blank/);

  const noDetail = auditAdvisoryCopy(advisoryFindings([{ detail: '' }]));
  assert.deepEqual(noDetail.violations, ['adv.null_padding: detail is blank']);
});

test('the §7 findings a session also carries are not audited', () => {
  // The bar is the ADVISORY wording rule. A §3.2 fail is a verdict and is
  // supposed to read like one, so auditing it would fail every run on the
  // vocabulary its own copy is written in.
  const audit = auditAdvisoryCopy(
    findings({
      'tx-1': [{ requirement: '3.2', severity: 'fail', outdated: false, detail: 'invalid body' }],
    }),
  );
  assert.equal(audit.observed, 0);
  assert.deepEqual(audit.violations, []);
});

test('defect vocabulary in either piece of copy is a violation', () => {
  const inSummary = auditAdvisoryCopy(
    advisoryFindings([{ summary: '3 of 12 reports have an invalid serial number.' }]),
  );
  assert.equal(inSummary.violations.length, 1);
  assert.match(inSummary.violations[0]!, /summary reads as a defect/);

  const inDetail = auditAdvisoryCopy(
    advisoryFindings([{ detail: 'The supplier must correct this error.' }]),
  );
  assert.equal(inDetail.violations.length, 1);
  assert.match(inDetail.violations[0]!, /detail reads as a defect/);
});

test('the clause-1.8 phrase is exempt, so the approved rationale passes', () => {
  // "a delivery failure" names the circumstance requirements clause 1.8 allows a
  // retransmission after — a statement about the clause, not a verdict on the
  // payload. The exemption is removed before the bar is applied, so the same
  // sentence without the phrase still trips on "failure".
  const approved = auditAdvisoryCopy(
    advisoryFindings([
      {
        detail:
          'Countries should anticipate occasional duplicate transmissions, which ' +
          'requirements clause 1.8 allows after a delivery failure or on request.',
      },
    ]),
  );
  assert.deepEqual(approved.violations, []);

  const unexempt = auditAdvisoryCopy(
    advisoryFindings([{ detail: 'The report arrived after a transmission failure.' }]),
  );
  assert.equal(unexempt.violations.length, 1);
});

test('"error code" is exempt, so the approved EMS whitespace-LERR copy passes', () => {
  // "error code" names the LERR data object — the schema's own title for it is
  // "Logger Error Codes" — rather than grading the payload (xwgr). The approved
  // summary and detail are pinned verbatim in
  // src/ingest/stages/semantic/unexplained-null-temp.test.ts; what this holds is
  // that the LIVE audit agrees with them.
  const approved = auditAdvisoryCopy(
    advisoryFindings([
      {
        summary: 'Record 0 carries TVC null with LERR set to whitespace only.',
        detail:
          'A null temperature reading leaves the receiving country without the measurement ' +
          'that matters most, so what accompanies the null is what makes it interpretable. ' +
          'Which condition this advisory looks for depends on the report type. For an ' +
          '`ems-report` it is a null `TVC` whose logger error code is blank space: the schema ' +
          'accepts any one-character string as an error code, so this passes validation, but ' +
          'blank space explains nothing about why the reading is missing. A null reading with ' +
          'a real code names a sensor or logger condition; a null with blank space is ' +
          'indistinguishable from an unexplained gap. For an `rtmd-report`, `rtmd-record` ' +
          'allows a null `TVC` without tying it to anything that accounts for it, so these ' +
          'records are fully conformant. In both cases `TVC` is the most essential ' +
          'measurement for protecting vaccine health, so null values should be investigated ' +
          'to ensure proper device operation.',
      },
    ]),
  );
  assert.deepEqual(approved.violations, []);

  // The exemption is the phrase, not the word: "error" outside it still trips.
  const unexempt = auditAdvisoryCopy(
    advisoryFindings([{ detail: 'The logger reported an error beside the null reading.' }]),
  );
  assert.equal(unexempt.violations.length, 1);
});

test('no summary anywhere is an instance fact, not a run failure', () => {
  // The runner points at whatever instance the operator names, and one older
  // than the `summary` column serves findings without it. Reported, never failed
  // — and the detail bar still applies.
  const audit = auditAdvisoryCopy(
    advisoryFindings([{ summary: undefined }, { summary: undefined }]),
  );
  assert.deepEqual(audit.violations, []);
  assert.equal(audit.notes.length, 1);
  assert.match(audit.notes[0]!, /summary not served by this instance — 2 advisory finding\(s\)/);
});

test('some summaries served and some absent IS a violation', () => {
  // The column exists on this instance, so a row without copy is a row that lost
  // its copy — the regression the audit is for.
  const audit = auditAdvisoryCopy(
    advisoryFindings([{}, { requirement: 'adv.blank_admin', summary: undefined }]),
  );
  assert.deepEqual(audit.notes, []);
  assert.equal(audit.violations.length, 1);
  assert.match(audit.violations[0]!, /adv\.blank_admin: no summary served/);
});

test('an over-long summary is a warning and nothing more', () => {
  // Counts grow with the payload, so a well-written line can outgrow the mark
  // the copy is written to without anything being wrong with it.
  const long = `${'a'.repeat(95)}.`;
  const audit = auditAdvisoryCopy(advisoryFindings([{ summary: long }]));
  assert.deepEqual(audit.violations, []);
  assert.equal(audit.warnings.length, 1);
  assert.match(audit.warnings[0]!, /summary is 96 characters \(over 90\)/);
});

test('repeated occurrences collapse into one printable line and one violation', () => {
  // An advisory fires on every transmission that provokes it, with identical
  // wording. The report should show the sentence once, not fourteen times.
  const audit = auditAdvisoryCopy(
    findings({
      'tx-1': [
        {
          requirement: 'adv.null_padding',
          severity: 'info',
          outdated: false,
          summary: 'An invalid line.',
          detail: 'A rationale.',
        },
      ],
      'tx-2': [
        {
          requirement: 'adv.null_padding',
          severity: 'info',
          outdated: false,
          summary: 'An invalid line.',
          detail: 'A rationale.',
        },
      ],
    }),
  );
  assert.equal(audit.observed, 2);
  assert.deepEqual(audit.lines, [{ requirement: 'adv.null_padding', summary: 'An invalid line.' }]);
  assert.equal(audit.violations.length, 1);
});

// ── the grading-lens audit (tfnv.10) ────────────────────────────────────────

/**
 * Fixture rows for the DS01.3 package, small enough to read: the clause §1.4
 * folds onto, the clause the draft validator grades for itself, and a clause
 * nothing in these fixtures touches.
 */
function lensRows(fails: Record<string, number>): LensSummaryRow[] {
  return ['5.1.5', '5.3.2', '5.4.1'].map((requirement) => ({
    requirement,
    counts: { pass: 0, fail: fails[requirement] ?? 0, info: 0 },
  }));
}

function verdicts(entries: Record<string, VerdictsByProfile>): VerdictsByTransmission {
  return new Map(Object.entries(entries));
}

/** A §1.4 contract failure — the kind the clause map carries onto 5.1.5. */
const OVERSIZE: ObservedFinding = { requirement: '1.4', severity: 'fail', outdated: false };

/** A draft-lineage failure, already numbered in DS01.3. */
const ANNEX4: ObservedFinding = {
  requirement: '5.3.2',
  severity: 'fail',
  profile: 'ds013',
  outdated: false,
};

test('a lens row agreeing with the folded findings and the verdicts is clean', () => {
  const audit = auditLensRows(
    'ds013',
    lensRows({ '5.1.5': 1, '5.3.2': 1 }),
    findings({ 'tx-1': [OVERSIZE], 'tx-2': [ANNEX4] }),
    verdicts({ 'tx-1': { ds013: 'fail' }, 'tx-2': { ds013: 'fail' } }),
  );

  assert.deepEqual(audit.violations, []);
  assert.deepEqual(audit.notes, []);
  assert.equal(audit.rows, 3);
  assert.deepEqual(
    audit.failing.map((row) => [row.requirement, row.served, row.folded]),
    [
      ['5.1.5', 1, 1],
      ['5.3.2', 1, 1],
    ],
  );
});

test('a served count the findings do not support is a violation naming both numbers', () => {
  // The regression this exists for: the page adds up a clause differently from
  // the evidence beneath it. Both numbers are in the line, so the reader is not
  // left comparing the report with a dashboard.
  const audit = auditLensRows(
    'ds013',
    lensRows({ '5.1.5': 2 }),
    findings({ 'tx-1': [OVERSIZE] }),
    verdicts({ 'tx-1': { ds013: 'fail' } }),
  );

  assert.equal(audit.violations.length, 1);
  assert.match(audit.violations[0]!, /5\.1\.5: the ds013 summary reports 2 fail\(s\)/);
  assert.match(audit.violations[0]!, /fold 1 onto it/);
});

test('§3.2 is not carried onto the clause the draft re-runs for itself', () => {
  // The fold's own rule (src/api/lens.ts), asserted from the outside: a 2025
  // schema failure must NOT appear on 5.3.2, because the Annex 4 validator grades
  // that clause itself. A run whose only failure is §3.2 therefore expects an
  // all-zero DS01.3 summary — and a verdict of 'pass' or null to match.
  const audit = auditLensRows(
    'ds013',
    lensRows({}),
    findings({ 'tx-1': [{ requirement: '3.2', severity: 'fail', outdated: false }] }),
    verdicts({ 'tx-1': { ds013: 'pass' } }),
  );

  assert.deepEqual(audit.violations, []);
  assert.deepEqual(audit.failing, []);
});

test('evidence folding onto a clause the package does not serve is a violation', () => {
  const audit = auditLensRows(
    'ds013',
    [{ requirement: '5.3.2', counts: { pass: 0, fail: 0, info: 0 } }],
    findings({ 'tx-1': [OVERSIZE] }),
    verdicts({ 'tx-1': { ds013: 'fail' } }),
  );

  assert.equal(audit.violations.length, 1);
  assert.match(audit.violations[0]!, /5\.1\.5: 1 fail\(s\) fold onto a row the ds013 package/);
});

test('a row failure the transmission verdict denies is a violation, and so is the converse', () => {
  const denied = auditLensRows(
    'ds013',
    lensRows({ '5.1.5': 1 }),
    findings({ 'tx-1': [OVERSIZE] }),
    verdicts({ 'tx-1': { ds013: 'pass' } }),
  );
  assert.equal(denied.violations.length, 1);
  assert.match(denied.violations[0]!, /transmission tx-1 carries a 5\.1\.5 failure under ds013/);
  assert.match(denied.violations[0]!, /verdict is pass/);

  // The other direction: a supplier is told the draft fails this transmission
  // while no clause of the package carries the failure — a fail with nothing to
  // open.
  const unplaced = auditLensRows(
    'ds013',
    lensRows({}),
    findings({ 'tx-1': [] }),
    verdicts({ 'tx-1': { ds013: 'fail' } }),
  );
  assert.equal(unplaced.violations.length, 1);
  assert.match(unplaced.violations[0]!, /transmission tx-1 fails under ds013, but no row/);
});

test('a null verdict is not a fail, so a clean draft run raises nothing', () => {
  const audit = auditLensRows('ds013', lensRows({}), findings({ 'tx-1': [] }), verdicts({}));
  assert.deepEqual(audit.violations, []);
});

test('an instance that serves no rows or no verdicts is a note, never a failure', () => {
  // The same asymmetric tolerance the advisory audit has: a target older than the
  // lens (HTTP 400, so `null` rows) and a target older than per-profile verdicts
  // are facts about the target, not disagreements.
  const noLens = auditLensRows('ds013', null, findings({ 'tx-1': [OVERSIZE] }), verdicts({}));
  assert.deepEqual(noLens.violations, []);
  assert.equal(noLens.rows, 0);
  assert.match(noLens.notes[0]!, /ds013 lens is not served by this instance/);

  const noVerdicts = auditLensRows(
    'ds013',
    lensRows({ '5.1.5': 1 }),
    findings({ 'tx-1': [OVERSIZE] }),
    verdicts({ 'tx-1': {} }),
  );
  assert.deepEqual(noVerdicts.violations, []);
  assert.match(noVerdicts.notes[0]!, /no ds013 verdict served by this instance/);

  const noPackage = auditLensRows(null, null, findings({}), verdicts({}));
  assert.deepEqual(noPackage.violations, []);
  assert.match(noPackage.notes[0]!, /no second requirement package is registered/);
});

test('the contract lens counts its own lineage and nothing else', () => {
  // The audit is written over a lens parameter rather than over DS01.3, so the
  // contract package is auditable by the same rules. Under it a draft finding has
  // no row at all — which is the fold's identity case, and the reason the default
  // dashboard response never moved when the lens landed.
  const audit = auditLensRows(
    '2025',
    [
      { requirement: '1.4', counts: { pass: 0, fail: 1, info: 0 } },
      { requirement: '3.2', counts: { pass: 0, fail: 0, info: 0 } },
    ],
    findings({ 'tx-1': [OVERSIZE, ANNEX4] }),
    verdicts({ 'tx-1': { '2025': 'fail', ds013: 'fail' } }),
  );

  assert.deepEqual(audit.violations, []);
  assert.deepEqual(
    audit.failing.map((row) => row.requirement),
    ['1.4'],
  );
});
