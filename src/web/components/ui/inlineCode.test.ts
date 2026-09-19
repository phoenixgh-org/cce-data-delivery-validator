/**
 * Backticked identifiers in advisory prose (synm).
 *
 * The served rationale and observation lines carry house-style backticks
 * (`ems-report`, `TVC`, `ASER`) because the check that owns the wording serves
 * it verbatim. What is pinned here is what the renderer must not do to that
 * text: lose a character of it, or treat a lone tick as the start of a span it
 * never closes and swallow the rest of the sentence.
 *
 * Pure functions plus the returned element array — no DOM, the Setup.test.ts
 * pattern. The module is JSX-bearing and evaluates under esbuild's classic
 * transform, hence the global React binding plus the dynamic import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

(globalThis as unknown as { React: typeof React }).React = React;

const { inlineCode, splitInlineCode } = await import('./inlineCode.js');

test('a paired backtick splits out the identifier, and text without one is untouched', () => {
  assert.deepEqual(splitInlineCode('For an `ems-report` it reads `TVC`.'), [
    'For an ',
    'ems-report',
    ' it reads ',
    'TVC',
    '.',
  ]);
  assert.deepEqual(splitInlineCode('Plain prose, no identifiers.'), [
    'Plain prose, no identifiers.',
  ]);
});

test('an unpaired backtick stays in the text rather than opening a span', () => {
  // A lone tick must not swallow the rest of the sentence.
  assert.deepEqual(splitInlineCode('A stray ` tick and nothing after it.'), [
    'A stray ` tick and nothing after it.',
  ]);
  assert.deepEqual(splitInlineCode('`ASER` first, then a stray `.'), [
    '',
    'ASER',
    ' first, then a stray `.',
  ]);
});

test('the renderer wraps only the identifiers, and returns plain prose as a string', () => {
  assert.equal(inlineCode('Plain prose, no identifiers.'), 'Plain prose, no identifiers.');

  const rendered = inlineCode('For an `ems-report` it is `ASER`.');
  assert.ok(Array.isArray(rendered));
  const codes = rendered.filter((n) => React.isValidElement(n)) as React.ReactElement[];
  assert.deepEqual(
    codes.map((n) => (n.props as { children: string }).children),
    ['ems-report', 'ASER'],
  );
  for (const n of codes) assert.equal(n.type, 'code');

  // Nothing is dropped: the parts concatenate back to the source minus its ticks.
  const flat = rendered
    .map((n) =>
      React.isValidElement(n) ? (n.props as { children: string }).children : (n as string),
    )
    .join('');
  assert.equal(flat, 'For an ems-report it is ASER.');
});
