/**
 * Unit tests for the runner's PURE half of ./run.ts — target resolution is
 * covered by the CLI's own usage, so what matters here is {@link planPlayOrder}:
 * the §1.3 play ordering (ke6).
 *
 * Nothing here opens a socket. `runExercise` itself needs a live instance and is
 * exercised by `npm run exercise`, exactly like the rest of ./client.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExerciseCase } from '../case.js';
import { EXERCISE_CASES } from '../cases.js';
import { planPlayOrder } from './run.js';

function stub(id: string, setup?: ExerciseCase['setup']): ExerciseCase {
  return {
    id,
    title: id,
    requirements: ['3.2'],
    direction: 'pass',
    ...(setup ? { setup } : {}),
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
  };
}

test('auth-requiring cases are played last, whatever order the table lists them in', () => {
  // Enabling §1.3 auth is sticky for the whole session (see run.ts's header), so
  // a plain case played after it would 401. Authors must stay free to file a
  // §1.3 case next to its §1.2/§1.4 neighbours.
  const table = [
    stub('a'),
    stub('auth-1', 'auth-enabled'),
    stub('b'),
    stub('auth-2', 'auth-enabled'),
  ];
  const { plain, authed } = planPlayOrder(table);
  assert.deepEqual(
    plain.map((c) => c.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    authed.map((c) => c.id),
    ['auth-1', 'auth-2'],
  );
});

test('planPlayOrder partitions without dropping or duplicating a case', () => {
  const { plain, authed } = planPlayOrder(EXERCISE_CASES);
  const ids = [...plain, ...authed].map((c) => c.id);
  assert.equal(ids.length, EXERCISE_CASES.length);
  assert.equal(new Set(ids).size, EXERCISE_CASES.length);
});

test('a table with no auth case needs no auth phase at all', () => {
  // The zero-friction default: the runner must not touch the auth route when
  // nothing asks for it, so an unchanged run stays byte-for-byte what it was.
  assert.deepEqual(planPlayOrder([stub('a'), stub('b')]).authed, []);
});
