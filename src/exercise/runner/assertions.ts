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
 * THREE ASSERTIONS PER CASE:
 *
 *   1. STATUS, per POST and in order — an exact match against
 *      `ExercisePost.expectedStatus` (DESIGN.md §6).
 *   2. FINDINGS, PRESENCE-BASED and POOLED PER CASE — see
 *      {@link ExerciseCase.expectedFindings}, which is the contract this
 *      implements: each expected `(requirement, severity)` pair — narrowed by the
 *      `profile` and `outdated` qualifiers where the case names them — must
 *      appear at least once among the findings attributable to the case's POSTs,
 *      and a pooled finding the case never named does NOT fail it.
 *   3. SILENCE, for the findings a case NAMES as absent (496w) — see
 *      {@link ExerciseCase.absentFindings}. A pooled finding matching an absent
 *      entry on `(requirement, profile)` — severity is not part of that key —
 *      fails the case. This is the complement of rule 2, not a retreat from it:
 *      only named ids are judged, so an unnamed one is still ignored.
 *
 * ATTRIBUTION is by transmission id: the ingest response names the row it wrote,
 * and the dashboard API reports findings against that same id, so a case's pool
 * is exactly the findings of the rows its own POSTs created. No timestamp
 * windows, no "everything since the last case" — the runner plays one shared
 * session, and only ids keep the cases from reading each other's evidence.
 */

import type { Severity } from '../../db/repository.js';
import { CONTRACT_PROFILE, type Profile } from '../../schema-registry.js';
import {
  isAcceptedStatus,
  type AbsentFinding,
  type ExerciseCase,
  type ExpectedFinding,
} from '../case.js';

/** A finding as the dashboard API reports it, reduced to the graded facts. */
export interface ObservedFinding {
  readonly requirement: string;
  readonly severity: Severity;
  /**
   * The lineage that graded it (by1c.15). Optional on the OBSERVED side because
   * the field is read off a live instance's JSON: an instance older than by1c.5
   * serves findings without it, and the runner should grade such a response as
   * a contract-only one rather than fail every case on a missing key. See
   * {@link profileOf} for the default and why it is not a literal.
   */
  readonly profile?: Profile;
  /**
   * The `outdated` MODIFIER the finding carries (73r) — today set only by the
   * schema stage, on a body that validates against a registered-but-older
   * version. Required here, unlike {@link profile}: absence on the wire has one
   * unambiguous reading (`false`, i.e. not flagged), so ./client.ts normalizes it
   * at the boundary and the grading never has to ask a second question. Contrast
   * `profile`, where absence means "an instance that does not know about
   * lineages" and the default has to be read off the registry.
   */
  readonly outdated: boolean;
}

/**
 * The lineage a finding belongs to, defaulted. Absent means the CONTRACT
 * profile, read from the registry rather than written as '2025': which profile
 * is the contract is a single flip point (src/schema-registry.ts), and a literal
 * here would silently start defaulting to the shadow lineage on the day it moves.
 */
export function profileOf(finding: ObservedFinding | ExpectedFinding | AbsentFinding): Profile {
  return finding.profile ?? CONTRACT_PROFILE;
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
  /**
   * Pooled findings the case declared ABSENT (496w) — the silence-check
   * violations, in pool order. Empty for a case that declares no absences, which
   * is every case written before `absentFindings` existed.
   */
  readonly unexpected: readonly ObservedFinding[];
}

/**
 * The `(requirement, severity, profile)` triple a finding is matched on — never
 * `detail`. The profile joined the key with shadow grading (by1c.15): a
 * transmission now carries findings of two lineages at once, and matching
 * without it would let a contract expectation be satisfied by a draft finding.
 */
export function findingKey(finding: ObservedFinding | ExpectedFinding): string {
  return `${finding.requirement}/${finding.severity}/${profileOf(finding)}`;
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
 * The DEDUPE key for one expectation: the triple, plus the `outdated` demand
 * when it makes one. Not the same thing as {@link findingKey} — two expectations
 * that agree on the triple but disagree on the modifier are different demands,
 * and collapsing them would let the first one answer for the second.
 */
function expectationKey(want: ExpectedFinding): string {
  return `${findingKey(want)}/${want.outdated ?? 'any'}`;
}

/**
 * One pooled finding as a failure message renders it: the matched triple, with
 * the `outdated` modifier appended only when it is set. A case that missed an
 * `outdated: true` expectation has to be able to see, from the line alone,
 * whether the §3.2 info it did observe carried the flag.
 */
function describeFinding(found: ObservedFinding): string {
  return found.outdated ? `${findingKey(found)}+outdated` : findingKey(found);
}

/**
 * The expected findings NOT present in the pool, matched on the `(requirement,
 * severity, profile)` triple {@link findingKey} builds, plus the OPTIONAL
 * `outdated` modifier (73r). Presence-based: an expectation listed twice is
 * satisfied by one pooled occurrence (it names a demand, not a count), and pooled
 * findings the expectations do not name are ignored entirely.
 *
 * `outdated` is a FILTER, not a key segment, because it is optional on the
 * expectation side and absent means "do not care". An expectation that sets it is
 * satisfied only by a pooled finding carrying the same boolean; one that leaves it
 * unset matches either, which is what keeps every case written before this field
 * existed grading exactly as it did.
 */
export function missingFindings(
  expected: readonly ExpectedFinding[],
  pooled: readonly ObservedFinding[],
): ExpectedFinding[] {
  const seen = new Set<string>();
  const missing: ExpectedFinding[] = [];
  for (const want of expected) {
    const key = expectationKey(want);
    if (seen.has(key)) continue;
    seen.add(key);
    const wanted = findingKey(want);
    const satisfied = pooled.some(
      (found) =>
        findingKey(found) === wanted &&
        (want.outdated === undefined || found.outdated === want.outdated),
    );
    if (!satisfied) missing.push(want);
  }
  return missing;
}

/**
 * The pooled findings a case declared ABSENT, in pool order (496w) — the mirror
 * of {@link missingFindings}, and the implementation of
 * {@link ExerciseCase.absentFindings}.
 *
 * Matched on `(requirement, profile)` ONLY: severity is deliberately not part of
 * the key, because an absence says a check stayed quiet and a check that spoke
 * at another severity still spoke. Everything else about the pool is unchanged —
 * a finding no absence names is ignored exactly as before, so the presence rule
 * (bd 27m) is untouched.
 *
 * Every violating occurrence is returned, not one per absence: the pool is a
 * case's own transmissions, so two occurrences are two records the supplier can
 * be pointed at, and de-duplicating them would hide the second.
 */
export function unexpectedFindings(
  absent: readonly AbsentFinding[],
  pooled: readonly ObservedFinding[],
): ObservedFinding[] {
  if (absent.length === 0) return [];
  const forbidden = new Set(absent.map((want) => `${want.requirement}/${profileOf(want)}`));
  return pooled.filter((found) => forbidden.has(`${found.requirement}/${profileOf(found)}`));
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
    const observed =
      pooled.length === 0 ? 'none' : [...new Set(pooled.map(describeFinding))].join(' ');
    const demand = want.outdated === undefined ? '' : ` outdated=${want.outdated}`;
    failures.push(
      `missing finding §${want.requirement} ${want.severity} [${profileOf(want)}]${demand} ` +
        `(observed: ${observed})`,
    );
  }

  // The silence half (496w). A case failing only here is an ordinary case
  // failure — no new summary category, and the line says which finding the case
  // declared absent so the reader is not left comparing two lists.
  const unexpected = unexpectedFindings(kase.absentFindings ?? [], pooled);
  for (const found of unexpected) {
    failures.push(
      `unexpected finding §${found.requirement} ${found.severity} [${profileOf(found)}] — ` +
        `case declared it absent`,
    );
  }

  return {
    caseId: kase.id,
    title: kase.title,
    ok: failures.length === 0,
    failures,
    posts: outcomes,
    pooled,
    missing,
    unexpected,
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
