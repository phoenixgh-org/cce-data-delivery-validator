/**
 * Concurrency tracker unit tests (8ji.3, §2.1).
 *
 * Pure in-memory logic — no DB, no HTTP — so these always run. They prove the
 * enter/leave increment/decrement contract, that the enter snapshot INCLUDES the
 * current request, that a session's key is removed at 0 (no Map leak), and that
 * sessions are tracked independently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enterSession, leaveSession, inFlight } from './concurrency-tracker.js';

test('concurrency-tracker: enter increments and returns the new count (includes self)', () => {
  const s = 'session-enter';
  assert.equal(inFlight(s), 0, 'absent session starts at 0');
  assert.equal(enterSession(s), 1, 'first enter snapshot is 1 (self)');
  assert.equal(enterSession(s), 2, 'second concurrent enter snapshot is 2');
  assert.equal(enterSession(s), 3, 'third concurrent enter snapshot is 3');
  assert.equal(inFlight(s), 3);
  // cleanup
  leaveSession(s);
  leaveSession(s);
  leaveSession(s);
});

test('concurrency-tracker: leave decrements and removes the key at 0', () => {
  const s = 'session-leave';
  enterSession(s);
  enterSession(s);
  assert.equal(inFlight(s), 2);
  leaveSession(s);
  assert.equal(inFlight(s), 1, 'one in flight after one leave');
  leaveSession(s);
  assert.equal(inFlight(s), 0, 'count back to 0');
  // Key removed at 0: a spurious extra leave is a harmless no-op (stays 0).
  leaveSession(s);
  assert.equal(inFlight(s), 0, 'over-leave does not go negative');
});

test('concurrency-tracker: snapshot ≤ 1 ⇒ serial, ≥ 2 ⇒ overlap', () => {
  const s = 'session-serial';
  const a = enterSession(s); // request A
  assert.equal(a, 1, 'A alone in flight ⇒ serial');
  const b = enterSession(s); // request B overlaps A
  assert.equal(b, 2, 'B overlaps A ⇒ concurrent');
  leaveSession(s); // A done
  const c = enterSession(s); // C overlaps B
  assert.equal(c, 2, 'C overlaps the still-in-flight B');
  leaveSession(s);
  leaveSession(s);
  assert.equal(inFlight(s), 0);
});

test('concurrency-tracker: sessions are tracked independently', () => {
  const s1 = 'session-indep-1';
  const s2 = 'session-indep-2';
  assert.equal(enterSession(s1), 1);
  assert.equal(enterSession(s1), 2);
  assert.equal(enterSession(s2), 1, 's2 is independent of s1');
  assert.equal(inFlight(s1), 2);
  assert.equal(inFlight(s2), 1);
  leaveSession(s1);
  leaveSession(s1);
  leaveSession(s2);
  assert.equal(inFlight(s1), 0);
  assert.equal(inFlight(s2), 0);
});
