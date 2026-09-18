/**
 * The one-line header and its scope controls (vamh.1).
 *
 * The header is presentational, and the one thing that would break silently if it
 * stopped being wired is the pair of handlers: the Dashboard owns `window` and
 * `source`, and a control that renders but raises nothing leaves the page frozen
 * on the unscoped view with no error anywhere. So what is pinned here is the
 * wiring and the emptiness:
 *
 *   1. THE WINDOW BUTTONS RAISE onWindowChange with their own value, and the
 *      source select raises onSourceChange with the chosen key — the two reads
 *      re-run off those handlers and nothing else.
 *   2. THE HEADER CARRIES THE TITLE AND THE TWO CONTROLS, and nothing else. The
 *      endpoint sentence and the "live · updated just now" dot were removed, and
 *      the mono schema/auth/days-left meta moved to the setup bar; a header that
 *      quietly regained any of them is the defect vamh.1 exists to prevent.
 *
 * No DOM and no renderer: the repo has neither. The element tree is walked
 * directly — function components are called with their own props, which is enough
 * to reach the buttons and the select and to collect the rendered text. The module
 * is JSX-bearing and evaluates under esbuild's classic transform, hence the global
 * React binding plus the dynamic import; see Setup.test.ts for the full
 * explanation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import type { SourceCount } from '../api.js';

(globalThis as unknown as { React: typeof React }).React = React;

const { ReportHeader } = await import('./ReportHeader.js');

/** Two sources as the summary read serves them, plus the unknown bucket. */
const sources: SourceCount[] = [
  { source: 'acme', sourceLabel: 'acme', count: 7 },
  { source: '', sourceLabel: 'unattributed', count: 2 },
];

type Props = Record<string, unknown>;
type El = { type: unknown; props: Props };

function isElement(node: unknown): node is El {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/**
 * Every element in the rendered tree, function components expanded by calling
 * them. Shallow rendering would stop at `Seg`, and `Seg` is where the window
 * buttons are.
 */
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

/** Every string rendered in the tree, joined — the header's visible copy. */
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
  return out.join(' ');
}

function header(overrides: Partial<Parameters<typeof ReportHeader>[0]> = {}) {
  const props = {
    window: 'all' as const,
    source: 'all',
    sources,
    onWindowChange: () => undefined,
    onSourceChange: () => undefined,
    ...overrides,
  };
  return ReportHeader(props);
}

test('each window button raises onWindowChange with its own value', () => {
  const raised: string[] = [];
  const tree = header({ onWindowChange: (w) => raised.push(w) });
  const buttons = [...walk(tree)].filter((el) => el.type === 'button');
  assert.deepEqual(
    buttons.map((b) => b.props['children']),
    ['15m', '1h', '6h', 'All'],
  );
  for (const button of buttons) (button.props['onClick'] as () => void)();
  assert.deepEqual(raised, ['15m', '1h', '6h', 'all']);
});

test('the source select raises onSourceChange with the chosen key', () => {
  const raised: string[] = [];
  const tree = header({ onSourceChange: (s) => raised.push(s) });
  const selects = [...walk(tree)].filter((el) => el.type === 'select');
  assert.equal(selects.length, 1);
  const select = selects[0];
  assert.ok(select !== undefined);
  const onChange = select.props['onChange'] as (e: { target: { value: string } }) => void;
  // The raw source key is the option value, `''` for the unknown bucket, with an
  // `'all'` sentinel — the same contract the Dashboard's scope state expects.
  for (const value of ['acme', '', 'all']) onChange({ target: { value } });
  assert.deepEqual(raised, ['acme', '', 'all']);
});

test('the select offers every source plus an all-sources total', () => {
  const options = [...walk(header())].filter((el) => el.type === 'option');
  assert.deepEqual(
    options.map((o) => o.props['value']),
    ['all', 'acme', ''],
  );
  assert.ok(text(options[0]).includes('All sources'));
  // 7 + 2, summed from the served counts rather than served as its own number.
  assert.ok(text(options[0]).includes('9'));
});

test('the header carries the title and the controls, and nothing else', () => {
  const copy = text(header());
  assert.ok(copy.includes('Delivery compliance report'));
  for (const gone of [
    'passing',
    'with failures',
    'verifiable requirements',
    'awaiting your first transmission',
    // The live dot's two states, as phrases: the bare word "live" is a substring
    // of "Delivery", which is in the title.
    'live · updated just now',
    'no data yet',
    'schema ',
    'auth ',
    'd left',
    'Grading',
    'CCE unit',
  ]) {
    assert.ok(!copy.includes(gone), `the header must not say "${gone}"`);
  }
});
