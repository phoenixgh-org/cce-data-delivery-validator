/**
 * PAYLOAD-domain exercise cases — the §3.x requirements graded from WHAT is in
 * the transmission body: schema conformance (§3.2) and manufacturer-specific data
 * objects (§3.1).
 *
 * OWNERSHIP: this file is the payload table (8qa.4). Transport cases live in
 * ./transport.ts and the sequence heuristics in ./sequence.ts; ../cases.ts is the
 * index that concatenates the three into `EXERCISE_CASES`.
 *
 * Grouping here is by REQUIREMENT DOMAIN, not by `fault.layer`: §3.4's cadence
 * cases also carry a payload-layer fault but belong to the sequence heuristics
 * (§1.8/§2.1/§3.4) and so live in ./sequence.ts.
 */

import type { ExerciseCase } from '../case.js';
import {
  addCustomDataObject,
  declareCustomDataSchema,
  dropRequiredField,
  setInvalidValue,
  setSchemaVersion,
  setUnsupportedSchemaVersion,
} from '../transforms/payload.js';

export const PAYLOAD_CASES: readonly ExerciseCase[] = [
  // ── §3.2 schema validation ────────────────────────────────────────────────
  {
    id: '3.2-pass-baseline',
    title: 'The untouched baseline validates against the current schema',
    requirements: ['3.2'],
    direction: 'pass',
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
  },
  {
    id: '3.2-fail-missing-required-field',
    title: 'A data report missing the required AMID is rejected 422',
    requirements: ['3.2'],
    direction: 'fail',
    fault: { layer: 'payload', note: 'AMID removed from the lone data report' },
    posts: [{ transforms: [dropRequiredField('/data/0/AMID')], expectedStatus: 422 }],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },
  {
    id: '3.2-fail-out-of-enum-transfer-type',
    title: 'A transferType outside the schema enum is rejected 422',
    requirements: ['3.2'],
    direction: 'fail',
    fault: { layer: 'payload', note: 'meta.transferType set to a value outside the rtm/ems enum' },
    posts: [
      { transforms: [setInvalidValue('/meta/transferType', 'thermometer')], expectedStatus: 422 },
    ],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },
  {
    id: '3.2-fail-reading-out-of-annex-1-bounds',
    title: 'A TVC reading above the Annex-1 maximum is rejected 422',
    requirements: ['3.2'],
    direction: 'fail',
    // The bounds flavour of a §3.2 violation, distinct from a missing field or a
    // bad enum: 0.8.1 gives TVC `minimum: -55 / maximum: 60`, so 999 °C trips
    // Ajv's `maximum` keyword. Worth its own case because bounds are the one
    // place the house precedence rule inverts — Annex 1 outranks the schema
    // (CLAUDE.md) — so this is the mutant that would notice a bounds edit.
    fault: { layer: 'payload', note: 'TVC set to 999, far above the Annex-1 maximum of 60' },
    posts: [{ transforms: [setInvalidValue('/data/0/records/0/TVC', 999)], expectedStatus: 422 }],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },
  {
    id: '3.2-fail-unsupported-schema-version',
    title: 'A schemaVersion the registry does not carry is rejected 422 before Ajv runs',
    requirements: ['3.2'],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note: 'meta.schemaVersion names 0.7.0, which the registry does not carry',
    },
    posts: [{ transforms: [setUnsupportedSchemaVersion('0.7.0')], expectedStatus: 422 }],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },
  {
    id: '3.2-pass-outdated-schema-version',
    title:
      'A valid transmission on the older registered 0.8.0 is accepted 200 and flagged outdated',
    requirements: ['3.2'],
    direction: 'pass',
    // ── THE PASS-OUTDATED CASE (8qa.4; 2kx) ──────────────────────────────────
    //
    // Was '3.2-fail-superseded-schema-version', which asserted 0.8.0 got a 422
    // for missing the registry. That is no longer what happens: 0.8.0 is
    // registered again (bd 8qa.4, 2026-08-04, amending fvw), specifically so an
    // OUTDATED COHORT exists and this third §3.2 case can be written honestly.
    //
    // The branch it exercises: a body that validates cleanly against a
    // REGISTERED-but-older version is ACCEPTED. src/ingest/stages/schema.ts sets
    // schemaOk, then compares the resolved version against
    // `registry.currentVersion()` and — because they differ — records severity
    // `info` carrying `outdated: true` (code `tx.outdated_schema`) INSTEAD of the
    // §3.2 pass a current-version transmission earns. src/api/compliance-matrix.ts
    // then renders the row `pass-outdated` off that modifier, which is the whole
    // point: an outdated-but-valid session must not read as `untested` (2kx).
    //
    // WHY `severity: 'info'` IS THE OUTDATED ASSERTION. expectedFindings matches
    // on (requirement, severity) only, so it cannot name the `outdated` flag
    // directly — but schema.ts is the sole producer of §3.2 findings and its ONLY
    // `info` branch is the outdated one (every other branch is pass or fail). A
    // §3.2 info therefore cannot arise except from `outdated: true`. Pair that
    // with the 200 and this case pins accepted-and-flagged rather than merely
    // accepted. The CI half — that 0.8.0 really is registered, really is NOT
    // current, and really does validate this payload under its own draft-07
    // bytes — is asserted in ../cases.test.ts, which is also what now trips if
    // the registry's shape changes under this case (bd aur).
    //
    // The baseline is sent UNMODIFIED apart from the version string, having been
    // verified to validate against 0.8.0's draft-07 bytes as well as 0.8.1's
    // 2020-12 ones. The two releases do differ on numeric bounds — ACCD moved
    // from `0.01–49.99` to `0–50` and BLOG's ceiling from 9999.9 to 9999 — but
    // the fixture carries neither object, and 0.8.0 constrains `schemaVersion`
    // only as a string (no enum), so no baseline tweak was needed and none is
    // declared here. A future baseline that DOES trip a bound must declare the
    // adjustment in this case rather than quietly skipping the older version.
    posts: [{ transforms: [setSchemaVersion('0.8.0')], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'info' }],
  },

  // ── §3.1 manufacturer-specific data objects ───────────────────────────────
  //
  // §3.1 grades ONE conditional (src/ingest/stages/semantic/custom-schema.ts):
  // meta.customDataSchema is owed only when the payload carries custom data
  // objects. The three cases below are its three outcomes — conditional not
  // applicable, discharged, breached — and the fourth adds the second detection
  // branch (custom by elimination). All of them are schema-valid and reach 200:
  // every relevant $def in 0.8.1 is `additionalProperties: true`, which is why
  // this is graded semantically rather than by Ajv.
  {
    id: '3.1-pass-no-custom-objects',
    title: 'A payload with no manufacturer-specific objects passes §3.1 vacuously',
    requirements: ['3.1'],
    direction: 'pass',
    // The commonest real transmission, and the branch that says so out loud: the
    // stage records a §3.1 pass whose detail is "the conditional did not apply".
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.1', severity: 'pass' }],
  },
  {
    id: '3.1-pass-declared-custom-object',
    title: 'A custom data object declared via meta.customDataSchema passes §3.1',
    requirements: ['3.1'],
    direction: 'pass',
    posts: [
      {
        transforms: [
          addCustomDataObject('ztpcm', 4.2),
          declareCustomDataSchema('https://example.invalid/schemas/ztpcm-1.0.0.json'),
        ],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [{ requirement: '3.1', severity: 'pass' }],
  },
  {
    id: '3.1-fail-undeclared-custom-object',
    title: 'A z-prefixed custom object with no meta.customDataSchema fails §3.1 (still 200)',
    requirements: ['3.1'],
    direction: 'fail',
    // `ztpcm` is clause-4.5 conformant (lower-case, z-prefixed), so the stage's
    // `^z[a-z0-9]*$` branch detects it and the ONLY finding it draws is the
    // conditional's §3.1 fail — no naming note to confuse the signal. The
    // undeclared-and-badly-named pairing is the next case's job.
    fault: {
      layer: 'payload',
      note: 'ztpcm added to a record with no meta.customDataSchema declaration',
    },
    posts: [{ transforms: [addCustomDataObject('ztpcm', 4.2)], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.1', severity: 'fail' }],
  },
  {
    id: '3.1-fail-custom-by-elimination',
    title: 'A custom object named customTemp fails §3.1 and draws the clause-4.5 naming note',
    requirements: ['3.1'],
    direction: 'fail',
    // The stage's second detection branch: `customTemp` is neither z-prefixed nor
    // DS01-code-SHAPED nor a mis-cased known code, so it is custom BY ELIMINATION
    // — it drives the same conditional AND adds the informational naming finding
    // for breaking clause 4.5. Both are asserted: the info finding is the only
    // place we observe that a supplier's naming was noticed rather than silently
    // graded, and expectedFindings is presence-based, so listing it costs nothing
    // if the stage grows further notes.
    fault: {
      layer: 'payload',
      note: 'customTemp added to a record: custom by elimination, undeclared, and misnamed',
    },
    posts: [{ transforms: [addCustomDataObject('customTemp', 4.2)], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: '3.1', severity: 'fail' },
      { requirement: '3.1', severity: 'info' },
    ],
  },
];
