/**
 * The Advisories helpers — the partition, the labelling, and the COPY (pwd, bite
 * bva slice B; trimmed by agj.16).
 *
 * What is pinned here is the acceptance of the category's dashboard side, which
 * is a set of negative claims no type can hold:
 *
 *   1. A supplier at 100 % CONFORMANCE can carry advisories. Nothing on the
 *      dashboard turns one into a number that counts against them.
 *   2. NO ADVISORY COUNT FEEDS A VERDICT NUMBER. `computeSignatures` now rolls
 *      an advisory signature (agj.15) so ONE cross-filter serves both, but every
 *      count that grades a supplier filters it back out — `issueSignatures`
 *      server-side, `signaturesForReq` on both sides. Those exclusions are
 *      pinned in src/api/signatures.test.ts and ComplianceCard.test.ts; what is
 *      pinned HERE is the browser half that survived: the per-transmission
 *      partition and the copy.
 *   3. THE WORDING IS ACCEPTANCE, not polish. pwd's HONESTY section governs: we
 *      cannot prove a null means "no sensor fitted", since a broken sensor looks
 *      identical, so the prose must OBSERVE and never CONCLUDE — and the
 *      category name is closed ("Advisories", never a synonym, and never
 *      "warning" or "issue", which read as defects). Those are assertions below,
 *      not review notes.
 *
 * The browser-side FOLD this file used to exercise (`foldAdvisories`,
 * `advisoryKey`, `describeSpread`, `describeTally`) went with agj.16: the
 * dashboard renders the server's advisory signatures now, and a second,
 * differently-keyed fold would have been a second source of truth. Its coverage
 * moved to src/api/signatures.test.ts (the fold) and ComplianceCard.test.ts (the
 * surface).
 *
 * Pure functions only, like the other src/web tests — but unlike Setup.test.ts /
 * TransmissionsCard.test.ts this module pulls in no JSX-bearing sibling (it
 * imports types and one predicate from ./api), so it needs neither the global
 * React shim nor the dynamic import those files explain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAdvisory, type FindingView } from './api.js';
import { ADVISORY_COPY, advisoryLabel, splitFindings } from './advisories.js';

/** A §7 verdict finding — the kind that DOES carry a grade. */
function finding(over: Partial<FindingView> = {}): FindingView {
  return {
    requirement: '3.2',
    severity: 'pass',
    detail: null,
    pointer: null,
    outdated: false,
    keyword: null,
    instancePath: null,
    param: null,
    code: null,
    ...over,
  };
}

/**
 * An advisory as slice A's `advisory({id, detail, pointer})` helper emits one:
 * severity `info`, the `adv.*` id in BOTH `requirement` and `code`, `outdated`
 * left false. Constructed here rather than by running a real check — the surface
 * must not depend on which checks are registered.
 */
function advisory(id: string, over: Partial<FindingView> = {}): FindingView {
  return finding({ requirement: id, code: id, severity: 'info', ...over });
}

test('an adv.* id is an advisory and a §7 requirement id is not', () => {
  assert.equal(isAdvisory(advisory('adv.null_padding')), true);
  assert.equal(isAdvisory(advisory('adv.null_identity')), true);
  assert.equal(isAdvisory(finding({ requirement: '3.2' })), false);
  assert.equal(isAdvisory(finding({ requirement: '1.4' })), false);
  // The transport codes are not advisories either — they grade a requirement.
  assert.equal(isAdvisory(finding({ requirement: '1.5', code: 'tx.missing_charset' })), false);
});

test('splitFindings partitions wherever the advisories sit in the list', () => {
  // Per-transmission findings sort with localeCompare(numeric), which INCIDENTALLY
  // puts adv.* at the tail — nothing may depend on that, so put one first.
  const a = advisory('adv.null_padding');
  const p = finding({ requirement: '1.5' });
  const f = finding({ requirement: '3.2', severity: 'fail' });

  const split = splitFindings([a, p, f]);
  assert.deepEqual(split.advisories, [a]);
  assert.deepEqual(split.verdicts, [p, f]);

  // Same inputs, tail order: same partition, and each side keeps its own order.
  const tail = splitFindings([p, f, a]);
  assert.deepEqual(tail.advisories, [a]);
  assert.deepEqual(tail.verdicts, [p, f]);
});

test('advisoryLabel humanizes an id and leaves an unknown shape alone', () => {
  assert.equal(advisoryLabel('adv.null_padding'), 'Null padding');
  assert.equal(advisoryLabel('adv.null_identity'), 'Null identity');
  assert.equal(advisoryLabel('adv.payload.size'), 'Payload size');
  // Not an advisory id, or nothing after the prefix — returned verbatim, never
  // rendered as an empty label.
  assert.equal(advisoryLabel('3.2'), '3.2');
  assert.equal(advisoryLabel('adv.'), 'adv.');
});

/** Every user-facing string the surface renders, for the copy assertions below. */
const COPY = Object.values(ADVISORY_COPY);

test('the surface calls the category Advisories and uses no synonym', () => {
  // Naming is closed (Benson, 2026-08-04): "Advisories" in the dashboard, in the
  // finding prose, and in the code.
  assert.equal(ADVISORY_COPY.title, 'Advisories');
  for (const text of COPY) {
    assert.doesNotMatch(
      text,
      /data quality|practice note|observation/i,
      `surface copy must not rename the category: ${text}`,
    );
  }
});

test('the surface copy carries no defect vocabulary', () => {
  // "warning" and "issue" are named in the brief because they read as defects;
  // the rest are the same failure mode by another word. An advisory is raised
  // against a payload that broke NO rule, so any of these would be a false
  // statement about the supplier, not merely a harsh tone.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must|should)\b/i;
  for (const text of COPY) {
    assert.doesNotMatch(text, defectWords, `surface copy must not read as a defect: ${text}`);
  }
});

test('the surface copy states the non-verdict claim and leads with payload size', () => {
  // The first thing a supplier at 100 % conformance needs is that this changes
  // nothing about their grade...
  assert.match(ADVISORY_COPY.blurb, /not verdicts/i);
  assert.match(ADVISORY_COPY.blurb, /counts for or against your conformance/i);
  assert.match(ADVISORY_COPY.transmissionEyebrow, /not graded/i);
  // The compliance column's one-line subhead is the only advisory copy on screen
  // when the section is collapsed, so it carries the same claim on its own.
  assert.match(ADVISORY_COPY.columnSubhead, /not verdicts/i);
  assert.match(ADVISORY_COPY.columnSubhead, /counts for or against your conformance/i);
  // ...and the reason to care is the supplier's own bytes against the §1.4 cap —
  // actionable self-interest, which is the strongest framing available to us.
  assert.match(ADVISORY_COPY.blurb, /1 MB limit in §1\.4/);
});

test('the surface copy concludes nothing about the supplier’s equipment', () => {
  // We cannot prove a null means "no sensor fitted" — a genuinely broken sensor
  // looks identical from the receiving side — so the surface must not say it.
  for (const text of COPY) {
    assert.doesNotMatch(text, /sensor|fitted|equipment is|hardware/i, `copy concludes: ${text}`);
  }
});
