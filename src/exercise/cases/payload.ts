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

import { ADVISORY_IDS } from '../../ingest/stages/semantic/advisory.js';
import { emsBaseline } from '../baseline.js';
import type { ExerciseCase } from '../case.js';
import {
  addCustomDataObject,
  addSolarPowerToMainsRecord,
  appendSecondReport,
  blankAdminObject,
  blankExplanationNullTemperature,
  blankAdminObjects,
  blankApplianceMonitoringId,
  declareCustomDataSchema,
  dropRequiredField,
  duplicateVersionStringsIntoRecords,
  explainedNullRuntimeDuringOutage,
  explainedNullTemperature,
  longSamplePeriod,
  nullAdminObject,
  nullApplianceSerial,
  nullPaddedSeries,
  nullRuntimeDuringOutage,
  nullTemperatureWithErrorCode,
  repeatRecord,
  setInvalidValue,
  setCompressorAboveSupply,
  setMinutesShapedCompressor,
  setNonIsoDate,
  setSchemaVersion,
  setUnsupportedSchemaVersion,
  shortApplianceMonitoringId,
  shortApplianceSerial,
  solarPoweredRecords,
  swapRecordTimestamps,
  unexplainedNullTemperature,
} from '../transforms/payload.js';

export const PAYLOAD_CASES: readonly ExerciseCase[] = [
  // ── §3.2 schema validation ────────────────────────────────────────────────
  {
    id: '3.2-pass-baseline',
    title: 'The untouched baseline validates against the current schema, and raises no advisory',
    requirements: ['3.2'],
    direction: 'pass',
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
    // ── THE WHOLE CATALOGUE, DECLARED SILENT (496w) ──────────────────────────
    //
    // A conformant baseline is the one payload every advisory is obliged to say
    // nothing about, so this case names the whole registered set rather than a
    // chosen few.
    // `fired 14` in the coverage report says each advisory is REACHABLE; this is
    // the other half of the catalogue's contract — that none of them speaks on
    // traffic that breaks nothing. Before `absentFindings` existed neither case
    // nor runner could state it.
    //
    // Reading the list off `ADVISORY_IDS` keeps the table DATA while making the
    // registry the author of it: a fifteenth check lands here automatically, so
    // a new advisory that fires on a conformant rtm payload fails this case
    // instead of arriving unnoticed. The ids are contract-profile by default,
    // which is the only lineage that grades advisories.
    absentFindings: ADVISORY_IDS.map((id) => ({ requirement: id })),
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
    // THE CASE NAMES THE OUTDATED FLAG DIRECTLY (73r). `expectedFindings` carries
    // an optional `outdated` matcher, so the expectation below demands the
    // modifier itself: `info` + `outdated: true`, which is precisely what the
    // stage records. Paired with the 200, this pins accepted-and-flagged rather
    // than merely accepted.
    //
    // HISTORY, because the reasoning used to be indirect. Until 73r an
    // expectation could name only (requirement, severity), so this case asserted
    // `severity: 'info'` and leaned on schema.ts being the sole producer of §3.2
    // findings with exactly one `info` branch — the outdated one. That inference
    // held, but a second §3.2 info branch would have weakened the assertion
    // silently. Nothing about it is relied on now.
    //
    // The CI half — that 0.8.0 really is registered, really is NOT current, and
    // really does validate this payload under its own draft-07 bytes — is
    // asserted in ../cases.test.ts, which is also what trips if the registry's
    // shape changes under this case (bd aur).
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
    expectedFindings: [{ requirement: '3.2', severity: 'info', outdated: true }],
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
    // The same all-advisories silence '3.2-pass-baseline' declares (496w), on the
    // other branch of the schema — and it carries more weight here, because the
    // EMS baseline is what most of the advisory catalogue is written against.
    // Three of the registered checks need no case of their own as a result:
    // `adv.cmpr_minutes` is silent on this seconds-valued feed (CMPR 320/285/300
    // against SVA 900), `adv.duplicate_records` on three records that share
    // nothing, and `adv.null_accumulator` on a supply that never went to zero.
    absentFindings: ADVISORY_IDS.map((id) => ({ requirement: id })),
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

  // ── §3.2 the EMS record's TVC/LERR conditional (ftx0) ─────────────────────
  //
  // The THIRD rule the ems branch carries that the rtm branch does not, and the
  // one the advisory layer's design rests on. `ems-record`'s record-level `allOf`
  // partitions every record two ways, exclusively: NORMAL — `TVC` present and a
  // number — xor ABNORMAL — `TVC` null, with a `LERR` string of `minLength` 1
  // naming the sensor fault. `EERR` does not satisfy it; `LERR` specifically
  // does. Both registered `cce-interop` versions carry the rule and the DS01.3
  // Annex 4 draft keeps it unchanged.
  //
  // The pair below is the rule in both directions, and together they turn a
  // header comment into a measured fact of the live instance: a null temperature
  // with NOTHING at all to explain it is a §3.2 SCHEMA failure on EMS, not an
  // advisory gap. That is where `adv.unexplained_null_temp` stops on this branch
  // (src/ingest/stages/semantic/unexplained-null-temp.ts) — not at the branch
  // itself. `minLength: 1` counts characters rather than content, so a LERR of
  // blank space validates and the advisory's EMS arm covers that one shape;
  // `adv.unexplained_null_temp-fail-ems-blank-logger-error-code` below is that
  // case. Before these cases the two EMS §3.2 fail cases covered the power
  // `oneOf` and the version-strings `oneOf` only, and nothing anywhere pinned
  // this one.
  {
    id: '3.2-fail-ems-null-tvc-without-lerr',
    title: 'An EMS record with a null TVC and no error code beside it is rejected 422',
    requirements: ['3.2'],
    direction: 'fail',
    baseline: emsBaseline,
    // The baseline record sends `LERR: null`, so nulling TVC alone leaves the
    // record matching NEITHER branch — the same zero-match shape as the power
    // case above, from the other conditional.
    fault: {
      layer: 'payload',
      note:
        'TVC set to null on the first record while LERR stays at the baseline’s null, so the ' +
        'record satisfies neither the normal nor the abnormal branch of ems-record’s TVC/LERR ' +
        'oneOf',
    },
    posts: [{ transforms: [setInvalidValue('/data/0/records/0/TVC', null)], expectedStatus: 422 }],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },
  {
    id: '3.2-pass-ems-null-tvc-explained',
    title: 'An EMS record with a null TVC explained by a logger error code is accepted 200',
    requirements: ['3.2'],
    direction: 'pass',
    baseline: emsBaseline,
    // The ABNORMAL branch, and the only place in the table a null TVC on the ems
    // branch is exercised at all. It is a PASS case because the schema says so:
    // a reading that did not arrive is conformant once the supplier says why.
    // Measured under both lineages — the Annex 4 draft carries the same rule, so
    // the shadow run has nothing to add on this record either.
    //
    // `adv.null_padding` stays silent: the EMS baseline is three records, a
    // quarter of the twelve that check requires before it will call a column
    // padded, so the lone null here is not read as padding.
    //
    // `adv.unexplained_null_temp` IS DECLARED SILENT (496w). The advisory's EMS
    // arm reads only whether the logger error code is BLANK SPACE (xwgr); `E12`
    // is a real code, so a null TVC explained by one draws nothing. This payload
    // is where that boundary is measured from the explained side, and
    // `adv.unexplained_null_temp-fail-ems-blank-logger-error-code` measures it
    // from the other.
    posts: [{ transforms: [explainedNullTemperature()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
    absentFindings: [{ requirement: 'adv.unexplained_null_temp' }],
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

  // THE SILENCE HALF of the same check (496w), and the first case in the table
  // to assert one advisory's silence on its own rather than the whole catalogue's.
  // `adv.compressor_exceeds_supply` documents solar records as out of scope — DCSV
  // is a voltage, and no object on the solar branch says for how long DC power was
  // available, so there is nothing a compressor runtime could be read against
  // (src/ingest/stages/semantic/compressor-supply.ts, "SOLAR RECORDS ARE OUT OF
  // SCOPE"). That rule is what this case measures live: the check selects mains
  // records by the PRESENCE of SVA and skips a solar one before reading any
  // runtime, so no CMPR value would make this payload speak.
  //
  // CMPR 900 IS A PROPERTY OF THE VALUE, NOT A COUNTERFACTUAL (vxt9). It is the
  // schema's own maximum for the object — the longest runtime a 15-minute period
  // can hold — and that is worth planting, but it does not make this a payload
  // the check would have spoken on had the record been mains. The check fires only
  // on a strict excess, and emsBaseline reports SVA 900 on every record, so the
  // mains form of this payload is conformant arithmetic too.
  //
  // WHAT PROVES THE CHECK FIRES on the mains branch is the paired case above,
  // adv.compressor_exceeds_supply-fail-runtime-past-supply (CMPR 420 against
  // SVA 200). Read the two together: that one shows the arithmetic, this one shows
  // the branch on which the check declines to do it.
  //
  // The shadow run has nothing to add: the Annex 4 draft carries the mains/solar
  // partition unchanged, so this payload validates under both lineages (measured
  // against the vendored bytes) and the case names no ds013 finding.
  {
    id: '3.2-pass-ems-solar-powered-records',
    title: 'A solar appliance reporting a full-period compressor runtime draws no advisory',
    requirements: [],
    direction: 'pass',
    baseline: emsBaseline,
    posts: [{ transforms: [solarPoweredRecords()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
    absentFindings: [{ requirement: 'adv.compressor_exceeds_supply' }],
  },

  // The other CMPR advisory, and the pair is complementary rather than
  // overlapping: this payload's CMPR never approaches SVA, so
  // adv.compressor_exceeds_supply cannot see it, which is exactly why agj.7
  // exists alongside agj.3. The transform synthesizes 12 records because the
  // advisory's floor is null-padding's MIN_RECORDS and the EMS baseline is 3.
  {
    id: 'adv.cmpr_minutes-fail-minutes-valued-compressor',
    title: 'Compressor runtimes that never cross 15 — a feed still on the pre-0.8.0 unit',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        '12 records whose CMPR never exceeds 15, six of them at exactly 15 against SVA 900 — ' +
        'legal on 0.8.1 because the 0.7.2 → 0.8.0 unit correction widened CMPR from 0–15 ' +
        'minutes to 0–900 seconds',
    },
    posts: [{ transforms: [setMinutesShapedCompressor()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.cmpr_minutes', severity: 'info' }],
  },

  // The cadence advisory, and the ONLY case in the table where a §3.4 PASS and an
  // advisory ride on the same payload — which is the whole argument for agj.6
  // existing separately from §3.4. It stays on the DEFAULT (rtm) baseline: the
  // 15-minute period is a property of the standard rather than of the EMS record
  // branch, so the rtm branch is where it is worth showing.
  {
    id: 'adv.sample_gap-fail-hourly-readings',
    title: 'Readings taken once an hour — evenly spaced, and four times the DS01 period',
    requirements: [],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note:
        'four readings spaced 60 minutes apart — three consecutive ABST deltas of 3600 s ' +
        'against the 900 s period the per-period accumulators are defined over, while the ' +
        'perfectly even spacing keeps the §3.4 cadence pass (CV 0)',
    },
    posts: [{ transforms: [longSamplePeriod(4, 60)], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: 'adv.sample_gap', severity: 'info' },
      // The §3.4 pass is CASE, not scaffolding: it is the live proof that the
      // advisory reads a question §3.4 cannot see rather than second-guessing a
      // verdict §3.4 already owns.
      { requirement: '3.4', severity: 'pass' },
    ],
  },

  // THE SILENCE HALF of the cadence advisory (496w): the check allows 60 s of
  // leeway on top of DS01's 900 s period, so a delta of exactly 960 s stays quiet
  // and 961 s does not (src/ingest/stages/semantic/sample-gap.ts). The leeway is
  // there to absorb whole-minute ABST stamping, which turns a nominal 900 s
  // cadence into deltas of 840 s or 960 s with no reading missed, and a case that
  // only ever sent hourly readings would leave the boundary itself unmeasured.
  //
  // Sixteen minutes is the boundary exactly. It stays on the DEFAULT (rtm)
  // baseline, beside the fire case it mirrors, and earns the §3.4 pass for the
  // same reason that one does: evenly spaced readings score a CV of 0 however
  // wide the spacing is.
  {
    id: '3.2-pass-rtm-sixteen-minute-sampling',
    title: 'Readings 16 minutes apart — inside the gap check’s leeway, and silent',
    requirements: [],
    direction: 'pass',
    posts: [{ transforms: [longSamplePeriod(4, 16)], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '3.4', severity: 'pass' },
    ],
    absentFindings: [{ requirement: 'adv.sample_gap' }],
  },

  // The duplicate advisory, on the DEFAULT (rtm) baseline: its report carries a
  // single record, so cloning it produces the smallest honest form of PQS's
  // shape — a two-record report holding one reading twice — while every §7
  // verdict stays where it was. §1.8 is the one this case is really measured
  // against: it grades the ENVELOPE (body sha256, transferId) against earlier
  // transmissions, so this payload is novel to it and keeps its pass.
  {
    id: 'adv.duplicate_records-fail-record-delivered-twice',
    title: 'The same reading delivered twice inside one transmission',
    requirements: [],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note:
        'the report’s only record is re-appended to its own records array — a second copy ' +
        'identical in full, sharing the ABST of the first, inside a transmission §1.8 has ' +
        'never seen before',
    },
    posts: [{ transforms: [repeatRecord()], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: 'adv.duplicate_records', severity: 'info' },
      // BOTH observations are owed on this payload and neither is suppressed for
      // the other (agj.8): the record arrived twice, and the series stops
      // stepping forward where the copy lands. Together they reconstruct the
      // assembly that produced them; alone, neither does.
      { requirement: 'adv.time_not_increasing', severity: 'info' },
    ],
  },

  // ASER is a property of the EMS branch and the rtm baseline does not carry it,
  // so this one declares emsBaseline. It plants a populated AID alongside the
  // null ASER deliberately: on the ems branch the advisory reads ASER ALONE
  // (2km), and AID — a programme asset-tracking identifier rather than the
  // manufacturer's serial — is not read as standing in for it. A payload that
  // was silent under the old any-of-three rule is the sharpest thing to pin.
  {
    id: 'adv.null_identity-fail-null-appliance-serial',
    title: 'An appliance serial sent as null, with only a programme asset id alongside it',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        "ASER set to null with AID set to 'asset-tag-9' — legal because ems-report requires " +
        'the ASER key and the shared $defs types it ["string","null"]',
    },
    posts: [{ transforms: [nullApplianceSerial()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.null_identity', severity: 'info' }],
  },

  // THE RTM HALF of the same advisory (c833). `adv.null_identity` reads ONE
  // identifier per branch — ASER on ems, AMID on rtm — with a different
  // observation and a different rationale on each, and until this case only the
  // ems half had ever been rendered live. It takes the DEFAULT (rtm) baseline,
  // whose AMID is the property the check reads there.
  //
  // THE BLANK IS THE ONLY CONFORMANT FORM on this branch, which is what makes the
  // case worth having: rtmd-report REQUIRES AMID and types it a bare "string", so
  // a null and an absent key are §3.2 rejections that never reach stage 8. An
  // empty string is the one shape the schema cannot object to — no minLength and
  // no pattern on any identifier in either registered cce-interop version — and it
  // is exactly the shape the advisory exists for
  // (src/ingest/stages/semantic/null-identity.ts).
  //
  // adv.short_identifier STAYS SILENT and is declared absent (measured): it hands
  // a trimmed length of zero back rather than calling a blank three characters
  // short, so the two checks partition the AMID surface between them and one blank
  // value raises exactly one line.
  //
  // THE SHADOW RUN AGREES, and the fail is OVER-DETERMINED rather than isolated.
  // The Annex 4 draft adds minLength 1 to AMID, so the blank draws
  // `/data/0/AMID minLength` — but the rtm baseline is the readiness demo, which
  // already fails the draft on LDOP/LMFR/LMOD/LPQS/LSER whatever AMID says
  // (measured against the vendored bytes). One clause 5.3.2 entry names both,
  // since the expectation is presence-based.
  {
    id: 'adv.null_identity-fail-blank-rtm-monitoring-id',
    title: 'An rtm report whose supplier-platform appliance identifier arrives empty',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note:
        'AMID set to "" — legal because rtmd-report requires it as a non-null string and ' +
        'carries no minLength, so the empty string is the advisory’s only surface here',
    },
    posts: [{ transforms: [blankApplianceMonitoringId()], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: 'adv.null_identity', severity: 'info' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
    absentFindings: [{ requirement: 'adv.short_identifier' }],
  },

  // The administrative objects the ems branch requires, delivered blank (agj.5).
  // emsBaseline again, because the fields are ems-report's. The two blanks are
  // the two halves of the advisory's conformant surface: AMFR is nullable, so a
  // null satisfies the schema, and LMOD is not, but carries no minLength, so a
  // blank string does. ASER stays populated on purpose — the identity trio is
  // adv.null_identity's (2km), so leaving it alone keeps this case a single
  // observation rather than two.
  {
    id: 'adv.blank_admin-fail-blank-required-admin',
    title: 'Required administrative objects delivered blank, as a null and as an empty string',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        'AMFR set to null and LMOD set to "" — legal because ems-report requires both keys, ' +
        'the shared $defs types AMFR ["string","null"], and nothing on the branch carries a ' +
        'minLength',
    },
    posts: [{ transforms: [blankAdminObjects()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.blank_admin', severity: 'info' }],
  },

  // THE RTM HALF of the same advisory (c833). The field list is branch-specific —
  // CID EDOP EMFR EMOD EPQS ESER on rtmd-report, six objects against the ems
  // branch's fifteen — and the rationale names the branch schema whose `required`
  // list was read, so the rtm sentence had never been rendered live. DEFAULT (rtm)
  // baseline, which carries all six.
  //
  // THE PAIR IS CHOSEN FOR THE SHADOW RUN, not just for the advisory. Both blanks
  // fire adv.blank_admin on the contract lineage, and they differ in what the
  // DS01.3 Annex 4 draft says about them:
  //
  //   - EMFR "" fails the draft, which adds minLength 1 to it (measured:
  //     /data/0/EMFR minLength).
  //   - CID null does NOT. CID is the one admin object the draft leaves
  //     ["string","null"] on BOTH branches, gaining only ^[A-Z]{2}$ (bd memory
  //     annex4-tightens-admin-objects), so a null CID validates under the draft
  //     and the advisory is the only thing that speaks for it.
  //
  // So the case carries the advisory's two conformant blank shapes — a null and an
  // empty string, as the ems case above does — while pinning that the draft closes
  // one of them and not the other.
  //
  // The clause 5.3.2 fail is OVER-DETERMINED, as it is on every case built on this
  // baseline: the readiness demo already fails the draft on the five
  // logger-identity properties. AMID stays populated, so adv.null_identity — which
  // owns that field and is never read here — stays silent.
  {
    id: 'adv.blank_admin-fail-blank-rtm-admin',
    title: 'An rtm report delivering required administrative objects blank',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note:
        'EMFR set to "" and CID set to null — legal because rtmd-report requires both keys, ' +
        'the shared $defs type CID ["string","null"], and nothing on the branch carries a ' +
        'minLength',
    },
    posts: [
      {
        transforms: [blankAdminObject('EMFR'), nullAdminObject('CID')],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: 'adv.blank_admin', severity: 'info' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },

  // THE ONLY MULTI-REPORT CASE IN THE TABLE (c833), and the reason it exists is
  // the SENTENCE. Three advisories phrase their observation as "N of M reports …",
  // and every other case sends a single report, so the denominator had only ever
  // been 1 and the "in the first, …" lead was reachable from a unit test alone.
  // This payload carries two EMS reports for two distinct appliances with the
  // fault in the SECOND, so the count, the pointer and the report noun all have to
  // be right for the case to pass.
  //
  // MEASURED (2026-09-16, the real ADVISORY_CHECKS registry over the materialized
  // payload), the observation reads exactly:
  //
  //     1 of 2 reports delivers required admin objects blank — AMFR is empty.
  //
  // and the finding points at /data/1. Two things in that sentence are only
  // observable on a batch: the denominator is the whole transmission, and the
  // report noun pluralizes on the DENOMINATOR while the verb agrees with the
  // numerator, so "1 of 2 reports delivers" is correct rather than a slip. The
  // "in the first, …" lead stays absent here because only one report is affected.
  //
  // WHY blank_admin CARRIES IT. It is the advisory whose per-report counting is
  // least coupled to anything else in the payload: appendSecondReport gives the
  // clone its own identity, so adv.null_identity and adv.short_identifier see
  // nothing, and the clone's window is a day earlier, so the record-series checks
  // (§3.4, adv.time_not_increasing, adv.sample_gap, adv.duplicate_records) read
  // each report on its own and stay quiet (measured: the untouched two-report
  // payload fires nothing).
  //
  // THE SHADOW RUN IS ISOLATED here, unlike on the rtm cases above: the EMS
  // baseline passes the Annex 4 draft, and the two-report clone of it still does,
  // so the blank AMFR's minLength failure in report 1 is the ONLY thing the draft
  // objects to (measured).
  {
    id: 'adv.blank_admin-fail-second-of-two-ems-reports',
    title: 'A two-report EMS batch whose SECOND report delivers an admin object blank',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        'a second EMS report is appended — the first deep-cloned, its identifiers suffixed and ' +
        'its window moved 24 h earlier — and AMFR is set to "" on that second report only',
    },
    posts: [
      {
        transforms: [appendSecondReport(), blankAdminObject('AMFR', 1)],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: 'adv.blank_admin', severity: 'info' },
      { requirement: '3.2', severity: 'pass' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },

  // A null reading with nothing beside it to account for it (agj.2). This one
  // takes the DEFAULT (rtm) baseline rather than declaring emsBaseline, and that
  // is the case rather than a convenience: ems-record's allOf requires a
  // minLength-1 LERR beside a null TVC in both registered versions, so THIS form
  // of the payload is a §3.2 rejection on EMS and never reaches stage 8. The rtm
  // branch has no such conditional, which is the gap this case covers; the EMS
  // arm's narrower gap has a case of its own two entries below.
  {
    id: 'adv.unexplained_null_temp-fail-null-temperature-no-error-code',
    title: 'A vaccine compartment temperature sent as null with no error code beside it',
    requirements: [],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note:
        'TVC and EERR both set to null on the lone rtm record — legal because rtmd-record ' +
        'types TVC ["number","null"] and EERR ["string","null"] and ties neither to the ' +
        'other; the baseline\'s EERR "none" is cleared because a non-empty string reads as ' +
        'an explanation',
    },
    posts: [{ transforms: [unexplainedNullTemperature()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.unexplained_null_temp', severity: 'info' }],
  },

  // THE SILENCE HALF, on the same branch and the same baseline (496w). The check
  // asks only whether a code is PRESENT and non-blank, and the rtm fixture sends
  // `EERR: "none"` — a non-empty string, and therefore an explanation. Reading
  // that value as a placeholder would be a judgement the receiving side cannot
  // make, which is why the fire case above has to clear the code and why this one
  // proves the quiet branch by leaving it alone.
  //
  // The contract is what this case grades. The default baseline is the readiness
  // demo, so the shadow run fails it on the five logger-identity properties
  // whatever the temperature says; that is `readiness.rtm_identity`'s subject and
  // is deliberately not named here.
  {
    id: '3.2-pass-rtm-null-tvc-with-error-code',
    title: 'A null vaccine compartment temperature beside an error code draws no advisory',
    requirements: [],
    direction: 'pass',
    posts: [{ transforms: [nullTemperatureWithErrorCode()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
    absentFindings: [{ requirement: 'adv.unexplained_null_temp' }],
  },

  // THE EMS ARM (xwgr), and the only advisory case in the table that exists
  // because of what a schema keyword does NOT say. `ems-record`'s abnormal
  // branch asks for a LERR string of `minLength` 1 beside a null TVC, and
  // `minLength` counts CHARACTERS rather than content — so three spaces satisfy
  // the explanation requirement in form while explaining nothing. The record
  // validates, reaches stage 8, and the advisory observes it.
  //
  // The case declares emsBaseline: the conditional it turns on lives on
  // `ems-record`, and there is no rtm analogue. The three shapes either side of
  // it — an absent, `null`, or empty-string LERR — are §3.2 rejections and are
  // covered by `3.2-fail-ems-null-tvc-without-lerr` above, which is what keeps
  // the arm's boundary a measured fact of the live instance rather than a claim
  // in a module header.
  {
    id: 'adv.unexplained_null_temp-fail-ems-blank-logger-error-code',
    title: 'A null vaccine compartment temperature with a logger error code of blank space',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        'TVC set to null on the first EMS record with LERR set to three spaces — legal because ' +
        'ems-record’s abnormal branch asks only for a LERR string of minLength 1, which blank ' +
        'space satisfies',
    },
    posts: [{ transforms: [blankExplanationNullTemperature()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.unexplained_null_temp', severity: 'info' }],
  },

  // An identifier that is present, non-blank, and too short to address a national
  // fleet (krh). It takes the DEFAULT (rtm) baseline: AMID is an rtmd-report
  // property, and the baseline's other identifiers are all long enough that this
  // one value is the whole case. The value stays non-blank so adv.null_identity,
  // which owns the blank AMID, stays silent.
  {
    id: 'adv.short_identifier-fail-three-character-appliance-id',
    title: 'An appliance monitoring ID too short to address a national fleet',
    requirements: [],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note:
        'AMID set to "A1B" — legal because rtmd-report types it a required non-null string and ' +
        'no identifier object in the registered schema versions carries a minLength',
    },
    posts: [{ transforms: [shortApplianceMonitoringId()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.short_identifier', severity: 'info' }],
  },

  // THE EMS HALF of the same advisory (c833). The read list differs by branch —
  // ASER LSER ESER AID LID EID on ems, the same plus AMID and every DLST.<prop>
  // SID on rtm — so the ems branch was carrying six unexercised fields. It
  // declares emsBaseline and shortens ASER, the appliance serial the manufacturer
  // assigns, which is the identifier an EMS is expected to know.
  //
  // ONE VALUE IS THE WHOLE CASE: the baseline's LSER and ESER are both well past
  // the four-character floor and it carries no AID, LID or EID, so ASER is the
  // only thing the check has to say anything about (measured).
  //
  // adv.null_identity STAYS SILENT and is declared absent. It owns ASER on this
  // branch too, but only in its BLANK form — "A1B" is a populated value, and the
  // two checks partition the field between them rather than both speaking.
  //
  // NOTHING FOR THE SHADOW RUN. The Annex 4 draft excludes the null case from
  // ems-report's ASER and adds no length floor to it, so a three-character serial
  // satisfies the draft exactly as it satisfies the contract lineage (measured
  // against the vendored bytes) and the case names no ds013 finding. That is the
  // advisory's own argument for existing: a width problem is not a schema problem
  // on either lineage.
  {
    id: 'adv.short_identifier-fail-three-character-appliance-serial',
    title: 'An appliance serial number too short to address a national fleet',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        'ASER set to "A1B" — legal because ems-report requires the key, the shared $defs type ' +
        'it ["string","null"], and no identifier object in the registered schema versions ' +
        'carries a minLength',
    },
    posts: [{ transforms: [shortApplianceSerial()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: 'adv.short_identifier', severity: 'info' }],
    absentFindings: [{ requirement: 'adv.null_identity' }],
  },

  // A compressor runtime sent as null in a period the same record says carried
  // no AC supply (agj.9). It declares `baseline: emsBaseline`: SVA, CMPR and the
  // mains/solar partition are ems-record properties, and the baseline's other
  // two records keep a numeric CMPR, which is what makes this null the
  // INTERMITTENT one this advisory reads rather than the padded column
  // `adv.null_padding` owns. Both baseline codes are already null, so the null
  // arrives unexplained without touching them.
  //
  // THE SHADOW RUN IS PART OF THE CASE. The DS01.3 Annex 4 draft requires a
  // non-null LERR beside a null CMPR, so the same payload that earns an advisory
  // on the contract lineage earns a clause 5.3.2 fail on the shadow one — the
  // advisory/shadow pairing readiness.date_pattern shows for dates, here for a
  // null accumulator. `requirements: []` because the case targets no matrix row:
  // the §3.2 pass it also earns is the incidental one every accepted POST earns.
  {
    id: 'adv.null_accumulator-fail-null-runtime-during-outage',
    title: 'A compressor runtime sent as null for a period with no AC supply',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        'SVA set to 0 and CMPR to null on one record — legal because ems-record types both ' +
        '["number","null"] and ties a null reading to an explaining LERR for TVC only',
    },
    posts: [{ transforms: [nullRuntimeDuringOutage()], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: 'adv.null_accumulator', severity: 'info' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },

  // THE SILENCE HALF (496w), one field apart from the case above: the check reads
  // LERR and EERR last and stays quiet when either carries a non-empty string,
  // because a null beside a populated code is an EXPLAINED null — the device said
  // why the accumulator is missing (src/ingest/stages/semantic/null-accumulator.ts).
  // SVA 0 and CMPR null are still in place, so the payload is the correlated form
  // the check exists for and the code is the only thing keeping it quiet.
  //
  // The DS01.3 shadow run agrees here, which it does not on the fire case: the
  // Annex 4 draft requires exactly this non-null LERR beside a null CMPR, so the
  // same payload that silences the advisory also satisfies the draft (measured).
  // The case names no ds013 finding: what it is about is the advisory's silence.
  {
    id: '3.2-pass-ems-null-runtime-explained',
    title: 'A null compressor runtime explained by a logger error code draws no advisory',
    requirements: [],
    direction: 'pass',
    baseline: emsBaseline,
    posts: [{ transforms: [explainedNullRuntimeDuringOutage()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
    absentFindings: [{ requirement: 'adv.null_accumulator' }],
  },

  // A column of nulls rather than an intermittent one (pwd) — the other side of
  // the case above, and the last of the twelve advisories registered at the
  // time to get a fire case (eyok). It declares `baseline: emsBaseline` because HOLD and SVA
  // are ems-record properties, and it synthesizes a TWELVE-record series because
  // that is the check's floor: a property counts as padded only once at least
  // MIN_RECORDS (12, src/ingest/stages/semantic/null-padding.ts) records carried
  // it and it was null in every one. The EMS baseline is three records, so no
  // clone of it can fire this advisory without a transform that grows the series.
  //
  // WHY HAMB AND HOLD. The baseline's own nulls — ALRM, EERR and LERR — are the
  // three condition codes the check EXCLUDES, because for those three the schema
  // defines null as the value meaning "no condition present"; a healthy device
  // correctly sends a column of them. HAMB and HOLD are the pair that is nullable
  // under BOTH registered lineages, so the payload stays valid on the contract
  // and gives the shadow run nothing extra to say. TAMB and BLOG would have been
  // a 422 under the contract, and BEMD/CMPR/DORV would have drawn a clause 5.3.2
  // shadow fail for a null with no explanation beside it — legal, but it would
  // muddy a case about padding.
  //
  // THE OTHER ADVISORIES STAY SILENT, and that is asserted by omission rather
  // than by expectation (silence is 496w's job): CMPR stays at the baseline's 320
  // against SVA 900, so neither compressor advisory speaks; the records step 15
  // minutes apart, so the cadence and sample-gap checks are content; and each
  // clone carries a distinct ABST, so the duplicate-record check sees no repeat.
  // The §3.2 pass is asserted because it is the point of the pattern: this
  // payload breaks nothing, and the advisory is the only thing the session shows
  // for it.
  {
    id: 'adv.null_padding-fail-null-column-across-twelve-records',
    title: 'Two optional readings sent as null in every one of twelve records',
    requirements: [],
    direction: 'fail',
    baseline: emsBaseline,
    fault: {
      layer: 'payload',
      note:
        'the report is re-stamped as 12 records 15 minutes apart with HAMB and HOLD null in ' +
        'every one — legal because the shared $defs type both ["number","null"], and past the ' +
        'advisory’s 12-record floor',
    },
    posts: [{ transforms: [nullPaddedSeries()], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: 'adv.null_padding', severity: 'info' },
      { requirement: '3.2', severity: 'pass' },
    ],
  },

  // THE SILENCE HALF of the padding check, and the floor itself (496w). A
  // property counts as padded only once at least MIN_RECORDS — 12,
  // src/ingest/stages/semantic/null-padding.ts — records carried it and it was
  // null in every one, so eleven records of the same null column say nothing.
  // One record under the floor is the sharpest place to measure it: a case built
  // on a much shorter series would leave the boundary itself unexercised.
  //
  // Everything else is the fire case's payload, including the HAMB/HOLD pair,
  // which both lineages type ["number","null"] — so the shadow run has nothing to
  // add and the case names no ds013 finding.
  {
    id: '3.2-pass-ems-eleven-record-null-column',
    title: 'A null column across eleven records — one short of the padding floor, and silent',
    requirements: [],
    direction: 'pass',
    baseline: emsBaseline,
    posts: [{ transforms: [nullPaddedSeries(11)], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
    absentFindings: [{ requirement: 'adv.null_padding' }],
  },
];
