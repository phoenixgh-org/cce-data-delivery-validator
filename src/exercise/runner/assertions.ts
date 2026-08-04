/**
 * The runner's ASSERTION half (8qa.2) — pure, so it runs in `npm test`.
 *
 * Nothing here opens a socket. The live half (./client.ts) turns each
 * materialized POST into an HTTP round trip and comes back with two facts: the
 * status the ingest endpoint returned, and the transmission id it minted (or
 * `null` when the §6 pipeline halted before persistence). Those facts, plus the
 * findings the dashboard API reports per transmission, are all the grading needs
 * — which is what lets the grading be tested against synthetic inputs with no
 * server present.
 *
 * TWO ASSERTIONS PER CASE:
 *
 *   1. STATUS, per POST and in order — an exact match against
 *      `ExercisePost.expectedStatus` (DESIGN.md §6).
 *   2. FINDINGS, PRESENCE-BASED and POOLED PER CASE — see
 *      {@link ExerciseCase.expectedFindings}, which is the contract this
 *      implements: each expected `(requirement, severity)` pair must appear at
 *      least once among the findings attributable to the case's POSTs, and a
 *      pooled finding the case never named does NOT fail it.
 *
 * ATTRIBUTION is by transmission id: the ingest response names the row it wrote,
 * and the dashboard API reports findings against that same id, so a case's pool
 * is exactly the findings of the rows its own POSTs created. No timestamp
 * windows, no "everything since the last case" — the runner plays one shared
 * session, and only ids keep the cases from reading each other's evidence.
 */

import type { Severity } from '../../db/repository.js';
import { isAcceptedStatus, type ExerciseCase, type ExpectedFinding } from '../case.js';

/** A finding as the dashboard API reports it, reduced to the graded pair. */
export interface ObservedFinding {
  readonly requirement: string;
  readonly severity: Severity;
}

/** What one played POST came back with. */
export interface PostOutcome {
  /** The materialized POST's label (`MaterializedPost.label`). */
  readonly label: string;
  readonly expectedStatus: number;
  /** The status the live instance actually returned. */
  readonly status: number;
  /**
   * The transmission id the ingest response named, or `null` when the pipeline
   * halted before persistence (404/405) — those are graded by status alone.
   */
  readonly transmissionId: string | null;
}

/** Findings keyed by the transmission id they were recorded against. */
export type FindingsByTransmission = ReadonlyMap<string, readonly ObservedFinding[]>;

/** One case's grade. */
export interface CaseVerdict {
  readonly caseId: string;
  readonly title: string;
  readonly ok: boolean;
  /** One line per failed assertion, ready to print. Empty when `ok`. */
  readonly failures: readonly string[];
  readonly posts: readonly PostOutcome[];
  /** Every finding attributable to this case's POSTs, in POST order. */
  readonly pooled: readonly ObservedFinding[];
  /** Expected findings absent from {@link pooled} — the presence-check misses. */
  readonly missing: readonly ExpectedFinding[];
}

/** The `(requirement, severity)` pair a finding is matched on — never `detail`. */
export function findingKey(finding: ObservedFinding | ExpectedFinding): string {
  return `${finding.requirement}/${finding.severity}`;
}

/**
 * Gather the findings attributable to a case's POSTs, in POST order. POSTs that
 * persisted no row (`transmissionId === null`) contribute nothing, as do ids the
 * dashboard reports no findings for.
 */
export function poolCaseFindings(
  outcomes: readonly PostOutcome[],
  findingsByTransmission: FindingsByTransmission,
): ObservedFinding[] {
  const pooled: ObservedFinding[] = [];
  for (const outcome of outcomes) {
    if (outcome.transmissionId === null) continue;
    pooled.push(...(findingsByTransmission.get(outcome.transmissionId) ?? []));
  }
  return pooled;
}

/**
 * The expected findings NOT present in the pool, matched on `(requirement,
 * severity)`. Presence-based: an expectation listed twice is satisfied by one
 * pooled occurrence (it names a pair, not a count), and pooled findings the
 * expectations do not name are ignored entirely.
 */
export function missingFindings(
  expected: readonly ExpectedFinding[],
  pooled: readonly ObservedFinding[],
): ExpectedFinding[] {
  const present = new Set(pooled.map(findingKey));
  const seen = new Set<string>();
  const missing: ExpectedFinding[] = [];
  for (const want of expected) {
    const key = findingKey(want);
    if (present.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(want);
  }
  return missing;
}

/**
 * Grade one case from what its POSTs returned plus the session's findings.
 *
 * A count mismatch between the case's declared POSTs and the outcomes handed in
 * is itself a failure rather than an exception: the runner records an outcome for
 * every POST it sent, so a short list means a POST never completed, and the
 * verdict should say so alongside the rest of the run instead of aborting it.
 */
export function judgeCase(
  kase: ExerciseCase,
  outcomes: readonly PostOutcome[],
  findingsByTransmission: FindingsByTransmission,
): CaseVerdict {
  const failures: string[] = [];

  if (outcomes.length !== kase.posts.length) {
    failures.push(`played ${outcomes.length} of ${kase.posts.length} POST(s)`);
  }

  for (const outcome of outcomes) {
    if (outcome.status !== outcome.expectedStatus) {
      failures.push(
        `POST ${outcome.label}: expected HTTP ${outcome.expectedStatus}, got ${outcome.status}`,
      );
    }
  }

  const pooled = poolCaseFindings(outcomes, findingsByTransmission);
  const missing = missingFindings(kase.expectedFindings, pooled);
  for (const want of missing) {
    const observed = pooled.length === 0 ? 'none' : [...new Set(pooled.map(findingKey))].join(' ');
    failures.push(`missing finding §${want.requirement} ${want.severity} (observed: ${observed})`);
  }

  return {
    caseId: kase.id,
    title: kase.title,
    ok: failures.length === 0,
    failures,
    posts: outcomes,
    pooled,
    missing,
  };
}

/** Run-wide counts for the summary line. */
export interface RunTotals {
  readonly cases: number;
  readonly casesPassed: number;
  readonly casesFailed: number;
  readonly posts: number;
  /** POSTs the endpoint answered 2xx — the data was accepted. */
  readonly accepted: number;
  /** POSTs the endpoint refused (any non-2xx). */
  readonly rejected: number;
}

/** Tally the summary counts over every case verdict. */
export function tally(verdicts: readonly CaseVerdict[]): RunTotals {
  let posts = 0;
  let accepted = 0;
  let casesPassed = 0;
  for (const verdict of verdicts) {
    if (verdict.ok) casesPassed += 1;
    for (const outcome of verdict.posts) {
      posts += 1;
      if (isAcceptedStatus(outcome.status)) accepted += 1;
    }
  }
  return {
    cases: verdicts.length,
    casesPassed,
    casesFailed: verdicts.length - casesPassed,
    posts,
    accepted,
    rejected: posts - accepted,
  };
}
