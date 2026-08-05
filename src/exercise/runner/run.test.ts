/**
 * Unit tests for the runner's PURE half of ./run.ts — target resolution is
 * covered by the CLI's own usage, so what matters here is {@link planPlayOrder}
 * (the §1.3 play ordering, ke6) and {@link playCase}'s honouring of
 * `delivery: 'concurrent'` (§2.1, 8qa.5).
 *
 * Nothing here opens a socket: `playCase` takes its POST player as a parameter, so
 * the overlap it is supposed to create can be OBSERVED with a fake player instead
 * of inferred from a live §2.1 finding. `runExercise` itself still needs a live
 * instance and is exercised by `npm run exercise`, like the rest of ./client.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExerciseCase } from '../case.js';
import { EXERCISE_CASES } from '../cases.js';
import type { SessionHandle } from './client.js';
import { planPlayOrder, playCase, type PostPlayer } from './run.js';

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

const SESSION: SessionHandle = {
  uuid: 'stub-session',
  ingestUrl: '/i/stub-session',
  dashboardUrl: '/d/stub-session',
};

/** A three-POST case, delivered however the caller says. */
function burst(delivery: ExerciseCase['delivery']): ExerciseCase {
  return {
    id: `burst-${delivery ?? 'default'}`,
    title: 'three POSTs',
    requirements: ['2.1'],
    direction: 'pass',
    ...(delivery ? { delivery } : {}),
    posts: [
      { label: 'a', expectedStatus: 200 },
      { label: 'b', expectedStatus: 200 },
      { label: 'c', expectedStatus: 200 },
    ],
    expectedFindings: [{ requirement: '2.1', severity: 'pass' }],
  };
}

/**
 * A player that records the peak number of requests in flight — the very thing
 * the §2.1 grader snapshots — and yields to the event loop mid-request so a
 * sequential caller cannot accidentally look concurrent.
 */
function recordingPlayer(): { play: PostPlayer; peakInFlight: () => number } {
  let inFlight = 0;
  let peak = 0;
  let n = 0;
  const play: PostPlayer = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    n += 1;
    return { status: 200, transmissionId: `tx-${n}` };
  };
  return { play, peakInFlight: () => peak };
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

test('a concurrent case really does put its POSTs in flight together', async () => {
  // The §2.1 fail direction is only reachable from overlap (see the case's own
  // comment), so the runner's honouring of the marker is worth checking here
  // rather than only inferring it from a live finding.
  const { play, peakInFlight } = recordingPlayer();
  const outcomes = await playCase('http://stub', SESSION, burst('concurrent'), {}, play);
  assert.equal(peakInFlight(), 3, 'all three POSTs should have overlapped');
  assert.deepEqual(
    outcomes.map((o) => o.label),
    ['a', 'b', 'c'],
    'Promise.all resolves positionally, so outcomes stay in declaration order',
  );
});

test('delivery defaults to sequential: one POST at a time, in order', async () => {
  const { play, peakInFlight } = recordingPlayer();
  const outcomes = await playCase('http://stub', SESSION, burst(undefined), {}, play);
  assert.equal(peakInFlight(), 1, 'a sequential case must never overlap its own POSTs');
  assert.deepEqual(
    outcomes.map((o) => o.transmissionId),
    ['tx-1', 'tx-2', 'tx-3'],
    'each POST completed before the next was sent',
  );
});

test('delivery: sequential is spelled out to the same effect as omitting it', async () => {
  const { play, peakInFlight } = recordingPlayer();
  await playCase('http://stub', SESSION, burst('sequential'), {}, play);
  assert.equal(peakInFlight(), 1);
});
