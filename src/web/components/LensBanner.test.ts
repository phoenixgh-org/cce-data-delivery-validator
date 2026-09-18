/**
 * The grading-lens banner (tfnv.5).
 *
 * What is pinned here is COPY, because the banner is the one place on the page
 * that states which requirement package the numbers below it were graded under.
 * Three ways it could fail silently:
 *
 *   1. IT NAMES THE PACKAGE FROM A LITERAL. Every name must come from the
 *      vocabulary (src/web/profiles.ts), so the day the contract package moves,
 *      the banner re-words itself instead of going on naming a lineage that is
 *      no longer anybody's contract.
 *   2. IT DATES THE BYTES WRONG, OR NOT AT ALL. The draft is unpublished, so the
 *      sentence's value to a supplier is the date of the bytes it was graded
 *      against — and a published entry, which has no draft date, must drop the
 *      clause rather than invent one.
 *   3. THE WAY BACK DOES NOTHING. The banner is the escape hatch from a lens a
 *      reader may have arrived in from a shared link; a button that renders and
 *      raises nothing strands them there with no error anywhere.
 *
 * No DOM and no renderer: the repo has neither. The element tree is walked
 * directly, function components called with their own props — the same pattern
 * as ReportHeader.test.ts, which explains the global React binding and the
 * dynamic import the JSX-bearing modules need.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import { CONTRACT_PROFILE, type Profile, type ShadowProvenance } from '../api.js';
import { PROFILE_NAME, formatDraftDateLong } from '../profiles.js';

(globalThis as unknown as { React: typeof React }).React = React;

const { LensBanner } = await import('./LensBanner.js');

/** The lens package: the one lineage that is not the contract one. */
const LENS: Profile = (Object.keys(PROFILE_NAME) as Profile[]).find(
  (p) => p !== CONTRACT_PROFILE,
) as Profile;

/** The DS01.3 entry as the session read serves it — an unpublished proposal. */
const draftShadow: ShadowProvenance = {
  version: '1',
  sha256: 'a'.repeat(64),
  draftDate: '2026-09-08',
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

/** Every string rendered in the tree, joined and whitespace-collapsed. */
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

function banner(overrides: Partial<Parameters<typeof LensBanner>[0]> = {}) {
  return LensBanner({
    lens: LENS,
    contractProfile: CONTRACT_PROFILE,
    shadow: draftShadow,
    onLensChange: () => undefined,
    ...overrides,
  });
}

test('the banner states the package, dates the bytes and offers the way back', () => {
  const copy = text(banner());
  // Composed from the vocabulary, not written here: the eyebrow is the package
  // name, the sentence drops its trailing draft marker, and the date is the
  // vendored entry's own.
  assert.ok(copy.includes(PROFILE_NAME[LENS]), copy);
  const noun = PROFILE_NAME[LENS].replace(/\s+draft$/i, '');
  assert.ok(
    copy.includes(
      `Graded against the ${noun} preview draft (not yet published), as of ${formatDraftDateLong('2026-09-08')}.`,
    ),
    copy,
  );
  // The date reads in full — "Sep 8" alone leaves the reader to guess the year
  // of a proposal that will be revised.
  assert.ok(copy.includes('as of Sep 8, 2026.'), copy);
  assert.ok(copy.includes(`Back to ${PROFILE_NAME[CONTRACT_PROFILE]} ▸`), copy);
  // The vocabulary is binding: a package is never the old or the new one. Word
  // by word, as profiles.test.ts checks the labels themselves.
  const words = copy.toLowerCase().split(/[^a-z0-9.]+/);
  for (const banned of ['old', 'new', 'current', 'latest', 'v1', 'v2']) {
    assert.ok(!words.includes(banned), `the banner must not say "${banned}"`);
  }
});

test('a package with no draft date is named but not dated', () => {
  const published: ShadowProvenance = { version: '0.9.0', sha256: 'b'.repeat(64) };
  const copy = text(banner({ shadow: published }));
  const noun = PROFILE_NAME[LENS].replace(/\s+draft$/i, '');
  assert.ok(copy.includes(`Graded against the ${noun} draft.`), copy);
  assert.ok(!copy.includes('as of'), copy);
  // The same branch covers a session that served no shadow provenance at all.
  assert.ok(text(banner({ shadow: null })).includes(`Graded against the ${noun} draft.`));
});

test('the way-back button raises the contract package', () => {
  const raised: Profile[] = [];
  const tree = banner({ onLensChange: (p) => raised.push(p) });
  const buttons = [...walk(tree)].filter((el) => el.type === 'button');
  assert.equal(buttons.length, 1);
  const button = buttons[0];
  assert.ok(button !== undefined);
  (button.props['onClick'] as () => void)();
  assert.deepEqual(raised, [CONTRACT_PROFILE]);
});

test('the banner is plum, and plum is the lens tint', () => {
  const styled = [...walk(banner())]
    .map((el) => el.props['style'])
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null);
  const ground = styled.find((s) => typeof s['background'] === 'string');
  assert.equal(ground?.['background'], 'var(--draft-bg)');
  assert.equal(ground?.['borderBottom'], '1px solid var(--draft-border)');
  assert.equal(ground?.['color'], 'var(--draft)');
});
