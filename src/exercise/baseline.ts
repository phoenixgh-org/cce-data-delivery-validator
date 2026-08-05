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
 * per POST. Deriving a distinct `meta.transferId` from them is not a quirk of any
 * one generator but an OBLIGATION every generator owes — see the contract on
 * {@link BaselineGenerator}. What a case must NOT rely on is the SHAPE of that
 * id, nor on the rest of the payload being identical from call to call: a case
 * that needs two POSTs to look alike says so with `setTransferId`, which is how
 * sequence cases stay generator-agnostic (see the note on that transform in
 * ./transforms/payload.ts).
 *
 * Two generators ship today — {@link fixtureBaseline} (rtm) and
 * {@link emsBaseline} — and {@link BASELINE_GENERATORS} lists them, so the
 * contract tests in ./case.test.ts hold a third one honest the day it lands.
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
 * Produces one canonical, schema-VALID baseline payload.
 *
 * THE CONTRACT — three obligations, owed by EVERY generator, not just the ones
 * shipped here. `./case.test.ts` asserts all three against every entry of
 * {@link BASELINE_GENERATORS}, so a generator added later is held to them
 * without a new test being written (b8r).
 *
 *  1. SCHEMA-VALID. The payload must validate clean, with the real Ajv build,
 *     against the registered schema version it names in `meta.schemaVersion`.
 *     Everything the case table does is expressed as a mutation OF the baseline
 *     — a `fail`-direction case is "the conformant payload, minus one thing" —
 *     so a baseline that is already invalid makes every case meaningless.
 *  2. FRESH. A fresh, fully owned object on every call: transforms mutate what
 *     they are given, so two POSTs must never share structure.
 *  3. A DISTINCT `meta.transferId` PER (caseId, index). Two different requests
 *     must never yield the same id (b8r; the defect it prevents is 5xi). The
 *     runner plays the WHOLE table against ONE session and §1.8 is
 *     session-scoped: a generator holding `transferId` constant — the obvious
 *     shape for one seeded from ../ems-data-simulator output — would make every
 *     non-replay case in the table record a §1.8 fail from table ordering
 *     alone, pass-direction cases included, and would poison the dashboard the
 *     runner points at. Deriving the id per POST also keeps the serialized bytes
 *     distinct, which clears the content-replay flavour of the same check.
 *
 *     This is an obligation on the GENERATOR because it cannot be discharged
 *     anywhere else: `materializePost` does not touch the payload a generator
 *     returns, and a case that wants a repeat pins it with `setTransferId`
 *     (which runs after the generator and overwrites whatever it produced).
 */
export type BaselineGenerator = (request: BaselineRequest) => TransmissionPayload;

/**
 * The per-POST transferId every generator is obliged to stamp (contract clause 3
 * on {@link BaselineGenerator}). Kept here rather than copied into each
 * generator so the two ship one id scheme, and so the whole-table uniqueness
 * invariant in ./cases.test.ts holds across a session that mixes them: case ids
 * are unique table-wide, so `<caseId>#<index>` is too.
 */
function transferIdFor(request: BaselineRequest): string {
  return `${request.caseId}#${request.index}`;
}

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
  payload.meta.transferId = transferIdFor(request);
  return payload;
};

/**
 * A conformant EMS transmission on the current schema version — the seed for
 * {@link emsBaseline} (1m8).
 *
 * WHY IT IS HAND-BUILT HERE rather than reused the way the rtm baseline reuses
 * `src/ingest/fixtures/transmissions.ts`: there is no EMS ingest fixture to
 * reuse. That module is the conditional-FAILURE fixture set (§6 stage per
 * status), and its one valid payload is rtm. The exercise suite is the only
 * consumer of an EMS baseline today, so it owns this one; if the ingest tests
 * ever need an EMS body, move this there and clone it, do not fork it.
 *
 * WHY THESE FIELDS. The root `if/then/else` on `meta.transferType` sends an
 * `ems` payload to `$defs/ems-report`, which is materially larger than the rtmd
 * branch, and both it and `$defs/ems-record` carry `oneOf`s the rtmd side has
 * none of. A baseline has to pick ONE branch of each; the choices, and the way
 * each `oneOf` is satisfied EXCLUSIVELY (a `oneOf` fails if two branches match,
 * so satisfying both is a violation, not extra credit):
 *
 *   - LSV and EMSV at REPORT level, and in NO record. The report-level `oneOf`
 *     offers "on the report" xor "on every record"; putting the version strings
 *     in both places matches both branches and fails validation.
 *   - MAINS power: `SVA` on every record, and neither `DCSV` nor `DCCD` on any.
 *     The solar branch is the mirror (`DCSV` + `DCCD`, no `SVA`), and each branch
 *     carries an explicit `not` against the other's fields.
 *   - TVC NUMERIC, the record `oneOf`'s "normal case". The abnormal branch is
 *     `TVC: null` with a non-empty `LERR` naming the sensor fault; a numeric TVC
 *     with `LERR: null` matches the normal branch only.
 *
 * READING VALUES ARE INSIDE ANNEX-1 BOUNDS, which outrank the schema's own where
 * the two disagree (CLAUDE.md). Verified against Annex 1 of E006/DS01.2 rather
 * than against the schema keywords: SVA/CMPR/DORV 0–900 s per 15-minute period,
 * TAMB/TVC −55–60 °C, BLOG 0–9999 d, BEMD 0–9999.9 d, HAMB 0–100 %RH, HOLD
 * 0–999.9 d. The 15-minute record cadence is the period those per-period objects
 * are defined over, and being evenly spaced it also earns a §3.4 pass rather
 * than leaving the cadence heuristic with nothing to grade.
 */
const emsTransmission = {
  meta: {
    schemaVersion: '0.8.1',
    transferType: 'ems',
    transferId: 'T-ems-baseline',
    transferSrc: 'com.example',
    transferredAt: '2024-01-15T04:05:54Z',
  },
  data: [
    {
      CID: 'US',
      ADOP: '2020-12-01',
      AMFR: 'Alpha Fridge, Inc',
      AMOD: 'FRIDGE-100',
      APQS: 'E003/998',
      ASER: 'A-SerialNum',
      EDOP: '2021-06-01',
      EMFR: 'EMD_Name',
      EMOD: 'EMD-ModelNo',
      EPQS: 'E006/999',
      ESER: 'EMD-SerialNum',
      EMSV: 'v01.02.123',
      LDOP: '2021-08-15',
      LMFR: 'Logger_Co',
      LMOD: 'Logger_Model',
      LPQS: 'E006/998',
      LSER: 'log4567890asdf',
      LSV: 'v01.02.008',
      records: [
        {
          ABST: '20240115T033000Z',
          ALRM: null,
          BEMD: 13.2,
          BLOG: 367,
          CMPR: 320,
          DORV: 0,
          EERR: null,
          LERR: null,
          HAMB: 58,
          HOLD: 4.6,
          SVA: 900,
          TAMB: 23.1,
          TVC: 4.7,
        },
        {
          ABST: '20240115T034500Z',
          ALRM: null,
          BEMD: 13.2,
          BLOG: 367,
          CMPR: 285,
          DORV: 45,
          EERR: null,
          LERR: null,
          HAMB: 58.1,
          HOLD: 4.5,
          SVA: 900,
          TAMB: 23,
          TVC: 4.9,
        },
        {
          ABST: '20240115T040000Z',
          ALRM: null,
          BEMD: 13.1,
          BLOG: 367,
          CMPR: 300,
          DORV: 0,
          EERR: null,
          LERR: null,
          HAMB: 58.3,
          HOLD: 4.5,
          SVA: 900,
          TAMB: 22.9,
          TVC: 4.6,
        },
      ],
    },
  ],
} as const;

/**
 * The EMS-branch baseline (1m8) — the same deal as {@link fixtureBaseline} on
 * the other side of the root `transferType` conditional: deterministic, a fresh
 * deep copy per call, and `meta.transferId` stamped per POST.
 *
 * It exists because the schema's ems branch was exercised NOWHERE — the case
 * table was rtm-only, so `ems-report`, `ems-record` and their `oneOf`s had never
 * been validated by this repo in either direction, live or in CI. EMS suppliers
 * are the primary E006 audience; RTMD is the interop schema's deviation.
 *
 * NOT the default: {@link DEFAULT_BASELINE} stays rtm so the existing table is
 * untouched. A case reaches this one through `materializeCase(kase, { baseline })`.
 */
export const emsBaseline: BaselineGenerator = (request) => {
  // structuredClone yields a deep mutable copy at runtime, but its return type
  // inherits the `as const` deep-readonly shape — cast via `unknown` (TS2352).
  const payload = structuredClone(emsTransmission) as unknown as TransmissionPayload;
  payload.meta.transferId = transferIdFor(request);
  return payload;
};

/**
 * Every baseline generator this repo ships, keyed by export name.
 *
 * The list exists so the {@link BaselineGenerator} contract can be asserted
 * ONCE, generically, over whatever is registered (./case.test.ts) instead of
 * once per generator — the failure mode b8r describes is a generator added later
 * that quietly breaks clause 3, and a per-generator test cannot catch a
 * generator nobody has written yet. Register a new generator here when you add
 * one; that is the whole registration step.
 */
export const BASELINE_GENERATORS: Readonly<Record<string, BaselineGenerator>> = {
  fixtureBaseline,
  emsBaseline,
};

/** The generator used when a caller does not supply one. */
export const DEFAULT_BASELINE: BaselineGenerator = fixtureBaseline;
