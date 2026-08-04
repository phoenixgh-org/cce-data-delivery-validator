/**
 * The exercise suite's BASELINE payload generator (8qa.1; epic 8qa design notes).
 *
 * Every exercise case is "one canonical baseline × a named transform vocabulary"
 * (see ./transforms/). The baseline itself is deliberately behind a FUNCTION
 * rather than a constant so it can be swapped later — e.g. for simulator-grade
 * realism from ../ems-data-simulator (seeded PRNG) — without touching the case
 * table or the future live runner. That is the whole point of this module: it is
 * the one seam where "what a conformant transmission looks like" is decided.
 *
 * The initial implementation is seeded from the hand-built valid fixture in
 * src/ingest/fixtures/transmissions.ts. We REUSE that fixture rather than fork
 * it: it is already the repo's single source of truth for "a transmission that
 * reaches the §6 happy-path 200", and a second hand-built copy would drift.
 *
 * A generator receives the ordinal of the POST it is producing within its case,
 * so a future stateful/randomizing generator can vary payload content per POST.
 * The fixture generator ignores it and returns an identical deep clone each
 * time. Cases must NOT rely on that identity — see the note on `setTransferId`
 * in ./transforms/payload.ts for how sequence cases stay generator-agnostic.
 */

import { cloneValid } from '../ingest/fixtures/transmissions.js';

/**
 * The mutable shape a payload transform operates on: the `{ meta, data }` object
 * of a `cce-interop` transmission, typed loosely on purpose. Transforms address
 * fields by JSON Pointer, and a mutant is frequently NOT schema-shaped (that is
 * the point of a fail-direction case), so a precise generated type would fight
 * the vocabulary rather than help it. Structurally compatible with the return of
 * {@link cloneValid}.
 */
export interface TransmissionPayload {
  meta: Record<string, unknown>;
  data: Record<string, unknown>[];
}

/** What a generator is told about the POST it is being asked to produce. */
export interface BaselineRequest {
  /** Id of the case this POST belongs to (a generator may vary by case). */
  readonly caseId: string;
  /** 0-based ordinal of this POST within its case's ordered POST list. */
  readonly index: number;
}

/**
 * Produces one canonical, schema-VALID baseline payload. Must return a fresh,
 * fully owned object on every call: transforms mutate what they are given.
 */
export type BaselineGenerator = (request: BaselineRequest) => TransmissionPayload;

/**
 * The baseline seeded from `src/ingest/fixtures/transmissions.ts` — the valid
 * RTM transmission on the current schema version. Deterministic: every call
 * yields a deep clone of the same payload.
 */
export const fixtureBaseline: BaselineGenerator = () => cloneValid();

/** The generator used when a caller does not supply one. */
export const DEFAULT_BASELINE: BaselineGenerator = fixtureBaseline;
