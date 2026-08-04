/**
 * The exercise CASE TABLE INDEX (8qa.1; split per domain in ke6).
 *
 * `EXERCISE_CASES` is the single table every consumer reads — the live runner
 * (./runner/run.ts), the CI direction checks (./cases.test.ts) and the coverage
 * join (./runner/coverage.ts). This module owns nothing but the concatenation:
 * the cases themselves live in one module per REQUIREMENT DOMAIN under ./cases/,
 * so the per-requirement tables can grow in parallel without three bites editing
 * one array.
 *
 *   ./cases/transport.ts   §1.x — how a transmission is delivered      (8qa.3)
 *   ./cases/payload.ts     §3.1/§3.2 — what is in the body             (8qa.4)
 *   ./cases/sequence.ts    §1.8/§2.1/§3.4 — how transmissions relate   (8qa.5)
 *
 * Grouping is by domain, not by `fault.layer`: §3.4's cases mutate the payload
 * but grade a sequence heuristic, so they sit with the sequence table.
 *
 * ORDER. The concatenation order is the order the runner plays the table in, with
 * ONE documented exception: cases declaring `setup: 'auth-enabled'` are played
 * last regardless of where they sit here, because enabling §1.3 auth is sticky
 * for the whole session (see {@link ExerciseCase.setup} and ./runner/run.ts).
 * Nothing else here is order-sensitive today — the §1.8 heuristic is driven by
 * the transferIds a case pins, and ./cases.test.ts holds those distinct across
 * the whole table.
 *
 * WHAT THE TABLE IS FOR. Beyond per-requirement coverage, the set as a whole must
 * keep exercising every part of the MODEL — both directions, both transform
 * families, a multi-POST case, a status-only case and all three schema outcomes —
 * which ./cases.test.ts asserts against the aggregate, not against any one file.
 */

import type { ExerciseCase } from './case.js';
import { PAYLOAD_CASES } from './cases/payload.js';
import { SEQUENCE_CASES } from './cases/sequence.js';
import { TRANSPORT_CASES } from './cases/transport.js';

export { PAYLOAD_CASES } from './cases/payload.js';
export { SEQUENCE_CASES } from './cases/sequence.js';
export { TRANSPORT_CASES } from './cases/transport.js';

export const EXERCISE_CASES: readonly ExerciseCase[] = [
  ...PAYLOAD_CASES,
  ...SEQUENCE_CASES,
  ...TRANSPORT_CASES,
];
