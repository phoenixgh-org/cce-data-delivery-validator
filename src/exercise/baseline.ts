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
 * A generator receives the case id and the ordinal of the POST it is producing
 * within that case, so a stateful/randomizing generator can vary payload content
 * per POST. The fixture generator uses them for exactly one thing — a distinct
 * `meta.transferId` per POST (see {@link fixtureBaseline}) — and is otherwise a
 * deep clone of the same fixture every time. Cases must NOT rely on either
 * property: a case that needs two POSTs to look alike says so with
 * `setTransferId`, which is how sequence cases stay generator-agnostic (see the
 * note on that transform in ./transforms/payload.ts).
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
 * RTM transmission on the current schema version. Deterministic: the same
 * request always yields the same payload, and every call yields a fresh object.
 *
 * The one field NOT taken from the fixture is `meta.transferId`, which is
 * stamped `<caseId>#<index>` from the request. The fixture's constant
 * `T-baseline` is fine for a lone POST but poison for a table: the runner plays
 * the WHOLE table against ONE session, and the §1.8 check flags a repeat when a
 * prior transmission in that session carries an equal transferId OR equal
 * content bytes (src/ingest/stages/semantic/duplicate.ts). A shared id would
 * make unrelated cases — pass-direction ones included — record a §1.8 fail
 * caused purely by table ordering, and would poison the dashboard the runner
 * points at (5xi). Deriving the id per POST also makes the serialized bytes
 * distinct, so the content-replay flavour of the same check cannot trip either.
 *
 * Cases that WANT a duplicate pin the id themselves on every POST with
 * `setTransferId`, which runs after this and overwrites it.
 */
export const fixtureBaseline: BaselineGenerator = (request) => {
  const payload = cloneValid();
  payload.meta.transferId = `${request.caseId}#${request.index}`;
  return payload;
};

/** The generator used when a caller does not supply one. */
export const DEFAULT_BASELINE: BaselineGenerator = fixtureBaseline;
