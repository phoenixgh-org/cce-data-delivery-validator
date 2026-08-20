/**
 * ADVISORIES — the dashboard's non-verdict helpers (owning issue: pwd, bite bva
 * slice B; reshaped by agj.16). Pure browser-side functions: no fetch, no React,
 * no DOM, and no backend import (`isAdvisory` is mirrored in ./api for exactly
 * that reason).
 *
 * An advisory is an observation about a payload that is fully schema-compliant
 * AND fully requirement-compliant — there is no requirement it violates, so
 * there is no verdict to render. The governing constraint of the whole category
 * is that it must NEVER move a requirement's pass/fail status, which means the
 * dashboard side has its own obligation: a supplier sitting at 100 % conformant
 * must be able to carry advisories with nothing on the page reading as a failure
 * or a defect. So nothing here feeds a pass/fail number, a conformance
 * percentage, or the distinct-issues headline.
 *
 * THE FOLD IS GONE, AND THAT IS THE POINT. This module used to fold advisory
 * findings itself (`foldAdvisories`/`advisoryKey`/`describeSpread`) because
 * `computeSignatures()` excluded advisories outright — it gates on `isIssue()`
 * (only `fail`, or `info` AND `outdated`) and a plain-info advisory is neither.
 * Since agj.15 the SERVER rolls an advisory signature — `kind: 'advisory'`,
 * keyed `adv|<adv.id>`, `req` the '' sentinel — so the `?signatureKey=` list
 * cross-filter can be driven from one, and since agj.16 the dashboard renders
 * advisories from those server signatures (the Advisories section at the bottom
 * of ComplianceCard). A second, differently-keyed browser fold would have been a
 * second source of truth, so it was deleted rather than kept in parallel.
 *
 * What has NOT changed is the exclusion that matters: an advisory signature
 * never enters `distinctIssues`, `signaturesForReq`, or any verdict count,
 * because filing an advisory among the "distinct issues to fix" is precisely
 * what this category exists to avoid.
 *
 * What remains here is what the server signature cannot supply: the
 * per-transmission partition ({@link splitFindings}), the label derivation for a
 * raw finding ({@link advisoryLabel}), and the copy ({@link ADVISORY_COPY}).
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

import { ADVISORY_PREFIX, isAdvisory, type FindingView } from './api';

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
 *
 * `columnSubhead` is that claim compressed to ONE line, for the Advisories
 * section HEADER in the compliance column (agj.16) — the same slot the §7 group
 * headers give `CLASS_META[…].blurb`, and the only advisory copy still on screen
 * when the section is collapsed. It carries the half a supplier reading a column
 * of verdicts needs first: this section is not one of them and feeds no count.
 * `blurb` still renders in full directly above the rows, so the §1.4 argument is
 * never the thing that got cut. (`latestEyebrow` retired with the browser-side
 * fold — the section renders server signatures, which carry no representative
 * detail to caveat.)
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
  /** One-line framing beside the Advisories section header in the compliance column. */
  columnSubhead: 'Not verdicts — nothing here counts for or against your conformance',
  /** Sub-heading for the per-transmission block in the transmission detail. */
  transmissionEyebrow: 'Advisories · not graded, and not counted in the findings above',
} as const;
