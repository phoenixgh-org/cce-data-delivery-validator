/**
 * SEQUENCE-domain exercise cases — the heuristics graded from how transmissions
 * relate to EACH OTHER rather than from any single POST: §1.8 duplicate
 * detection, §3.4 reading cadence, and (8qa.5) §2.1 serial delivery.
 *
 * OWNERSHIP: this file is the sequence-heuristics table (8qa.5). Transport cases
 * live in ./transport.ts and payload cases in ./payload.ts; ../cases.ts is the
 * index that concatenates the three into `EXERCISE_CASES`.
 *
 * Grouping is by REQUIREMENT DOMAIN, not by `fault.layer` — the §3.4 cases below
 * carry a payload-layer fault (the readings themselves are mutated) but grade a
 * sequence heuristic, so they belong here and not in ./payload.ts.
 *
 * A case here that repeats a transferId on purpose is exempted from the
 * table-wide uniqueness invariant WITHIN itself only; its pinned id must still
 * not collide with any other case's (../cases.test.ts, hn5).
 */

import type { ExerciseCase } from '../case.js';
import { irregularCadence, regularCadence, setTransferId } from '../transforms/payload.js';

export const SEQUENCE_CASES: readonly ExerciseCase[] = [
  // ── §3.4 reading cadence ──────────────────────────────────────────────────
  {
    id: '3.4-pass-regular-cadence',
    title: 'An evenly spaced reading series passes the §3.4 regularity heuristic',
    requirements: ['3.4'],
    direction: 'pass',
    posts: [{ transforms: [regularCadence(4, 15)], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.4', severity: 'pass' }],
  },
  {
    id: '3.4-fail-irregular-cadence',
    title: 'A wildly uneven reading series fails the §3.4 regularity heuristic (still 200)',
    requirements: ['3.4'],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note: 'readings at 0/5/6/120 minutes — an interval CV far past the 25% tolerance',
    },
    posts: [{ transforms: [irregularCadence([0, 5, 6, 120])], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.4', severity: 'fail' }],
  },

  // ── §1.8 duplicate detection (the multi-POST shape) ───────────────────────
  {
    id: '1.8-fail-repeated-transfer-id',
    title: 'A second POST re-using the first POST’s transferId is observed as a §1.8 duplicate',
    requirements: ['1.8'],
    direction: 'fail',
    fault: {
      layer: 'sequence',
      note: 'the second POST re-uses the first POST’s transferId within the same session',
    },
    posts: [
      {
        label: 'novel',
        transforms: [setTransferId('exercise-1.8-replay')],
        expectedStatus: 200,
      },
      {
        label: 'replay',
        transforms: [setTransferId('exercise-1.8-replay')],
        expectedStatus: 200,
      },
    ],
    // The session shows BOTH: the first POST is novel, the second is the repeat.
    expectedFindings: [
      { requirement: '1.8', severity: 'pass' },
      { requirement: '1.8', severity: 'fail' },
    ],
  },
];
