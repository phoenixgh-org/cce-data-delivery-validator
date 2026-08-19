/**
 * The Advisories surface — the fold, the labelling, and the COPY (pwd, bite bva
 * slice B).
 *
 * What is pinned here is the acceptance of the category's dashboard side, which
 * is a set of negative claims no type can hold:
 *
 *   1. A supplier at 100 % CONFORMANCE can carry advisories. The fold ignores
 *      verdict findings outright, so a session whose every finding passed still
 *      produces exactly its advisories and nothing that counts against it.
 *   2. NO ADVISORY COUNT FEEDS A VERDICT NUMBER. The surface folds itself, with
 *      sigKey's `requirement|code` shape reproduced locally, precisely BECAUSE
 *      `computeSignatures` excludes advisories (pwd NOTES, 2026-08-05) and must
 *      keep excluding them — admitting them would file advisories among the
 *      "distinct issues to fix" and feed the headline count.
 *   3. THE WORDING IS ACCEPTANCE, not polish. pwd's HONESTY section governs: we
 *      cannot prove a null means "no sensor fitted", since a broken sensor looks
 *      identical, so the prose must OBSERVE and never CONCLUDE — and the
 *      category name is closed ("Advisories", never a synonym, and never
 *      "warning" or "issue", which read as defects). Those are assertions below,
 *      not review notes.
 *
 * Pure functions only, like the other src/web tests — but unlike Setup.test.ts /
 * TransmissionsCard.test.ts this module pulls in no JSX-bearing sibling (it
 * imports types and one predicate from ./api), so it needs neither the global
 * React shim nor the dynamic import those files explain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAdvisory, type FindingView } from './api.js';
import {
  ADVISORY_COPY,
  advisoryKey,
  advisoryLabel,
  describeSpread,
  describeTally,
  foldAdvisories,
  splitFindings,
  type AdvisorySource,
} from './advisories.js';

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
 * left false. Constructed here rather than by registering a real check —
 * `ADVISORY_CHECKS` is empty until slice C, and the surface must not depend on
 * which checks exist.
 */
function advisory(id: string, over: Partial<FindingView> = {}): FindingView {
  return finding({ requirement: id, code: id, severity: 'info', ...over });
}

function tx(id: string, receivedAt: string, findings: FindingView[]): AdvisorySource {
  return { id, received_at: receivedAt, findings };
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

test('the fold keys on requirement|code — sigKey’s shape for a non-schema finding', () => {
  assert.equal(advisoryKey(advisory('adv.null_padding')), 'adv.null_padding|adv.null_padding');
  // A code-less finding still keys deterministically rather than colliding.
  assert.equal(advisoryKey({ requirement: 'adv.x', code: null }), 'adv.x|');
});

test('one advisory seen across transmissions folds into one row', () => {
  const groups = foldAdvisories([
    tx('t3', '2026-08-05T12:00:03Z', [advisory('adv.null_padding', { detail: 'newest' })]),
    tx('t2', '2026-08-05T12:00:02Z', [advisory('adv.null_padding', { detail: 'middle' })]),
    tx('t1', '2026-08-05T12:00:01Z', [advisory('adv.null_padding', { detail: 'oldest' })]),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.id, 'adv.null_padding');
  assert.equal(groups[0]?.label, 'Null padding');
  assert.equal(groups[0]?.count, 3);
  assert.equal(groups[0]?.txCount, 3);
  // Details are per-transmission, so the group shows the most recent one (the
  // surface labels it as such) rather than presenting one as if it spoke for all.
  assert.equal(groups[0]?.latestDetail, 'newest');
});

test('the representative is the newest occurrence whatever order it arrives in', () => {
  const groups = foldAdvisories([
    tx('t1', '2026-08-05T12:00:01Z', [advisory('adv.null_padding', { detail: 'oldest' })]),
    tx('t2', '2026-08-05T12:00:09Z', [
      advisory('adv.null_padding', { detail: 'newest', pointer: '/data/0/ASER' }),
    ]),
  ]);

  assert.equal(groups[0]?.latestDetail, 'newest');
  assert.equal(groups[0]?.latestPointer, '/data/0/ASER');
});

test('an unparsable timestamp never displaces the chosen representative', () => {
  const groups = foldAdvisories([
    tx('t1', '2026-08-05T12:00:01Z', [advisory('adv.null_padding', { detail: 'dated' })]),
    tx('t2', 'not-a-timestamp', [advisory('adv.null_padding', { detail: 'undated' })]),
  ]);

  assert.equal(groups[0]?.count, 2);
  assert.equal(groups[0]?.latestDetail, 'dated');
});

test('a 100 %-conformant session folds to its advisories and nothing else', () => {
  // Every graded finding passed — the supplier is at 100 % — and advisories ride
  // alongside. Nothing about them may read as a failure, so they neither borrow
  // a verdict nor drag one in: the fold sees only the adv.* findings.
  const groups = foldAdvisories([
    tx('t1', '2026-08-05T12:00:01Z', [
      finding({ requirement: '1.5' }),
      finding({ requirement: '3.2' }),
      advisory('adv.null_identity', { detail: 'only advisory' }),
    ]),
    tx('t2', '2026-08-05T12:00:02Z', [
      finding({ requirement: '1.5' }),
      finding({ requirement: '3.2' }),
    ]),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.id, 'adv.null_identity');
  assert.equal(groups[0]?.txCount, 1);
  // And a session with no advisories at all folds to an EMPTY surface, which is
  // what lets the card render nothing rather than an empty strip.
  assert.deepEqual(
    foldAdvisories([tx('t1', '2026-08-05T12:00:01Z', [finding(), finding({ severity: 'fail' })])]),
    [],
  );
});

test('groups are ordered most-observed first, ties broken by id', () => {
  const groups = foldAdvisories([
    tx('t1', '2026-08-05T12:00:01Z', [advisory('adv.zebra'), advisory('adv.null_padding')]),
    tx('t2', '2026-08-05T12:00:02Z', [advisory('adv.null_padding')]),
    tx('t3', '2026-08-05T12:00:03Z', [advisory('adv.alpha')]),
  ]);

  assert.deepEqual(
    groups.map((g) => g.id),
    ['adv.null_padding', 'adv.alpha', 'adv.zebra'],
  );
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

test('the spread and tally lines state the numbers and stop there', () => {
  const [group] = foldAdvisories([
    tx('t1', '2026-08-05T12:00:01Z', [advisory('adv.null_padding')]),
    tx('t2', '2026-08-05T12:00:02Z', [advisory('adv.null_padding')]),
  ]);
  assert.ok(group);

  assert.equal(describeSpread(group, 12), 'seen in 2 of 12 transmissions');

  const [lone] = foldAdvisories([tx('t1', '2026-08-05T12:00:01Z', [advisory('adv.null_padding')])]);
  assert.ok(lone);
  assert.equal(describeSpread(lone, 1), 'seen in 1 of 1 transmission');

  assert.equal(describeTally([group]), '1 advisory');
  assert.equal(describeTally([group, group]), '2 advisories');
  assert.equal(describeTally([]), '0 advisories');
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
