/**
 * The compliance column: the ADVISORIES section (agj.16) and the two-sided
 * exclusion that lets it exist, then the card under a DRAFT grading lens
 * (tfnv.6).
 *
 * Advisories moved INTO the verdict column, which is the one place the category
 * has always been kept out of. That is safe only because the split is explicit
 * on both sides of the same signature set, and the claims below are exactly the
 * ones a reader cannot get from the types:
 *
 *   1. THE SECTION IS THE ONLY DOOR. `advisorySignatures` selects them and
 *      `signaturesForReq` refuses them, so an advisory can reach the column only
 *      as its own section — never as a requirement's "distinct issue", and never
 *      in the count beside a §7 row. The `kind` guard is asserted against a
 *      hostile advisory carrying a real requirement id (agj.19): `req` is '' in
 *      production and the equality alone would pass today, which is precisely
 *      why the guard needs a test that does not rely on the sentinel.
 *   2. PICKING ONE CROSS-FILTERS AND NOTHING ELSE. The rows are the same
 *      {@link SigRow} as a requirement's, so `onPick` hands the advisory
 *      Signature to `onSelectSignature` unchanged — the Dashboard then sets the
 *      list filter alone. It must not imply failures-only: an advisory-only
 *      transmission has zero failures and would vanish from its own cross-filter
 *      (pinned server-side in src/api/sessions.test.ts).
 *   3. NO STATUS COLOUR. An advisory carries `sev: 'info'`, which without a
 *      `kind` branch falls through to the `--mixed` amber that means
 *      *warning / outdated* everywhere else on this dashboard — "a lesser
 *      defect" on the one surface that must not say defect (`sigTone()` in
 *      ComplianceCard.tsx carries the full reasoning).
 *   4. EMPTY MEANS ABSENT. No advisories → the section returns null, header and
 *      all, so a conformant session's column looks exactly as it did before.
 *
 * THE CARD UNDER A DRAFT LENS (tfnv.6). Four claims, and the reason each needs a
 * test rather than a reading of the component:
 *
 *   5. THE GROUPING AXIS DOES NOT MOVE. All 27 DS01.3 clauses render, each in the
 *      group of the class the SERVER sent, and there is no sixth group — being
 *      added or tightened by the draft is an annotation, not a verifiability
 *      class (owner decision, tfnv.14). The case that decides it is 5.3.5: an
 *      added clause that IS fed, which an informational group would have hidden
 *      while it was failing. It is asserted to render among the Verified rows,
 *      with its counts.
 *   6. THE ANNOTATIONS ARE ON THE RIGHT ROWS. Six NEW and four TIGHTENED, joined
 *      against the served matrix rather than typed here, so re-pointing a clause
 *      moves the expectation with it.
 *   7. AN ADDED CLAUSE NOTHING FEEDS SAYS SO. Its drill-down opens with
 *      {@link NOT_FED_NOTE}; a fed one (5.3.5) does not, and neither does any row
 *      under the contract lens, whose rendering is asserted tag-free and
 *      unchanged.
 *   8. THE SIGNATURE SELECTION IS THE SERVER'S FOLD. `signaturesForReq` under a
 *      lens is held equal to `withRequirementUnderLens` (src/api/signatures.ts)
 *      on a fixture set, the clauseMap.test.ts pattern — the browser must not
 *      invent a second rule about which issues belong to a clause, because the
 *      key it hands to the cross-filter is what scopes the transmission list.
 *
 * THE TWO UNITS ON A ROW (vsy1). The server now serves both — `counts` in
 * distinct transmissions and `findings` in findings — and what a test has to
 * hold is which of them reaches which surface:
 *
 *   9. THE TALLY AND THE EVIDENCE LINE AGREE, IN TRANSMISSIONS. The collapsed
 *      "60f 13p" and the expanded "60 of 80 transmissions failing · 13 passing"
 *      are the same field, so a supplier cannot read one number closed and a
 *      different one open. The finding count (251) appears on neither.
 *  10. THE REMAINDER IS SERVED, NOT SUBTRACTED. On a collapsed DS01.3 clause
 *      `pass` and `fail` overlap, so `scope − pass − fail` is wrong and can go
 *      negative. The fixture makes them overlap and pins the rendered number to
 *      `notReached`. A row the server says nothing feeds shows no remainder at
 *      all, and a caller with no scope shows no denominator.
 *  11. THE FINDING COUNT SURVIVES, LABELLED. It sits beside the "Distinct issues"
 *      eyebrow saying the word "findings", which is the only place the per-error
 *      fan-out is still visible.
 *
 * Most of this file reaches pure functions only, the Setup.test.ts /
 * TransmissionsCard.test.ts pattern: {@link AdvisorySection} is hook-free by
 * design (its collapse state is the parent's), so it can be CALLED as a plain
 * function and its returned element tree walked for the rows. `ComplianceCard`
 * itself opens with `useState`, so the claims about the whole column use
 * `renderToStaticMarkup` — the same published-API-no-DOM escape Setup.test.ts
 * explains, and still no component-test harness and no jsdom. The global React
 * binding plus the dynamic import are that file's shim too: src/web has no jsx
 * tsconfig, so esbuild uses the classic `React.createElement` transform.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import type { ComplianceRow, Signature } from '../api';
import { CONTRACT_PROFILE } from '../api';
import { PROFILE_NAME } from '../profiles.js';
import { COMPLIANCE_MATRIX } from '../../api/compliance-matrix.js';
import { DS013_MATRIX } from '../../api/matrix-ds013.js';
import { clauseUnderLens as serverClauseUnderLens } from '../../api/lens.js';
import {
  signaturesForReq as serverSignaturesForReq,
  withRequirementUnderLens,
} from '../../api/signatures.js';
import { CLASS_META } from './ui/statusMaps.js';

(globalThis as unknown as { React: typeof React }).React = React;

const {
  AdvisoryRow,
  AdvisorySection,
  ComplianceCard,
  NOT_FED_NOTE,
  SigRow,
  advisorySignatures,
  isNewInDraft,
  rowTags,
  signaturesForReq,
  sigTone,
} = await import('./ComplianceCard.js');
const { renderToStaticMarkup } = await import('react-dom/server');

/** The draft package's id, as the session serves it in `lens`. */
const DRAFT = 'ds013';

/** A signature as the server rolls one; `over` states only what a test varies. */
function sig(over: Partial<Signature> = {}): Signature {
  return {
    key: '2025|3.2|required|/data|CID',
    req: '3.2',
    profile: '2025',
    title: 'Missing required property CID',
    kind: 'check',
    sev: 'fail',
    count: 3,
    txCount: 2,
    sourceCount: 1,
    first: '2026-08-19T12:00:00Z',
    last: '2026-08-20T12:00:00Z',
    examplePointer: null,
    ...over,
  };
}

/** An advisory signature: `kind: 'advisory'`, `adv|<id>` key, '' req, null profile, info sev. */
function adv(id: string, over: Partial<Signature> = {}): Signature {
  return sig({
    key: `adv|${id}`,
    req: '',
    profile: null,
    title: id,
    kind: 'advisory',
    sev: 'info',
    ...over,
  });
}

/** Every element of one component type in a returned tree, in render order. */
function elementsOfType(node: unknown, type: unknown): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!React.isValidElement(n)) return;
    if (n.type === type) found.push(n);
    walk((n.props as { children?: unknown }).children);
  };
  walk(node);
  return found;
}

/** Every SigRow element in a returned tree — the REQUIREMENT rows' issue rows. */
function sigRows(node: unknown): React.ReactElement[] {
  return elementsOfType(node, SigRow);
}

/** Every advisory row in a returned tree, in render order. */
function advisoryRows(node: unknown): React.ReactElement[] {
  return elementsOfType(node, AdvisoryRow);
}

/** The section's props, defaulted so each test states only what it varies. */
function section(
  signatures: Signature[],
  over: Partial<Parameters<typeof AdvisorySection>[0]> = {},
): ReturnType<typeof AdvisorySection> {
  return AdvisorySection({
    signatures,
    collapsed: false,
    onToggle: () => {},
    activeSignatureKey: null,
    ...over,
  });
}

/** One advisory row's markup, rendered on its own. */
function advisoryRowMarkup(
  sig: Signature,
  over: Partial<Parameters<typeof AdvisoryRow>[0]> = {},
): string {
  return renderToStaticMarkup(
    React.createElement(AdvisoryRow, {
      sig,
      expanded: true,
      onToggle: () => {},
      active: false,
      ...over,
    } as Parameters<typeof AdvisoryRow>[0]),
  );
}

test('the section renders one row per advisory, most-observed first', () => {
  const rows = advisoryRows(
    section([
      sig(),
      adv('adv.null_padding', { count: 2 }),
      adv('adv.date_format', { count: 9 }),
      sig({ key: '2025|1.5|tx.missing_charset', req: '1.5' }),
    ]),
  );

  assert.deepEqual(
    rows.map((r) => (r.props as { sig: Signature }).sig.key),
    ['adv|adv.date_format', 'adv|adv.null_padding'],
  );
  // And nothing renders through the requirement column's issue row any more
  // (synm): an advisory is an expandable row of its own, not a bare button.
  assert.deepEqual(sigRows(section([adv('adv.null_padding')])), []);
});

test('ties order by key, so the section does not reshuffle between polls', () => {
  // computeSignatures sorts on count alone; ties keep Map insertion order, which
  // follows whichever transmission happened to arrive first.
  const ordered = advisorySignatures([
    adv('adv.zebra', { count: 4 }),
    adv('adv.alpha', { count: 4 }),
  ]).map((s) => s.key);

  assert.deepEqual(ordered, ['adv|adv.alpha', 'adv|adv.zebra']);
  // Same set, opposite arrival order — same rendering.
  assert.deepEqual(
    advisorySignatures([adv('adv.alpha', { count: 4 }), adv('adv.zebra', { count: 4 })]).map(
      (s) => s.key,
    ),
    ordered,
  );
});

test('the "Matching transmissions" button hands the signature straight to onSelectSignature', () => {
  const picked: Signature[] = [];
  const advisory = adv('adv.null_identity');
  // AdvisoryRow is hook-free, so the expanded row can be CALLED and its one
  // control found in the returned tree — the click itself, not its plumbing.
  const tree = AdvisoryRow({
    sig: advisory,
    expanded: true,
    onToggle: () => {},
    active: false,
    onSelectSignature: (s: Signature) => picked.push(s),
  });
  const controls = elementsOfType(tree, 'button');
  assert.equal(controls.length, 1, 'exactly one control in the expanded row');
  (controls[0]?.props as { onClick: () => void }).onClick();

  // The whole Signature, unchanged — the Dashboard sets ?signatureKey= from its
  // `key` and touches nothing else. In particular no failuresOnly: an
  // advisory-only transmission has zero failures and would disappear from the
  // very filter this click just set.
  assert.deepEqual(picked, [advisory]);
});

test('the active row is the one whose key matches the cross-filter', () => {
  const rows = advisoryRows(
    section([adv('adv.null_padding', { count: 2 }), adv('adv.date_format', { count: 9 })], {
      activeSignatureKey: 'adv|adv.null_padding',
    }),
  );

  assert.deepEqual(
    rows.map((r) => (r.props as { active: boolean }).active),
    [false, true],
  );
});

/**
 * THE ROW IS A REQUIREMENT ROW'S SHAPE WITHOUT ITS VERDICT (synm).
 *
 * The shape is what a supplier reads first, so the two claims worth pinning are
 * the ones a glance at the component cannot settle: that the row aligns with the
 * requirement rows above it (the empty 42px id slot is what does that — an
 * advisory is a clause of nothing and has no id to print), and that borrowing
 * the shape brought none of the verdict with it.
 */
test('the collapsed row carries the label, the tx count and a neutral advisory tag', () => {
  const markup = advisoryRowMarkup(adv('adv.blank_admin', { txCount: 4 }), { expanded: false });

  assert.ok(markup.includes('data-req="adv.blank_admin"'), 'keyed by the advisory id');
  assert.ok(markup.includes('Blank admin'), 'the derived label, not the raw id');
  assert.ok(markup.includes('4 tx'), 'the transmission count');
  assert.ok(markup.includes('advisory'), 'the neutral tag');
  assert.ok(markup.includes('width:42px'), 'the empty id slot keeps the column width');
});

test('no verdict reaches the row: no pill, no pass/fail tally, no status colour', () => {
  const markup = advisoryRowMarkup(adv('adv.blank_admin', { txCount: 4, count: 9 }));

  for (const tone of ['--fail', '--pass', '--mixed']) {
    assert.ok(!markup.includes(tone), `${tone} must not reach an advisory row`);
  }
  // The StatusPill's words, and the requirement row's f/p/o tally.
  for (const word of ['untested', 'pass', 'fail', '9f', '4p']) {
    assert.ok(!markup.includes(word), `"${word}" must not reach an advisory row`);
  }
});

test('the expanded row shows the SERVED rationale and labels its control "Matching transmissions"', () => {
  const rationale = 'For an `ems-report` it reads 15 objects; `ASER` names the appliance.';
  const markup = advisoryRowMarkup(adv('adv.blank_admin', { rationale, txCount: 4 }));

  // The rationale, with its backticked identifiers as inline code rather than
  // the ticks a supplier would otherwise read as prose.
  assert.ok(markup.includes('<code'), 'backticked identifiers render as inline code');
  assert.ok(!markup.includes('`'), 'no backtick survives into the page');
  assert.ok(markup.includes('ems-report') && markup.includes('ASER'));
  assert.ok(markup.includes('15 objects'), 'the rest of the sentence is intact');

  assert.ok(markup.includes('Matching transmissions'));
  // NEVER the requirement block's label: that one names defects to fix, and an
  // advisory has none.
  assert.ok(!markup.includes('Distinct issues'));
  assert.ok(markup.includes('1 src'), 'the source count rides on the control');
});

test('an advisory the catalogue does not cover still renders its row', () => {
  // `rationale` is absent for an id the server's catalogue has no entry for; the
  // row is still the way into the cross-filter, so it must not collapse to
  // nothing.
  const markup = advisoryRowMarkup(adv('adv.not_in_catalogue', { txCount: 2 }));
  assert.ok(markup.includes('Not in catalogue'));
  assert.ok(markup.includes('Matching transmissions'));
});

test('a requirement never groups an advisory, sentinel or not', () => {
  // agj.19: `req` is '' in production, so the equality alone excludes advisories
  // today and this hostile case cannot arise — the point of the `kind` guard is
  // that it stays excluded if one is ever given a requirement to group under.
  const hostile = adv('adv.null_padding', { req: '3.2', profile: '2025' });
  const real = sig();

  assert.deepEqual(signaturesForReq([real, hostile], '3.2'), [real]);
  assert.deepEqual(signaturesForReq([adv('adv.null_padding')], ''), []);
  // And the section takes only the other half.
  assert.deepEqual(advisorySignatures([real, hostile]), [hostile]);
});

test('a requirement row never groups a SHADOW signature (by1c.7)', () => {
  // The §7 matrix grades the contract in force. A ds013 signature carrying a
  // clause id that collides with a §7 id is the case the profile filter exists
  // for — the requirement alone would admit it.
  const contract = sig();
  const shadow = sig({ key: 'ds013|3.2|required|/data|LSER', profile: 'ds013' });

  assert.deepEqual(signaturesForReq([contract, shadow], '3.2'), [contract]);
});

test('an advisory row takes the accent, never a status colour', () => {
  // sev is 'info' on every advisory, which is the --mixed amber for a verdict
  // signature (an outdated-schema §3.2 finding). Advisories must not borrow it.
  assert.equal(sigTone(adv('adv.null_padding')), 'var(--accent-text)');
  assert.equal(sigTone(sig({ sev: 'fail' })), 'var(--fail)');
  assert.equal(sigTone(sig({ sev: 'info' })), 'var(--mixed)');
});

test('no advisories renders no section at all — not an empty one', () => {
  assert.equal(section([]), null);
  assert.equal(section([sig(), sig({ key: '2025|1.5|tx.missing_charset', req: '1.5' })]), null);
  // Collapsed is a different thing from absent: the header still renders.
  assert.notEqual(section([adv('adv.null_padding')], { collapsed: true }), null);
  assert.deepEqual(advisoryRows(section([adv('adv.null_padding')], { collapsed: true })), []);
});

test('the open row is the one the shared expandedReq names, keyed by advisory id', () => {
  // The same state a requirement row uses, so the transmission detail's
  // cross-link opens an advisory through `onSelectReq` and needs no second
  // mechanism. `adv.*` ids cannot collide with clause ids.
  const toggled: (string | null)[] = [];
  const rows = advisoryRows(
    section([adv('adv.null_padding', { count: 2 }), adv('adv.date_format', { count: 9 })], {
      expandedReq: 'adv.null_padding',
      onToggleReq: (req: string | null) => toggled.push(req),
    }),
  );

  assert.deepEqual(
    rows.map((r) => (r.props as { expanded: boolean }).expanded),
    [false, true],
  );

  // Toggling the closed row opens it; toggling the open one closes it.
  (rows[0]?.props as { onToggle: () => void }).onToggle();
  (rows[1]?.props as { onToggle: () => void }).onToggle();
  assert.deepEqual(toggled, ['adv.date_format', null]);
});

/* ------------------------------------------------------------------ *
 * The card under a DRAFT grading lens (tfnv.6).
 * ------------------------------------------------------------------ */

/**
 * The 27 DS01.3 rows as the session serves them, built FROM the served matrix so
 * that a clause re-pointed on the server moves this fixture with it. `over` lets
 * one test give a row live counts without restating the other 26.
 */
function draftSummary(over: Record<string, Partial<ComplianceRow>> = {}): ComplianceRow[] {
  return DS013_MATRIX.map((row) => ({
    requirement: row.clause,
    summary: row.summary,
    classes: [...row.classes],
    counts: { pass: 0, fail: 0, info: 0 },
    findings: { pass: 0, fail: 0, info: 0 },
    outdated: 0,
    notReached: 0,
    status: 'untested',
    tightened: row.tightened,
    members: [...row.members],
    graded: row.graded,
    ...(over[row.clause] ?? {}),
  })) as ComplianceRow[];
}

/** The §7 rows, with none of the three DS01.3 fields — the contract response. */
function contractSummary(): ComplianceRow[] {
  return COMPLIANCE_MATRIX.map((row) => ({
    requirement: row.requirement,
    summary: row.summary,
    classes: [...row.classes],
    counts: { pass: 0, fail: 0, info: 0 },
    findings: { pass: 0, fail: 0, info: 0 },
    outdated: 0,
    notReached: 0,
    status: 'untested',
  })) as ComplianceRow[];
}

/**
 * The whole column's markup. Every non-gradeable group is opened, because the
 * claim under test is which rows EXIST and where, not what the parent has
 * collapsed.
 */
function cardMarkup(over: Record<string, unknown> = {}): string {
  const props = {
    summary: draftSummary(),
    transmissions: [],
    selectedTx: null,
    onSelectTx: () => {},
    expandedReq: null,
    onToggleReq: () => {},
    showNonGradeable: true,
    onShowNonGradeableChange: () => {},
    collapsedGroups: { 'active-only': false, none: false },
    onToggleGroup: () => {},
    signatures: [],
    activeSignatureKey: null,
    lens: DRAFT,
    contractProfile: CONTRACT_PROFILE,
    ...over,
  };
  return renderToStaticMarkup(
    React.createElement(ComplianceCard, props as Parameters<typeof ComplianceCard>[0]),
  );
}

/**
 * The markup of each requirement row, keyed by its id. `data-req` opens a row and
 * the split ends each slice where the next row begins, so a slice holds exactly
 * one row's header and (when open) its drill-down.
 */
function rowSlices(markup: string): Map<string, string> {
  const slices = new Map<string, string>();
  for (const part of markup.split('data-req="').slice(1)) {
    slices.set(part.slice(0, part.indexOf('"')), part);
  }
  return slices;
}

/** The ids carrying one annotation pill, in render order. */
function tagged(markup: string, tag: 'new' | 'tightened'): string[] {
  return [...rowSlices(markup)]
    .filter(([, slice]) => slice.includes(`data-tag="${tag}"`))
    .map(([id]) => id);
}

test('every DS01.3 clause renders, in the five class groups and no sixth one', () => {
  const markup = cardMarkup();

  // All 27, and exactly the clauses the server sent.
  assert.deepEqual(
    [...rowSlices(markup).keys()].sort(),
    DS013_MATRIX.map((row) => row.clause).sort(),
  );

  // Five group headers, one per group, and nothing keyed on the annotations: an
  // added clause is grouped by its class like any other row (tfnv.14).
  for (const cls of ['verified', 'heuristic', 'attestation', 'active-only', 'none'] as const) {
    const label = CLASS_META[cls].label;
    assert.equal(markup.split(`>${label}<`).length - 1, 1, label);
  }
  assert.ok(!markup.includes('New in DS01.3'), 'no "New in DS01.3" group header');
});

test('5.3.5 is a Verified row with live counts, not an informational one', () => {
  const markup = cardMarkup({
    summary: draftSummary({
      '5.3.5': { counts: { pass: 4, fail: 1, info: 0 }, status: 'fail' },
    }),
  });

  // Between the Verified header and the next group's, which is where its class
  // puts it — the row a collapsed "new in DS01.3" group would have hidden while
  // it was failing.
  const verified = markup.indexOf(`>${CLASS_META.verified.label}<`);
  const heuristic = markup.indexOf(`>${CLASS_META.heuristic.label}<`);
  const row = markup.indexOf('data-req="5.3.5"');
  assert.ok(verified < row && row < heuristic, '5.3.5 renders among the Verified rows');

  // And it renders its numbers: a row with `graded` true has counts like any other.
  const slice = rowSlices(markup).get('5.3.5') ?? '';
  assert.ok(slice.includes('1f'), 'the failure count is on the row');
  assert.ok(slice.includes('4p'), 'the pass count is on the row');
});

test('six clauses carry NEW and four carry TIGHTENED, on the rows the server marks', () => {
  const markup = cardMarkup();

  assert.deepEqual(
    tagged(markup, 'new').sort(),
    DS013_MATRIX.filter((row) => row.members.length === 0)
      .map((row) => row.clause)
      .sort(),
  );
  assert.equal(tagged(markup, 'new').length, 6);

  assert.deepEqual(tagged(markup, 'tightened').sort(), ['5.1.9', '5.3.2', '5.3.3', '5.4.1']);
  assert.deepEqual(
    tagged(markup, 'tightened').sort(),
    DS013_MATRIX.filter((row) => row.tightened)
      .map((row) => row.clause)
      .sort(),
  );
});

test('the tag tooltips name the contract from the vocabulary, never from a literal', () => {
  const [tightened] = rowTags(
    draftSummary().find((r) => r.requirement === '5.1.9') as ComplianceRow,
  );
  assert.deepEqual(tightened, {
    id: 'tightened',
    label: 'TIGHTENED',
    title: 'DS01.3 changes what conformance means here.',
  });

  const [added] = rowTags(draftSummary().find((r) => r.requirement === '5.3.1') as ComplianceRow);
  assert.equal(added?.label, 'NEW');
  assert.ok(
    added?.title.includes(PROFILE_NAME[CONTRACT_PROFILE]),
    'the tooltip names the contract package from PROFILE_NAME',
  );

  // The NEW tag is `members` empty, NOT `graded` false: 5.3.5 is added AND fed,
  // and reading `graded` would drop the tag from the one row where they differ.
  const fed = draftSummary().find((r) => r.requirement === '5.3.5') as ComplianceRow;
  assert.equal(fed.graded, true);
  assert.equal(isNewInDraft(fed), true);
  assert.equal(rowTags(fed).length, 1);
});

test('an added clause nothing feeds opens its drill-down saying so; a fed one does not', () => {
  assert.ok(cardMarkup({ expandedReq: '5.1.1' }).includes(NOT_FED_NOTE));
  assert.ok(!cardMarkup({ expandedReq: '5.3.5' }).includes(NOT_FED_NOTE));
  // Nor does a clause carried forward from a 2025 requirement, tightened or not.
  assert.ok(!cardMarkup({ expandedReq: '5.1.9' }).includes(NOT_FED_NOTE));
  // Closed rows say nothing at all: the line is drill-down copy, not row chrome.
  assert.ok(!cardMarkup().includes(NOT_FED_NOTE));
});

test('under the contract lens the rows render exactly as they did: no tags, no note', () => {
  const markup = cardMarkup({
    summary: contractSummary(),
    lens: CONTRACT_PROFILE,
    expandedReq: '3.1',
  });

  assert.deepEqual(
    [...rowSlices(markup).keys()].sort(),
    COMPLIANCE_MATRIX.map((r) => r.requirement).sort(),
  );
  assert.ok(!markup.includes('data-tag='), 'the contract package annotates nothing');
  assert.ok(!markup.includes(NOT_FED_NOTE));
  // The three DS01.3 fields are absent from a contract row, so the helpers that
  // read them answer false rather than guessing.
  for (const row of contractSummary()) {
    assert.equal(isNewInDraft(row), false, row.requirement);
    assert.deepEqual(rowTags(row), []);
  }
});

/* ------------------------------------------------------------------ *
 * signaturesForReq under the lens — held equal to the server's fold.
 * ------------------------------------------------------------------ */

/**
 * A signature set covering every branch of the fold: a contract finding the map
 * carries forward, the §3.1 split on a custom-object code, the §3.2 result the
 * draft re-runs for itself (so it belongs to no draft row), the draft's own
 * findings, and an advisory.
 */
const LENS_SIGS: Signature[] = [
  sig({ key: '2025|1.4|tx.too_large', req: '1.4', kind: 'check' }),
  sig({ key: '2025|3.1|tx.missing_custom_schema', req: '3.1', kind: 'check' }),
  sig({ key: '2025|3.1|tx.transferred_at_not_utc', req: '3.1', kind: 'check' }),
  sig({ key: '2025|3.2|required|/data|CID', req: '3.2', kind: 'schema' }),
  sig({ key: '2025|4.3|tx.retried_permanent', req: '4.3', kind: 'check' }),
  sig({ key: 'ds013|5.3.2|required|/data|LSER', req: '5.3.2', profile: DRAFT, kind: 'schema' }),
  sig({ key: 'ds013|5.3.3|tx.missing_transfer_id', req: '5.3.3', profile: DRAFT, kind: 'check' }),
  adv('adv.null_padding'),
];

/** The set as the session serves it under one lens — the server stamps the rows. */
function served(lens: string): Signature[] {
  return withRequirementUnderLens(
    LENS_SIGS as never,
    lens as never,
    CONTRACT_PROFILE as never,
  ) as unknown as Signature[];
}

test('under the contract lens the selection is the server’s signaturesForReq, unchanged', () => {
  const sigs = served(CONTRACT_PROFILE);
  for (const req of ['1.4', '3.1', '3.2', '4.3', '5.3.2', '']) {
    assert.deepEqual(
      signaturesForReq(sigs, req),
      serverSignaturesForReq(sigs as never, req) as unknown as Signature[],
      req,
    );
    // The defaults ARE the contract lens, so stating it changes nothing.
    assert.deepEqual(
      signaturesForReq(sigs, req, CONTRACT_PROFILE, CONTRACT_PROFILE),
      signaturesForReq(sigs, req),
    );
  }
});

/**
 * THE DRAFT-LENS SELECTION IS THE SERVER'S FOLD.
 *
 * `rowFor` in src/api/lens.ts is not exported, and the fold that applies to a
 * SIGNATURE is `withRequirementUnderLens` (src/api/signatures.ts) — it stamps each
 * signature with the row it belongs to under the lens, reading lens.ts's own
 * `clauseUnderLens` for the contract half. So the expectation is that stamp,
 * computed by the server on the same fixture set, never transcribed here.
 */
test('under the draft lens every row selects what the server folded onto it', () => {
  const sigs = served(DRAFT);

  for (const { clause } of DS013_MATRIX) {
    assert.deepEqual(
      signaturesForReq(sigs, clause, DRAFT, CONTRACT_PROFILE),
      sigs.filter((s) => s.kind !== 'advisory' && s.requirementUnderLens === clause),
      clause,
    );
  }

  // The interesting rows, stated so the pin fails loudly rather than emptily:
  // §3.1's custom-object half lands on 5.3.5 and its metadata half on 5.3.3, the
  // draft's own finding keeps its number, and §3.2 belongs to no draft row.
  const keysOn = (clause: string): string[] =>
    signaturesForReq(sigs, clause, DRAFT, CONTRACT_PROFILE).map((s) => s.key);
  assert.deepEqual(keysOn('5.3.5'), ['2025|3.1|tx.missing_custom_schema']);
  assert.deepEqual(keysOn('5.3.3'), [
    '2025|3.1|tx.transferred_at_not_utc',
    'ds013|5.3.3|tx.missing_transfer_id',
  ]);
  assert.deepEqual(keysOn('5.1.5'), ['2025|1.4|tx.too_large']);
  assert.deepEqual(keysOn('5.4.1'), ['2025|4.3|tx.retried_permanent']);
  assert.deepEqual(keysOn('5.3.2'), ['ds013|5.3.2|required|/data|LSER']);

  // No signature is filed twice, and no advisory is filed at all.
  const filed = DS013_MATRIX.flatMap(({ clause }) => keysOn(clause));
  assert.equal(new Set(filed).size, filed.length);
  assert.ok(!filed.some((key) => key.startsWith('adv|')));
});

test('the row a contract signature lands on is lens.ts’s clauseUnderLens', () => {
  // The stamp the browser trusts is the server's fold of the clause map: §3.1
  // with a custom-object code goes to 5.3.5, §3.2 nowhere, the rest forward.
  const codes: Record<string, string | null> = {
    '2025|1.4|tx.too_large': 'tx.too_large',
    '2025|3.1|tx.missing_custom_schema': 'tx.missing_custom_schema',
    '2025|3.1|tx.transferred_at_not_utc': 'tx.transferred_at_not_utc',
    '2025|3.2|required|/data|CID': null,
    '2025|4.3|tx.retried_permanent': 'tx.retried_permanent',
  };
  for (const s of served(DRAFT)) {
    if (s.profile !== CONTRACT_PROFILE || s.kind === 'advisory') continue;
    assert.equal(
      s.requirementUnderLens ?? null,
      serverClauseUnderLens(s.req, codes[s.key] ?? null),
      s.key,
    );
  }
});

/* ------------------------------------------------------------------ *
 * The two units on a row: transmissions on the tally, findings in the
 * expansion (vsy1).
 * ------------------------------------------------------------------ */

/** Transmissions in the scope of the run the two fixtures below were read from. */
const SCOPE = 80;

/**
 * 5.3.2 as a live exercise run serves it (read 2026-09-19, session c57c2007, 80
 * transmissions in scope): the schema stage's per-error fan-out makes the finding
 * count four times the number of failing transmissions, and seven transmissions
 * were rejected before the Annex 4 validator ever saw them. Read from an instance
 * rather than invented, so the shape the tests pin is one the service produces.
 */
const FANNED_OUT: Partial<ComplianceRow> = {
  counts: { pass: 13, fail: 60, info: 0 },
  findings: { pass: 13, fail: 251, info: 0 },
  notReached: 7,
  status: 'mixed',
};

test('an expanded row states its evidence in transmissions, against the scope', () => {
  const slice =
    rowSlices(
      cardMarkup({
        summary: draftSummary({ '5.3.2': FANNED_OUT }),
        expandedReq: '5.3.2',
        scopedTotal: SCOPE,
      }),
    ).get('5.3.2') ?? '';

  // The noun and the denominator ride on the first segment and are said once.
  assert.ok(slice.includes('60 of 80 transmissions failing'), 'the failing tally names the scope');
  assert.ok(slice.includes('13 passing'));
  assert.equal(slice.split('transmissions failing').length - 1, 1);
  assert.ok(!slice.includes('13 of 80'), 'the denominator is not repeated per segment');

  // The collapsed tally is the same number in the same unit — it reads
  // `row.counts`, which the server moved to transmissions, so the headline a
  // supplier sees closed and the line they see open cannot disagree.
  assert.ok(slice.includes('60f'), 'the collapsed tally counts transmissions too');
  assert.ok(slice.includes('13p'));
  // And never the finding count, which is the number this change took off the row.
  assert.ok(!slice.includes('251 failing'), 'the finding count is not the row tally');
  assert.ok(!slice.includes('251f'));
});

test('the finding count stays in the expansion, labelled as findings', () => {
  const draftSig = sig({
    key: 'ds013|5.3.2|required|/data|LSER',
    req: '5.3.2',
    profile: DRAFT,
    kind: 'schema',
  });
  const slice =
    rowSlices(
      cardMarkup({
        summary: draftSummary({ '5.3.2': FANNED_OUT }),
        expandedReq: '5.3.2',
        scopedTotal: SCOPE,
        signatures: [draftSig],
      }),
    ).get('5.3.2') ?? '';

  // The eyebrow the issue rows sit under, and beside it the evidence behind them
  // — 251 findings over the 60 failing transmissions the line above reports.
  assert.ok(slice.includes('Distinct issues'));
  assert.ok(slice.includes('251 findings'), 'the finding tally says the word');
  // Passes are not in it: a pass raises no issue and has no row to sit under.
  assert.ok(!slice.includes('264 findings'));
});

test('the not-reached remainder is the served number, never a subtraction', () => {
  // 5.1.3 merges §1.1 and §1.2, and the same live run serves it as below: 77
  // transmissions passed at least one member, 2 failed at least one, and 3 never
  // reached the clause. 77 + 2 + 3 is 82 over a scope of 80, because `pass` and
  // `fail` are NOT disjoint — two transmissions passed one member and failed the
  // other. So 80 − 77 − 2 is 1 and the remainder is 3: only the server, which saw
  // the scope and the sets, can say which. A web layer that subtracted would be
  // wrong here and negative on a clause with more overlap.
  const slice =
    rowSlices(
      cardMarkup({
        summary: draftSummary({
          '5.1.3': {
            counts: { pass: 77, fail: 2, info: 0 },
            findings: { pass: 150, fail: 2, info: 0 },
            notReached: 3,
            status: 'mixed',
          },
        }),
        expandedReq: '5.1.3',
        scopedTotal: SCOPE,
      }),
    ).get('5.1.3') ?? '';

  assert.ok(slice.includes('3 not reached'));
  assert.ok(!slice.includes('1 not reached'));
  // No tally on a collapsed clause claims more than the scope holds (f2bl) — the
  // 150 pass FINDINGS the members sum to would have, and are not on the row.
  for (const n of [77, 2, 3]) assert.ok(n <= SCOPE);
  assert.ok(!slice.includes('150'), 'the summed member findings are not on the row');
});

test('a row nothing feeds says nothing about transmissions not reaching it', () => {
  // 5.3.5 is Verified and added by the draft, so it is the one shape where an
  // ungraded row reaches the expansion: `graded` false means there is no check
  // to reach, and the server still fills `notReached` with the whole scope.
  const slice =
    rowSlices(
      cardMarkup({
        summary: draftSummary({ '5.3.5': { graded: false, notReached: SCOPE } }),
        expandedReq: '5.3.5',
        scopedTotal: SCOPE,
      }),
    ).get('5.3.5') ?? '';

  assert.ok(slice.includes(NOT_FED_NOTE));
  assert.ok(!slice.includes('not reached'), 'no remainder where there is no check');
  assert.ok(slice.includes('no transmissions in this window'));
});

test('with no scope in hand the line drops the denominator rather than inventing one', () => {
  const slice =
    rowSlices(
      cardMarkup({ summary: draftSummary({ '5.3.2': FANNED_OUT }), expandedReq: '5.3.2' }),
    ).get('5.3.2') ?? '';

  assert.ok(slice.includes('60 failing'));
  assert.ok(!slice.includes('transmissions failing'));
  // The remainder is still the server's own number — it needs no denominator.
  assert.ok(slice.includes('7 not reached'));
});
