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
 *
 * Nor is it by PAYLOAD TYPE. The EMS cases added in 1m8 sit in the §3.2 section
 * below rather than in a module of their own: they grade schema conformance like
 * every other §3.2 case, and the only thing that distinguishes them is which
 * baseline they declare. Which schema branch a case exercises is a property to
 * read off the case (`baseline`), not a directory layout.
 */

import { emsBaseline } from '../baseline.js';
import type { ExerciseCase } from '../case.js';
import {
  addCustomDataObject,
  addSolarPowerToMainsRecord,
  declareCustomDataSchema,
  dropRequiredField,
  duplicateVersionStringsIntoRecords,
  setInvalidValue,
  setCompressorAboveSupply,
  setNonIsoDate,
  setSchemaVersion,
  setUnsupportedSchemaVersion,
  swapRecordTimestamps,
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

  // ── §3.2 the EMS branch of the schema (1m8) ───────────────────────────────
  //
  // Everything above sends an rtm-typed payload, because the default baseline is
  // the rtm ingest fixture. The root `if/then/else` on `meta.transferType` means
  // those cases only ever reach `$defs/rtmd-report` and `$defs/rtmd-record`, so
  // until these three cases landed the ems branch — the LARGER one, and the one
  // EMS manufacturers (the primary E006 audience) are graded by — was validated
  // nowhere in this repo, live or in CI.
  //
  // The switch is one declared field: `baseline: emsBaseline` (../case.ts). The
  // transforms are unchanged in kind — these are still "the conformant payload,
  // minus one thing" — but the two things they take away exist ONLY on this
  // branch, which is the point. Both are `oneOf` violations, and deliberately the
  // two OPPOSITE ways a `oneOf` can fail: the power case matches no branch, the
  // placement case matches both. Neither error shape had been produced before, by
  // any case, so this is also the first look at how a multi-branch Ajv error set
  // renders in a finding detail and on the dashboard.
  //
  // WHAT IS NOT HERE: a mixed-type payload (rtm and ems reports in one
  // transmission). Dropped from this bite 2026-08-05; the design question is bd
  // dal. Do not add one here without settling that first.
  {
    id: '3.2-pass-ems-baseline',
    title: 'A conformant EMS transmission validates against the current schema',
    requirements: ['3.2'],
    direction: 'pass',
    baseline: emsBaseline,
    posts: [{ expectedStatus: 200 }],
    // The §3.2 pass is what this case CLAIMS. The other two are incidental
    // observations of the EMS baseline's own shape, asserted because they are
    // free (expectedFindings is presence-based) and because they pin behaviour
    // the rtm baseline cannot show:
    //
    //   §3.4 pass — the baseline carries THREE records 15 minutes apart, so the
    //     interval check has two intervals to grade and a CV of 0. The rtm
    //     fixture has a single record, which the check declines to judge at all
    //     (fewer than 2 parseable timestamps → no finding), so this is the only
    //     §3.4 grade the untransformed table earns without a cadence transform.
    //   §3.1 pass — every key in the payload is a declared DS01 code, so the
    //     custom-object scan finds nothing: the conditional does not apply, and
    //     there is no clause-4.5 naming note to muddy the signal either.
    //
    // Neither is added to `requirements`: coverage counts what a case TARGETS,
    // not what it happens to observe (./runner/coverage.ts), and an EMS payload
    // that quietly counted as a §3.4 exercise would be exactly the kind of
    // inflated coverage this suite refuses to print.
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '3.4', severity: 'pass' },
      { requirement: '3.1', severity: 'pass' },
    ],
  },
  {
    id: '3.2-fail-ems-mains-and-solar-power',
    title: 'An EMS record carrying both the mains and the solar power objects is rejected 422',
    requirements: ['3.2'],
    direction: 'fail',
    baseline: emsBaseline,
    // `ems-record`'s power `oneOf` describes an appliance that is mains-powered
    // (SVA) XOR solar-powered (DCSV + DCCD), and each branch carries an explicit
    // `not` against the other's fields — so a record claiming both matches
    // NEITHER branch. Zero matches violates a `oneOf` just as two do, and the
    // resulting error set names both branches at once.
    fault: {
      layer: 'payload',
      note: 'DCSV+DCCD added to a record that keeps SVA, so it matches neither power branch',
    },
    posts: [{ transforms: [addSolarPowerToMainsRecord()], expectedStatus: 422 }],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },
  {
    id: '3.2-fail-ems-version-strings-in-both-places',
    title: 'An EMS report carrying LSV/EMSV both on the report and in every record is rejected 422',
    requirements: ['3.2'],
    direction: 'fail',
    baseline: emsBaseline,
    // `ems-report` lets a supplier put each version string EITHER on the report
    // OR on every record — two branches of a `oneOf` per string. The baseline
    // takes the report-level branch; copying the strings into the records as well
    // satisfies BOTH branches, and a `oneOf` matched twice is violated. The
    // opposite failure mode to the case above, and the reason both are here.
    fault: {
      layer: 'payload',
      note: 'LSV and EMSV copied into every record while left on the report, matching both branches',
    },
    posts: [{ transforms: [duplicateVersionStringsIntoRecords()], expectedStatus: 422 }],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
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

  // ── advisories (adv.*) — observations that grade nothing (agj.1) ───────────
  //
  // THE ADVISORY CASE PATTERN. Every later advisory case copies this shape, so
  // read it before adding one:
  //
  //   requirements: []          an advisory is NOT a §7 requirement and can never
  //                             move one (src/ingest/stages/semantic/advisory.ts).
  //                             `requirements` feeds the coverage join, which is a
  //                             join onto COMPLIANCE_MATRIX — naming an `adv.*` id
  //                             there would be a claim nobody joins to. The advisory
  //                             is named in `expectedFindings` instead, which
  //                             ../cases.test.ts admits `adv.*` ids into precisely
  //                             for this.
  //   direction: 'fail'         the case sends traffic the validator is meant to
  //     + fault {layer}         NOTICE, and it names what it planted — the same
  //                             contract every fail-direction case carries. The
  //                             payload is schema- and requirement-CONFORMANT, so
  //                             the "show your work" evidence is the advisory
  //                             itself, not a fail finding (../cases.test.ts spells
  //                             that exemption out).
  //   expectedStatus: 200       an advisory never changes the response code.
  //   expectedFindings          exactly `severity: 'info'` — the only severity an
  //                             advisory is ever built with.
  //
  // The EMS baseline is what carries ADOP (the rtm baseline has only EDOP), so an
  // advisory case that wants a report-level date declares it.
  {
    id: 'adv.date_format-fail-unpadded-production-date',
    title: 'An appliance production date sent as 2026-7-4 is observed, and grades nothing',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note: "ADOP set to '2026-7-4' — a real date, without the ISO-8601 fixed field widths",
    },
    posts: [{ transforms: [setNonIsoDate('/data/0/ADOP', '2026-7-4')], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.date_format', severity: 'info' }],
  },

  // The EMS baseline is also what carries a MULTI-RECORD series (the rtm
  // baseline has a single record, and one record has no order to observe), so an
  // advisory case about record order declares it.
  {
    id: 'adv.time_not_increasing-fail-swapped-readings',
    title: 'Two readings delivered in the reverse of the order they were logged',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        'the first two records swap ABST, so the series steps 15 minutes backwards at ' +
        '/data/0/records/1 while every value stays a well-formed ABST',
    },
    posts: [{ transforms: [swapRecordTimestamps(0, 1)], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.time_not_increasing', severity: 'info' }],
  },

  // SVA lives on the MAINS branch of ems-record.allOf[0] — the rtm branch has no
  // such partition and RTMDs do not measure compressor runtime at all — so this
  // one declares the EMS baseline, which is already a mains record.
  {
    id: 'adv.compressor_exceeds_supply-fail-runtime-past-supply',
    title: 'A compressor credited with running longer than power was available',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        'the first record reports CMPR 420 s against SVA 200 s — both inside the schema’s own ' +
        '0–900 bounds, which it applies to each object independently',
    },
    posts: [{ transforms: [setCompressorAboveSupply(420, 200)], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.compressor_exceeds_supply', severity: 'info' }],
  },
];
