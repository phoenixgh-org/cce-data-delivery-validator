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

import { foldUnderLens, type LensFinding } from '../../api/lens.js';
import type { Verdict } from '../../api/verdicts.js';
import type { Severity } from '../../db/repository.js';
import {
  ADVISORY_COPY_BANNED_WORDS,
  ADVISORY_COPY_EXEMPT_PHRASES,
  isAdvisoryId,
} from '../../ingest/stages/semantic/advisory-finding.js';
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
  /**
   * The one-line observation an advisory carries (agj.17), as the instance served
   * it. Optional, and left `undefined` when the wire carried no string — see
   * {@link auditAdvisoryCopy} for why the absent case is not collapsed to `''`.
   *
   * NOT part of {@link findingKey} and deliberately absent from
   * `ExpectedFinding`: the copy is prose a grader may reword, so a case matching
   * on it would fail on an edit that changed no behaviour. It is audited
   * run-wide instead.
   */
  readonly summary?: string;
  /** The rationale behind the advisory row's expander. Optional like {@link summary}. */
  readonly detail?: string;
  /**
   * The stable check code the finding carries, where it carries one (tfnv.10).
   * NOT part of {@link findingKey} and absent from `ExpectedFinding`: a case
   * matches on the requirement it exercises, not on the check that produced it.
   *
   * It is read for one thing only — {@link auditLensRows}, where the DS01.3 fold
   * routes a §3.1 finding onto clause 5.3.5 or 5.3.3 by its code — so a finding
   * served without it folds exactly as the server folds a finding with none.
   */
  readonly code?: string | null;
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

// ── the advisory-copy audit (y0w4) ──────────────────────────────────────────

/**
 * Roughly the length an advisory `summary` is written to (advisory-finding.ts).
 * A longer one is reported, never failed: the counts a summary carries grow with
 * the payload, so a run against a bigger body can push a well-written line past
 * the mark without anything being wrong with it.
 */
const SUMMARY_LENGTH_HINT = 90;

/** One advisory id and the summary an instance served with it, for printing. */
export interface AdvisoryCopyLine {
  readonly requirement: string;
  /** The summary as served, or `undefined` when none came back. */
  readonly summary?: string;
}

/**
 * What {@link auditAdvisoryCopy} found: the copy worth printing, plus what is
 * wrong with it, split by how much it should cost the run.
 */
export interface CopyAudit {
  /** How many advisory findings the session carried — occurrences, not ids. */
  readonly observed: number;
  /** One entry per distinct `(id, summary)` pair, in first-seen order. */
  readonly lines: readonly AdvisoryCopyLine[];
  /** Copy defects. A non-empty list fails the run. */
  readonly violations: readonly string[];
  /** Copy worth a second look that fails nothing — today, over-long summaries. */
  readonly warnings: readonly string[];
  /** Facts about the target instance rather than about its copy. */
  readonly notes: readonly string[];
}

/** Remove the exempt phrases, then ask whether the banned vocabulary remains. */
function readsAsDefect(copy: string): boolean {
  let bare = copy;
  for (const phrase of ADVISORY_COPY_EXEMPT_PHRASES) bare = bare.split(phrase).join(' ');
  return ADVISORY_COPY_BANNED_WORDS.test(bare);
}

/** Collapse repeats without reordering: the same defect fires once per transmission. */
function distinct(lines: readonly string[]): string[] {
  return [...new Set(lines)];
}

/**
 * Audit the ADVISORY COPY a live instance actually served — a run-wide
 * invariant, not a per-case expectation (y0w4).
 *
 * Every advisory finding in the session is held to three things: `summary` is a
 * non-blank string, `detail` is a non-blank string, and neither reads as a
 * defect ({@link ADVISORY_COPY_BANNED_WORDS}, with the clause-1.8 exemption
 * applied first). That is the same bar the per-check copy tests hold each
 * check's own prose to; what this adds is the rest of the path — repository
 * INSERT, SELECT, `toFindingView`, the dashboard API — which no pure test can
 * reach without a running instance.
 *
 * TOLERANCE, and why it is asymmetric. The runner points at whatever instance
 * the operator names, which may predate the `summary` column. If NO observed
 * advisory carries a summary, that is a fact about the instance: it is reported
 * as a note and fails nothing. If SOME carry one and some do not, the column is
 * there and a row went out without copy — which is a violation, and exactly the
 * regression the audit exists to catch. `detail` has no such tolerance: it has
 * been served for as long as findings have.
 *
 * Pure, like everything else in this module: it reads the same finding map the
 * case grading reads, so the rule itself is exercised in CI against synthetic
 * findings.
 */
export function auditAdvisoryCopy(findingsByTransmission: FindingsByTransmission): CopyAudit {
  const advisories: ObservedFinding[] = [];
  for (const findings of findingsByTransmission.values()) {
    for (const finding of findings) {
      if (isAdvisoryId(finding.requirement)) advisories.push(finding);
    }
  }

  const lines: AdvisoryCopyLine[] = [];
  const seenLines = new Set<string>();
  for (const found of advisories) {
    const key = `${found.requirement} ${found.summary ?? ''}`;
    if (seenLines.has(key)) continue;
    seenLines.add(key);
    lines.push(
      found.summary === undefined
        ? { requirement: found.requirement }
        : { requirement: found.requirement, summary: found.summary },
    );
  }

  const violations: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  // The instance-fact branch: no summary anywhere. Say so once, grade nothing on
  // a field this target does not have, and still hold `detail` to the bar below.
  const servesSummary = advisories.some((found) => found.summary !== undefined);
  if (advisories.length > 0 && !servesSummary) {
    notes.push(
      `summary not served by this instance — ${advisories.length} advisory finding(s), ` +
        `none carrying the field`,
    );
  }

  for (const found of advisories) {
    const id = found.requirement;

    if (servesSummary) {
      if (found.summary === undefined) {
        violations.push(`${id}: no summary served, while other advisories carry one`);
      } else if (found.summary.trim().length === 0) {
        violations.push(`${id}: summary is blank`);
      } else {
        if (readsAsDefect(found.summary)) {
          violations.push(`${id}: summary reads as a defect: ${found.summary}`);
        }
        if (found.summary.length > SUMMARY_LENGTH_HINT) {
          warnings.push(
            `${id}: summary is ${found.summary.length} characters ` +
              `(over ${SUMMARY_LENGTH_HINT}): ${found.summary}`,
          );
        }
      }
    }

    if (found.detail === undefined || found.detail.trim().length === 0) {
      violations.push(`${id}: detail is blank`);
    } else if (readsAsDefect(found.detail)) {
      violations.push(`${id}: detail reads as a defect: ${found.detail}`);
    }
  }

  return {
    observed: advisories.length,
    lines,
    violations: distinct(violations),
    warnings: distinct(warnings),
    notes,
  };
}

// ── the grading-lens audit (tfnv.10) ────────────────────────────────────────

/**
 * The per-lineage verdicts one transmission carries on the wire (by1c.9), keyed
 * by profile id. A key is absent when the instance knows no such lineage — which
 * is a fact about the target, not a defect, and {@link auditLensRows} reads it
 * that way.
 */
export type VerdictsByProfile = Partial<Record<Profile, Verdict>>;

/** Wire verdicts keyed by the transmission id they were reported against. */
export type VerdictsByTransmission = ReadonlyMap<string, VerdictsByProfile>;

/** One `summary` row as the session read serves it: the id, and its live counts. */
export interface LensSummaryRow {
  /** Requirement id under the contract lens, clause id under the draft lens. */
  readonly requirement: string;
  readonly counts: { readonly pass: number; readonly fail: number; readonly info: number };
}

/** One row's fail count as served, beside what the session's own findings say. */
export interface LensRowAudit {
  readonly requirement: string;
  /** `counts.fail` as the row came off the wire. */
  readonly served: number;
  /** Fail findings the session's findings fold onto the row, recomputed here. */
  readonly folded: number;
  /** Transmission ids contributing at least one of them, in read order. */
  readonly transmissions: readonly string[];
}

/** What {@link auditLensRows} found, in the shape {@link CopyAudit} established. */
export interface LensAudit {
  /** The package the rows were read under, or `null` when none was registered. */
  readonly lens: Profile | null;
  /** How many rows the read served, or 0 when it served none. */
  readonly rows: number;
  /** Rows carrying a failure on either side, in served order — the print list. */
  readonly failing: readonly LensRowAudit[];
  /** Disagreements. A non-empty list fails the run. */
  readonly violations: readonly string[];
  /** Facts about the target instance rather than about its numbers. */
  readonly notes: readonly string[];
}

/** An observed finding as the read-time fold consumes it. */
function asLensFinding(found: ObservedFinding): LensFinding {
  return {
    requirement: found.requirement,
    severity: found.severity,
    profile: profileOf(found),
    outdated: found.outdated,
    code: found.code ?? null,
  };
}

/**
 * Audit the SUMMARY ROWS a live instance served under one lens against the
 * per-transmission evidence it served beside them (tfnv.10).
 *
 * WHY THIS IS A LIVE CHECK. The fold itself (src/api/lens.ts) and the verdict
 * rule (src/api/verdicts.ts) are pure and unit-tested. What no pure test reaches
 * is the path between them on a real instance: the scoping, the join onto the
 * selected package's matrix, the serialization, and the fact that the numbers a
 * supplier reads on one page are the same numbers the rows beneath them carry. A
 * lens that dropped a clause, scoped the fold differently from the list, or
 * counted a re-run §3.2 result onto 5.3.2 would show up here and nowhere else.
 *
 * THREE DISAGREEMENTS, all reported as violations:
 *
 *   1. A served row's `counts.fail` differs from the number of fail findings the
 *      session's own findings fold onto it.
 *   2. A fail folds onto a row the selected package does not serve — a clause
 *      with evidence and no line on the page.
 *   3. A transmission contributing a failure to a row whose verdict under this
 *      lens is not 'fail', or a transmission whose verdict IS 'fail' with no row
 *      of the package carrying it. Both directions matter: the first would grade
 *      a row off traffic the page calls clean, the second would fail a supplier
 *      with nothing to point at.
 *
 * TOLERANCE, asymmetric like {@link auditAdvisoryCopy}'s. The runner points at
 * whatever instance the operator names. One that does not know the lens serves no
 * rows (`served` is `null`, the read having been refused), and one that predates
 * per-profile verdicts serves none for this lineage: each is reported as a note
 * and grades nothing. An instance that serves SOME verdicts under the lens and
 * not others is held to rule 3 in full — that is the regression this exists to
 * catch, not an older target.
 *
 * Pure, like the rest of this module: it reads the same two maps ./client.ts
 * brings back, so the rules are exercised in CI against synthetic rows.
 */
export function auditLensRows(
  lens: Profile | null,
  served: readonly LensSummaryRow[] | null,
  findingsByTransmission: FindingsByTransmission,
  verdictsByTransmission: VerdictsByTransmission,
  contract: Profile = CONTRACT_PROFILE,
): LensAudit {
  const violations: string[] = [];
  const notes: string[] = [];

  // Two ways there is nothing to audit, and they are different facts: the
  // registry holds no second package at all, or this target does not serve the
  // one it holds. Neither is a disagreement, so both are notes.
  if (lens === null) {
    notes.push('no second requirement package is registered — no lens to audit');
    return { lens, rows: 0, failing: [], violations, notes };
  }

  if (served === null) {
    notes.push(`the ${lens} lens is not served by this instance — no rows to audit`);
    return { lens, rows: 0, failing: [], violations, notes };
  }

  // Folded per transmission rather than over the whole pool, so a row's failure
  // can be attributed back to the rows the verdicts are reported on.
  const folded = new Map<string, { fails: number; transmissions: string[] }>();
  for (const [id, findings] of findingsByTransmission) {
    const { counts } = foldUnderLens(findings.map(asLensFinding), lens, contract);
    for (const [row, tallied] of Object.entries(counts)) {
      if (tallied.fail === 0) continue;
      const bucket = folded.get(row) ?? { fails: 0, transmissions: [] };
      bucket.fails += tallied.fail;
      bucket.transmissions.push(id);
      folded.set(row, bucket);
    }
  }

  const failing: LensRowAudit[] = [];
  const servedRows = new Set(served.map((row) => row.requirement));
  for (const row of served) {
    const here = folded.get(row.requirement);
    const foldedFails = here?.fails ?? 0;
    if (row.counts.fail !== foldedFails) {
      violations.push(
        `${row.requirement}: the ${lens} summary reports ${row.counts.fail} fail(s), ` +
          `the session's findings fold ${foldedFails} onto it`,
      );
    }
    if (row.counts.fail > 0 || foldedFails > 0) {
      failing.push({
        requirement: row.requirement,
        served: row.counts.fail,
        folded: foldedFails,
        transmissions: here?.transmissions ?? [],
      });
    }
  }

  for (const [row, here] of folded) {
    if (servedRows.has(row)) continue;
    violations.push(
      `${row}: ${here.fails} fail(s) fold onto a row the ${lens} package does not serve`,
    );
  }

  // Rule 3, and the instance-fact branch in front of it: a target reporting no
  // verdict at all under this lineage is older than per-profile verdicts, not
  // wrong about them.
  const gradesLens = [...verdictsByTransmission.values()].some((v) => lens in v);
  if (verdictsByTransmission.size > 0 && !gradesLens) {
    notes.push(
      `no ${lens} verdict served by this instance — ${verdictsByTransmission.size} ` +
        'transmission(s), none carrying one',
    );
  } else {
    for (const [row, here] of folded) {
      for (const id of new Set(here.transmissions)) {
        const reported = verdictsByTransmission.get(id)?.[lens];
        if (reported === 'fail') continue;
        violations.push(
          `transmission ${id} carries a ${row} failure under ${lens}, but its ${lens} ` +
            `verdict is ${reported ?? 'null'}`,
        );
      }
    }
    const carried = new Set([...folded.values()].flatMap((here) => here.transmissions));
    for (const [id, verdicts] of verdictsByTransmission) {
      if (verdicts[lens] !== 'fail' || carried.has(id)) continue;
      violations.push(
        `transmission ${id} fails under ${lens}, but no row of that package carries its failure`,
      );
    }
  }

  return { lens, rows: served.length, failing, violations: distinct(violations), notes };
}
