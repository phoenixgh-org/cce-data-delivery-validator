/**
 * The two summary cards above the panes (vamh.3).
 *
 * What is worth pinning here is the COPY and the SOURCE of each numeral, because
 * both fail silently. The defect the cards exist to fix was a number read under
 * the wrong noun, so a card that lost its eyebrow or its qualifying sentence
 * would look fine and mislead exactly as the scorecard strip did; and a numeral
 * fed from the wrong half of the response (the rollup counts requirements, the
 * scope totals count transmissions) would still render a plausible integer. The
 * fixtures below therefore use values that are distinct across the two objects,
 * so a crossed wire shows up as a number in the wrong card.
 *
 * The p98 disclosure gets its own cases. Reports naming no appliance are
 * excluded from the unit count, so the clause that discloses them is the only
 * thing on the page reconciling the two numbers (6o0u): it must appear when the
 * count is nonzero, must NOT appear when it is zero, and must not say "1
 * reports". The units tooltip stays as well — it carries the identifier rule and
 * the DESIGN §7 "counts what was received" caveat.
 *
 * The grading lens (tfnv.5) adds two more copy cases, and they are copy cases
 * for the same reason: under the draft package the cards count a DIFFERENT set
 * of requirements and a different notion of passing, and the only thing saying
 * so on the cards themselves is the eyebrow's package name and the sentence
 * carrying the readiness number. Both must appear under that package, and
 * NEITHER may appear under the contract one, where they would describe a draft
 * nobody is graded against.
 *
 * No DOM and no renderer: the repo has neither. The element tree is walked
 * directly, function components called with their own props — the same pattern
 * as ReportHeader.test.ts, which explains the global React binding and the
 * dynamic import the JSX-bearing modules need.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import {
  CONTRACT_PROFILE,
  type Profile,
  type Readiness,
  type Rollup,
  type ScopeTotals,
} from '../api.js';
import { PROFILE_NAME } from '../profiles.js';
import { unitsTitle } from '../scopeCopy.js';

(globalThis as unknown as { React: typeof React }).React = React;

const { SummaryCards } = await import('./SummaryCards.js');

/** Rollup values, all distinct from the scope totals below. */
const rollup: Rollup = { total: 27, gradeable: 12, passing: 5, failing: 6, untested: 1 };

/** Scope totals, all distinct from the rollup above. */
const scoped: ScopeTotals = {
  scoped: 40,
  withFailures: 8,
  distinctIssues: 3,
  units: 9,
  unidentifiedReports: 2,
};

type Props = Record<string, unknown>;
type El = { type: unknown; props: Props };

function isElement(node: unknown): node is El {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/** Every element in the rendered tree, function components expanded by calling them. */
function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isElement(node)) return;
  yield node;
  if (typeof node.type === 'function') {
    const render = node.type as (props: Props) => unknown;
    yield* walk(render(node.props));
    return;
  }
  yield* walk(node.props['children']);
}

/**
 * Every string rendered in the tree, joined and whitespace-collapsed. The
 * sentences are assembled from several text nodes (a bolded number beside its
 * plain noun), so the joined text carries seams the reader never sees.
 */
function text(node: unknown): string {
  const out: string[] = [];
  const collect = (n: unknown): void => {
    if (typeof n === 'string' || typeof n === 'number') {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const child of n) collect(child);
      return;
    }
    if (!isElement(n)) return;
    if (typeof n.type === 'function') {
      const render = n.type as (props: Props) => unknown;
      collect(render(n.props));
      return;
    }
    collect(n.props['children']);
  };
  collect(node);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** The row, and its two cards in render order: requirements, then transmissions. */
function cards(overrides: Partial<ScopeTotals> = {}) {
  const row = SummaryCards({ rollup, scoped: { ...scoped, ...overrides } });
  const children = (row.props as { children: unknown }).children;
  assert.ok(Array.isArray(children) && children.length === 2, 'the row renders two cards');
  return { row, requirements: children[0], transmissions: children[1] };
}

test('both cards name their noun and carry their qualifying sentence', () => {
  const { requirements, transmissions } = cards();
  const left = text(requirements);
  assert.ok(left.includes('REQUIREMENTS'), left);
  assert.ok(left.includes('12 of 27 verifiable from your traffic'), left);
  assert.ok(left.includes('the rest are self-attested or need active testing'), left);

  const right = text(transmissions);
  assert.ok(right.includes('TRANSMISSIONS'), right);
  assert.ok(right.includes('received in this scope, from 9 CCE units'), right);
});

test('the requirements numerals come from the rollup and nothing else', () => {
  const left = text(cards().requirements);
  for (const [value, label] of [
    [rollup.passing, 'passing'],
    [rollup.failing, 'with failures'],
    [rollup.untested, 'untested'],
  ] as const) {
    assert.ok(left.includes(`${value} ${label}`), `requirements card missing "${value} ${label}"`);
  }
  // A scope total leaking into this card is the defect the cards exist to
  // prevent; none of these values appears in the rollup.
  for (const leaked of [scoped.scoped, scoped.withFailures, scoped.units]) {
    assert.ok(!left.includes(String(leaked)), `requirements card shows the scoped ${leaked}`);
  }
});

test('the transmissions numerals come from the scope totals and nothing else', () => {
  const right = text(cards().transmissions);
  for (const [value, label] of [
    [scoped.scoped, 'received'],
    [scoped.withFailures, 'with failures'],
    [scoped.distinctIssues, 'distinct issues'],
  ] as const) {
    assert.ok(
      right.includes(`${value} ${label}`),
      `transmissions card missing "${value} ${label}"`,
    );
  }
  for (const leaked of [rollup.total, rollup.gradeable, rollup.passing]) {
    assert.ok(!right.includes(String(leaked)), `transmissions card shows the rollup ${leaked}`);
  }
});

test('the unidentified clause is pluralized and states the count inline', () => {
  const many = text(cards({ unidentifiedReports: 2 }).transmissions);
  assert.ok(many.includes('· 2 reports named no appliance'), many);

  const one = text(cards({ unidentifiedReports: 1 }).transmissions);
  assert.ok(one.includes('· 1 report named no appliance'), one);
  assert.ok(!one.includes('1 reports'), one);
});

test('no unidentified reports, no clause', () => {
  const none = text(cards({ unidentifiedReports: 0 }).transmissions);
  assert.ok(!none.includes('named no appliance'), none);
  assert.ok(none.includes('received in this scope, from 9 CCE units'), none);
});

test('the CCE unit count is pluralized too', () => {
  assert.ok(text(cards({ units: 1 }).transmissions).includes('from 1 CCE unit'), 'singular unit');
  assert.ok(!text(cards({ units: 1 }).transmissions).includes('1 CCE units'), 'no "1 CCE units"');
  assert.ok(text(cards({ units: 0 }).transmissions).includes('from 0 CCE units'), 'zero is plural');
});

test('the units figure keeps the disclosure tooltip', () => {
  for (const unidentifiedReports of [0, 1, 4]) {
    const titled = [...walk(cards({ unidentifiedReports }).transmissions)]
      .map((el) => el.props['title'])
      .filter((t): t is string => typeof t === 'string');
    assert.deepEqual(titled, [unitsTitle(unidentifiedReports)]);
  }
});

/** The lens package: the one lineage that is not the contract one. */
const LENS: Profile = (Object.keys(PROFILE_NAME) as Profile[]).find(
  (p) => p !== CONTRACT_PROFILE,
) as Profile;

/** Readiness as the summary read serves it — values distinct from both fixtures. */
const readiness: Readiness = { passingContract: 17, passingBoth: 11 };

/** The row under a chosen package, its two cards in render order. */
function lensCards(overrides: Partial<Parameters<typeof SummaryCards>[0]> = {}) {
  const row = SummaryCards({
    rollup,
    scoped,
    lens: LENS,
    contractProfile: CONTRACT_PROFILE,
    readiness,
    ...overrides,
  });
  const children = (row.props as { children: unknown }).children;
  assert.ok(Array.isArray(children) && children.length === 2, 'the row renders two cards');
  return { row, requirements: children[0], transmissions: children[1] };
}

/** Each card's border, read off the card element itself. */
function borders(row: unknown): string[] {
  return [...walk(row)]
    .map((el) => el.props['style'])
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => s['border'])
    .filter((b): b is string => typeof b === 'string');
}

test('under the draft lens the eyebrow names the package and the sentence carries readiness', () => {
  const { requirements, transmissions } = lensCards();
  // The name comes from the vocabulary, never from a literal here.
  assert.ok(
    text(requirements).includes(`REQUIREMENTS · ${PROFILE_NAME[LENS]}`),
    text(requirements),
  );
  assert.ok(
    text(transmissions).includes(
      `· 11 of the 17 passing ${PROFILE_NAME[CONTRACT_PROFILE]} also pass here`,
    ),
    text(transmissions),
  );
  // Both cards take the lens's border; nothing else on the card changes.
  assert.deepEqual(borders(lensCards().row), [
    '1px solid var(--draft-border)',
    '1px solid var(--draft-border)',
  ]);
});

test('no readiness, no readiness clause', () => {
  const right = text(lensCards({ readiness: null }).transmissions);
  assert.ok(!right.includes('also pass here'), right);
  // The rest of the sentence is untouched.
  assert.ok(right.includes('received in this scope, from 9 CCE units'), right);
});

test('the contract lens renders exactly what it rendered before the lens existed', () => {
  // Served readiness and an explicit contract lens: neither the package name nor
  // the readiness clause may appear, and the borders stay the card border.
  const { row, requirements, transmissions } = lensCards({ lens: CONTRACT_PROFILE });
  const left = text(requirements);
  assert.ok(left.includes('REQUIREMENTS'), left);
  assert.ok(!left.includes('·  '), left);
  assert.ok(!left.includes(PROFILE_NAME[LENS]), left);
  assert.ok(!text(transmissions).includes('also pass here'), text(transmissions));
  assert.deepEqual(borders(row), [
    '1px solid var(--border-strong)',
    '1px solid var(--border-strong)',
  ]);
  // And the row the Dashboard rendered before the lens existed — no lens props
  // at all — is the same row.
  assert.equal(text(cards().row), text(row));
});
