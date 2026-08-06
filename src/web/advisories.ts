/**
 * ADVISORIES — the dashboard's non-verdict projection (owning issue: pwd, bite
 * bva slice B). Pure browser-side functions: no fetch, no React, no DOM, and no
 * backend import (`isAdvisory` is mirrored in ./api for exactly that reason).
 *
 * An advisory is an observation about a payload that is fully schema-compliant
 * AND fully requirement-compliant — there is no requirement it violates, so
 * there is no verdict to render. The governing constraint of the whole category
 * is that it must NEVER move a requirement's pass/fail status, which means the
 * dashboard side has its own obligation: a supplier sitting at 100 % conformant
 * must be able to carry advisories with nothing on the page reading as a failure
 * or a defect. So nothing here feeds a pass/fail number, a conformance
 * percentage, or the distinct-issues headline; this module only folds advisory
 * findings for a surface of their own.
 *
 * WHY THE FOLD LIVES HERE rather than in src/api/signatures.ts. `sigKey()` does
 * key non-schema findings off `requirement|code`, which is all an advisory needs
 * — but `computeSignatures()` gates on `isIssue()`, which admits only `fail` or
 * (`info` AND `outdated`), so a plain-info advisory is deliberately EXCLUDED
 * from the signature fold and from `distinctIssues` (measured 2026-08-05, pinned
 * in src/api/sessions.test.ts, recorded in pwd's NOTES). That exclusion is the
 * design, not a gap: admitting advisories would file them in the "distinct
 * issues to fix" list and feed a headline count, which is precisely what this
 * category exists to avoid. {@link advisoryKey} therefore REPRODUCES sigKey's
 * non-schema arm here so the surface can de-duplicate itself. Do NOT "fix" this
 * by admitting advisories to computeSignatures.
 *
 * WORDING. Every string this module exports is user-facing, and wording is
 * acceptance rather than polish (pwd's HONESTY section): advisory prose must
 * OBSERVE, never CONCLUDE. We cannot prove a null means "no sensor fitted" — a
 * broken sensor looks identical — so the framing leads with the payload-size
 * argument, which is actionable self-interest, instead of a judgement about the
 * supplier's equipment. `advisories.test.ts` pins the copy against
 * defect-flavoured vocabulary; if a string here needs to say a supplier did
 * something wrong, it is the wrong string.
 */

import { ADVISORY_PREFIX, isAdvisory, type FindingView, type TransmissionView } from './api';

/** One advisory, folded across every transmission in the current scope. */
export interface AdvisoryGroup {
  /** De-duplication key, `requirement|code` — see {@link advisoryKey}. */
  key: string;
  /** The `adv.*` id (identical in `requirement` and `code`). */
  id: string;
  /** Human label derived from the id — see {@link advisoryLabel}. */
  label: string;
  /** How many advisory findings folded into this group. */
  count: number;
  /** How many distinct transmissions raised it. */
  txCount: number;
  /**
   * The `detail` of the MOST RECENT occurrence, or null when it carried none.
   * Details are per-transmission ("TCON was null in all 480 records of this
   * transmission"), so a folded group cannot show one detail as if it spoke for
   * all of them — the surface labels this as the most recent when `count > 1`.
   */
  latestDetail: string | null;
  /** JSON Pointer of that same most-recent occurrence, for the drill-down. */
  latestPointer: string | null;
}

/** The transmission fields the fold reads — a structural subset of TransmissionView. */
export type AdvisorySource = Pick<TransmissionView, 'id' | 'received_at' | 'findings'>;

/**
 * De-duplication key for an advisory: `requirement|code`, which is exactly what
 * `sigKey()` (src/api/signatures.ts) produces for a non-schema finding. Same
 * shape, computed here, because advisories never enter `computeSignatures` — see
 * the module header. Both halves are the same `adv.*` id today; keying off both
 * anyway keeps the key correct if a check ever narrows its code.
 */
export function advisoryKey(f: Pick<FindingView, 'requirement' | 'code'>): string {
  return `${f.requirement}|${f.code ?? ''}`;
}

/**
 * Human label for an advisory id: `adv.null_padding` → `Null padding`.
 *
 * Derived rather than looked up in a table (slice A deliberately shipped no
 * title table). The `adv.*` ids are hand-authored named codes — an advisory
 * catalogue has no external document to number against — so they already read as
 * words, and a derivation cannot go stale when the catalogue grows or leave a
 * new check rendering a raw id. An id that somehow arrives without the prefix is
 * returned verbatim rather than mangled.
 */
export function advisoryLabel(id: string): string {
  if (!id.startsWith(ADVISORY_PREFIX)) return id;
  const words = id.slice(ADVISORY_PREFIX.length).replaceAll('_', ' ').replaceAll('.', ' ').trim();
  if (words === '') return id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Split a transmission's findings into the ones that carry a verdict and the
 * advisories, preserving each side's relative order.
 *
 * EXPLICIT, not incidental. Per-transmission findings arrive sorted with
 * `localeCompare(…, {numeric:true})`, which happens to put `adv.*` after the
 * numeric §7 ids today — but that is a side effect of the sort, not a guarantee,
 * so nothing may rely on advisories being at the tail. This partition is the
 * only supported way to separate them.
 */
export function splitFindings(findings: readonly FindingView[]): {
  verdicts: FindingView[];
  advisories: FindingView[];
} {
  const verdicts: FindingView[] = [];
  const advisories: FindingView[] = [];
  for (const f of findings) {
    if (isAdvisory(f)) advisories.push(f);
    else verdicts.push(f);
  }
  return { verdicts, advisories };
}

/** Mutable accumulator behind {@link foldAdvisories}. */
interface Accumulator {
  id: string;
  count: number;
  txIds: Set<string>;
  latestDetail: string | null;
  latestPointer: string | null;
  /** Epoch ms of the occurrence `latestDetail`/`latestPointer` came from. */
  latestAt: number;
}

/**
 * Fold every advisory across the given (already scope-filtered) transmissions
 * into one group per {@link advisoryKey}. Verdict findings are ignored outright,
 * so a 100 %-conformant session folds to exactly its advisories and nothing else.
 *
 * ORDER IS STATED, not inherited: most-observed first, ties broken by id, so the
 * surface is stable across polls and never depends on the order findings happen
 * to arrive in. A transmission whose `received_at` does not parse never displaces
 * an already-chosen representative — the first occurrence seen (the API returns
 * transmissions newest-first) stands.
 */
export function foldAdvisories(transmissions: readonly AdvisorySource[]): AdvisoryGroup[] {
  const byKey = new Map<string, Accumulator>();

  for (const tx of transmissions) {
    const at = new Date(tx.received_at).getTime();
    const atKnown = Number.isFinite(at);
    for (const f of tx.findings) {
      if (!isAdvisory(f)) continue;
      const key = advisoryKey(f);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          id: f.requirement,
          count: 1,
          txIds: new Set([tx.id]),
          latestDetail: f.detail,
          latestPointer: f.pointer,
          latestAt: atKnown ? at : Number.NEGATIVE_INFINITY,
        });
        continue;
      }
      existing.count += 1;
      existing.txIds.add(tx.id);
      if (atKnown && at > existing.latestAt) {
        existing.latestDetail = f.detail;
        existing.latestPointer = f.pointer;
        existing.latestAt = at;
      }
    }
  }

  return [...byKey.entries()]
    .map(([key, acc]) => ({
      key,
      id: acc.id,
      label: advisoryLabel(acc.id),
      count: acc.count,
      txCount: acc.txIds.size,
      latestDetail: acc.latestDetail,
      latestPointer: acc.latestPointer,
    }))
    .sort((a, b) => (b.count - a.count !== 0 ? b.count - a.count : a.id.localeCompare(b.id)));
}

/**
 * The surface's user-facing copy, in one place so the wording can be pinned by
 * test (see the module header — wording is acceptance here, not polish).
 *
 * `title` is the closed category name: "Advisories", in the dashboard, in the
 * finding prose, and in the code (decided 2026-08-04). No synonyms, and never
 * "warning" or "issue", which read as defects.
 *
 * `blurb` states the non-verdict claim FIRST, because that is the thing a
 * supplier at 100 % conformance needs to know before reading anything below it,
 * and then gives the reason to care in terms of the supplier's own interest: the
 * bytes are theirs to spend against the §1.4 1 MB cap. It claims nothing about
 * what a null MEANS — that is unprovable from the receiving side, and saying it
 * would be the concluding language this category is forbidden.
 */
export const ADVISORY_COPY = {
  /** Card heading and the per-transmission section heading. */
  title: 'Advisories',
  /** The framing line under the heading. */
  blurb:
    'Advisories are not verdicts. Nothing here counts for or against your conformance — no ' +
    'advisory changes a requirement’s status or any number above. Each one names bytes you are ' +
    'spending against the 1 MB limit in §1.4, or something the payload alone leaves open to the ' +
    'country receiving your data.',
  /** Sub-heading for the per-transmission block in the transmission detail. */
  transmissionEyebrow: 'Advisories · not graded, and not counted in the findings above',
  /** Marks a folded group's representative detail when it stands for several occurrences. */
  latestEyebrow: 'most recent',
} as const;

/** `{n} advisories` — the count of DISTINCT advisories on the surface itself. */
export function describeTally(groups: readonly AdvisoryGroup[]): string {
  return `${groups.length} ${groups.length === 1 ? 'advisory' : 'advisories'}`;
}

/**
 * How widely one advisory was seen, e.g. `seen in 3 of 12 transmissions`. States
 * the spread and stops there: how much of a spread matters is the supplier's
 * call, not ours.
 */
export function describeSpread(group: AdvisoryGroup, total: number): string {
  const noun = total === 1 ? 'transmission' : 'transmissions';
  return `seen in ${group.txCount} of ${total} ${noun}`;
}
