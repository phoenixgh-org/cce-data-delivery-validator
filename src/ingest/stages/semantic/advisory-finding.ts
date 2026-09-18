/**
 * THE ADVISORY FINDING CONSTRUCTOR — the leaf every advisory check imports.
 *
 * Why this is its own module and not part of advisory.ts (igw): advisory.ts is
 * the REGISTRY — it imports every check module to build `ADVISORY_CHECKS`. If it
 * also owned {@link advisory}, every check would import advisory.ts back, and
 * that mutual import is a real ESM cycle. The cycle used to be survivable only
 * because each check was written as a hoisted function declaration; a `const`
 * binding — the house idiom everywhere else in `semantic/` — sat in its temporal
 * dead zone when advisory.ts's module body built the array under the load order
 * an importer reaching a check module FIRST produces, and threw at load. Comments
 * were the only guard, on an idiom the next contributor had no reason to expect.
 *
 * Splitting the constructor out of the registry removes the cycle instead of
 * documenting it: checks import THIS module, advisory.ts imports the checks, and
 * the graph is one-way. advisory.ts re-exports everything here, so nothing
 * outside `semantic/` needs to know the split happened.
 *
 * The category itself — what an advisory is, the pass/fail constraint it must
 * never violate, the id shape, the wording rules — is documented in advisory.ts.
 */

import type { Finding } from '../../pipeline.js';

/** Namespace prefix separating advisory ids from the §7 requirement ids. */
export const ADVISORY_PREFIX = 'adv.';

/**
 * An advisory id, e.g. `adv.null_identity`. Carried in BOTH `finding.requirement`
 * (so the §7 matrix ignores it) and `finding.code` (so it de-duplicates).
 */
export type AdvisoryId = `${typeof ADVISORY_PREFIX}${string}`;

/**
 * Whether a `finding.requirement` (or `finding.code`) is an advisory id rather
 * than a §7 requirement id. Prefix-only, and unambiguous: every §7 id is
 * `MAJOR.MINOR` digits, so no requirement can ever start with `adv.`.
 */
export function isAdvisoryId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(ADVISORY_PREFIX);
}

/**
 * What a check supplies when it raises one advisory.
 *
 * TWO PIECES OF PROSE, not one (agj.17). An advisory used to carry a single
 * paragraph that fused what was seen with why it matters, which is the wrong
 * shape for a list a supplier scans:
 *
 *   - `summary` is THE OBSERVATION — one line, in the supplier's terms, carrying
 *     the numbers ("3 of 12 reports carry no appliance serial number"). It is
 *     what the advisory row shows, so keep it to roughly 90 characters.
 *   - `detail` is THE RATIONALE — why a receiving country cares, or what to send
 *     instead. A few sentences, shown behind the row's expander.
 *
 * Both OBSERVE, never conclude — see the wording note in advisory.ts's header.
 *
 * BOTH ARE REQUIRED. `summary` was optional while the twelve checks were being
 * converted one at a time (agj.17 slices A–C); every registered check now
 * supplies one, so a new check must too, and the compiler is what says so. The
 * RENDERING fallback stays regardless: `finding.summary` is nullable in the
 * database, and a row stored before the column existed still falls back to its
 * `detail` for the rest of the retention window.
 */
export interface AdvisoryInput {
  /** The `adv.*` id of the advisory being raised. */
  id: AdvisoryId;
  /** The one-line observation, with its numbers. Shown on the advisory row. */
  summary: string;
  /** The rationale: why the observation matters to the receiving country. */
  detail: string;
  /** JSON Pointer to where it was observed, for the raw-payload drill-down. */
  pointer?: string | null;
}

/**
 * Build one advisory {@link Finding}. This is the ONLY way advisories should be
 * constructed: it is what guarantees the three enforcement properties listed in
 * advisory.ts's header — `severity: 'info'`, the `adv.*` id in both `requirement`
 * and `code`, and `outdated` left false (never set here, so an advisory can never
 * be folded into the distinct-issues list).
 */
export function advisory(input: AdvisoryInput): Finding {
  return {
    requirement: input.id,
    severity: 'info',
    summary: input.summary,
    detail: input.detail,
    pointer: input.pointer ?? null,
    code: input.id,
  };
}

/**
 * THE WORDING BAR, as a regular expression — the vocabulary advisory copy may
 * never use (Benson, 2026-08-04). An advisory is raised against a payload that
 * broke no rule, so "warning", "issue", "error", "must" and their relatives
 * would be false statements about the supplier rather than merely a harsh tone.
 *
 * It lives here, beside {@link advisory}, because several different readers
 * enforce it and a second copy would let them drift: the per-check copy tests
 * hold each check's own `summary`/`detail` to it, the exercise runner audits the
 * copy a LIVE instance actually served (`src/exercise/runner/assertions.ts`), and
 * the dashboard surface-copy test holds the web surface copy to it
 * (`src/web/advisories.test.ts`). Nothing at ingest time reads it — the bar is an
 * assertion about prose a human wrote, not a filter applied to it.
 *
 * Every reader reaches it through {@link findAdvisoryCopyViolation} and its
 * boolean sugar {@link violatesAdvisoryCopyBar}, which are the single entry
 * point: the finder is the primitive — it strips the exempt phrases and returns
 * the offending word, for a caller that wants to name it — and the boolean is
 * that result reduced to a verdict. This constant is only half the bar, and a
 * reader that applies it on its own — without removing
 * {@link ADVISORY_COPY_EXEMPT_PHRASES} first — is enforcing a different rule
 * from the one a live run enforces.
 *
 * No `g` flag on purpose: a global regular expression carries `lastIndex` between
 * calls, and a shared one would then answer differently depending on who tested
 * a string last.
 */
export const ADVISORY_COPY_BANNED_WORDS =
  /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must)\b/i;

/**
 * Phrases removed from a piece of copy BEFORE {@link ADVISORY_COPY_BANNED_WORDS}
 * is applied to it, rather than words struck off the bar.
 *
 * The first entry: "a delivery failure" (agj.17, 2026-09-15) names the
 * circumstance requirements clause 1.8 allows a retransmission after. It is a
 * statement about that clause, not a verdict on the payload in hand, so the
 * approved rationale may carry it while "failure" stays banned everywhere else.
 *
 * "error code" / "error codes" (xwgr, 2026-09-18) sit on the same footing. They
 * name the LERR data object, which the schema itself titles "Logger Error
 * Codes" — the field the copy is reading, not a judgement on what it holds. The
 * approved copy for the EMS arm of `adv.unexplained_null_temp` observes that a
 * temperature reading is null and "the logger error code beside it is blank
 * space"; naming the object is the observation. "error" on its own stays banned.
 */
export const ADVISORY_COPY_EXEMPT_PHRASES: readonly string[] = [
  'a delivery failure',
  'error codes',
  'error code',
];

/**
 * {@link ADVISORY_COPY_BANNED_WORDS} widened with extra words, for a reader that
 * holds its own copy to a stricter bar than the shared one.
 *
 * Three copy tests ask for `should` on top of the shared list — the two identity
 * checks and the dashboard surface — because none of their approved prose has a
 * reason to recommend anything. `should` is deliberately NOT on the shared bar:
 * other rationales use it legitimately (sample_gap's "loggers should rarely
 * produce gaps", null_accumulator's "the period's total should be an explicit
 * 0"), so widening the constant itself would fail copy that is doing its job.
 *
 * Composing here rather than in each test keeps one list of banned words: a
 * word added to the shared bar reaches the stricter readers too (7qjf).
 */
/* At least one word, as a tuple type: composing with none would append an empty
 * alternative and match every string. */
export function advisoryCopyBannedWordsWith(...extraWords: [string, ...string[]]): RegExp {
  return new RegExp(
    `${ADVISORY_COPY_BANNED_WORDS.source}|\\b(?:${extraWords.join('|')})\\b`,
    ADVISORY_COPY_BANNED_WORDS.flags,
  );
}

/**
 * The first word in a piece of advisory copy that breaks the wording bar, or
 * `null` if none does: the one place the two halves of the bar are combined.
 *
 * The bar is {@link ADVISORY_COPY_BANNED_WORDS} applied to the copy with
 * {@link ADVISORY_COPY_EXEMPT_PHRASES} removed first, and a reader that keeps
 * only one half grades copy by a rule of its own. Both halves of that mistake
 * have happened: a per-check test spelled out its own shortened word list and
 * never stripped the exempt phrases, so the EMS arm of
 * `adv.unexplained_null_temp` passed its unit test and then failed the live
 * audit (agj.25). Route every reader through here, or through
 * {@link violatesAdvisoryCopyBar}, instead.
 *
 * The word is returned rather than only the verdict so a caller can name it in
 * a failure message, which is what kept one copy test on the raw constant
 * (agj.28). It is the match as it appears in the stripped copy, so a reader
 * reporting it should treat it as the word that offended, not as an offset into
 * the original string.
 *
 * `bar` defaults to the shared word list. A reader holding its own copy to a
 * stricter one passes the result of {@link advisoryCopyBannedWordsWith}, so the
 * exempt phrases are handled identically whichever list is in force.
 */
export function findAdvisoryCopyViolation(
  copy: string,
  bar: RegExp = ADVISORY_COPY_BANNED_WORDS,
): string | null {
  let bare = copy;
  for (const phrase of ADVISORY_COPY_EXEMPT_PHRASES) bare = bare.split(phrase).join(' ');
  return bar.exec(bare)?.[0] ?? null;
}

/**
 * Whether a piece of advisory copy breaks the wording bar — sugar over
 * {@link findAdvisoryCopyViolation} for the readers that want a verdict and not
 * the word. Both take the same optional `bar`.
 */
export function violatesAdvisoryCopyBar(
  copy: string,
  bar: RegExp = ADVISORY_COPY_BANNED_WORDS,
): boolean {
  return findAdvisoryCopyViolation(copy, bar) !== null;
}
