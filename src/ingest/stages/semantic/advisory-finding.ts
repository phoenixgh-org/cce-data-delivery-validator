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
 * `summary` is optional for now because the checks are being converted one at a
 * time; a check that supplies none renders exactly as it did before, with the
 * rationale on the row and no expander.
 */
export interface AdvisoryInput {
  /** The `adv.*` id of the advisory being raised. */
  id: AdvisoryId;
  /** The one-line observation, with its numbers. Shown on the advisory row. */
  summary?: string;
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
    summary: input.summary ?? null,
    detail: input.detail,
    pointer: input.pointer ?? null,
    code: input.id,
  };
}
