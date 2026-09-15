/**
 * SHADOW-domain exercise cases — READINESS, the fourth case module (by1c.15).
 *
 * Since bd by1c.6 a transmission whose declared `schemaVersion` resolves to a
 * registered lineage is graded twice: once against the contract in force
 * (`cce-interop`, profile `2025`) and once against the DS01.3 Annex 4
 * delivery-schema proposal (profile `ds013`). The second run changes no status
 * and no verdict — the draft is unpublished — so what it produces is readiness
 * information: what this supplier's traffic would score if the proposal were
 * adopted. These cases exercise that second run end to end.
 *
 * A READINESS CASE IS DIRECTION `pass`. The direction field describes the
 * contract's point of view, which is the only view that grades: a payload the
 * validator accepts with a §3.2 pass is conformant traffic, whatever an
 * unpublished draft would make of it. So a case here carries no `fault` even
 * when its whole point is a shadow failure, and the titles say which lineage
 * each half of the expectation belongs to.
 *
 * WHY A MODULE OF ITS OWN rather than a section of ./payload.ts. The grouping
 * rule is by requirement DOMAIN, and these cases target no §3.x requirement
 * beyond the incidental §3.2 pass every accepted POST earns — what they exercise
 * is the shadow run itself, clause 5.3.2 of a different requirement vocabulary.
 * That is a domain the other three modules do not cover.
 *
 * WHAT IS ASSERTED, AND WHERE. The `expectedFindings` entries carrying
 * `profile: 'ds013'` are the real assertion, matched live on (requirement,
 * severity, profile) like any other. `shadowClauses` is informational: the
 * coverage join reads `requirements` onto COMPLIANCE_MATRIX, which is 2025-only
 * by construction, so a 5.x clause is recorded on the case rather than joined
 * (see ../case.ts and docs/exercise-suite.md).
 *
 * EVERY CASE HERE DECLARES `requirements: []` (by1c.42), the same way the `adv.*`
 * cases in ./payload.ts do and for the same reason. That field is what the
 * coverage join counts as a CLAIM — the requirements a case TARGETS, not the ones
 * its `expectedFindings` happen to mention (../runner/coverage.ts). A readiness
 * case targets no matrix row: what it exercises is the shadow run, and the §3.2
 * pass it also earns is the incidental one every accepted POST earns. Naming
 * §3.2 here would print three extra §3.2 pass exercises that are re-runs of
 * `3.2-pass-baseline`, which is the coverage inflation that rule exists to stop.
 * The §3.2 pass stays in `expectedFindings`, where it is the positive evidence a
 * pass-direction case owes.
 *
 * Naming 'ds013' as a literal here is data, not a label: this module IS the
 * lineage it exercises, and a case that defaulted its profile would be asserting
 * the contract's verdict instead. Everything that DEFAULTS a profile reads
 * `CONTRACT_PROFILE` off the registry (../runner/assertions.ts).
 *
 * ONE CASE THE ISSUE ASKED FOR IS ABSENT, deliberately: a `meta.transferredAt`
 * carrying a `+03:00` offset instead of a trailing `Z`. Measured against the
 * vendored bytes, cce-interop 0.8.1 already pins that field to a pattern ending
 * in `Z`, so an offset is a §3.2 fail and a 422 under the CONTRACT — not a
 * DS01.3 tightening, and not something a readiness case can express. There is no
 * substitute for it; the draft's clause 5.3.3 is reachable only on a payload the
 * contract already rejects.
 */

import { dualPassBaseline } from '../baseline.js';
import type { ExerciseCase } from '../case.js';
import { setNonIsoDate, setTransferId } from '../transforms/payload.js';

export const SHADOW_CASES: readonly ExerciseCase[] = [
  {
    id: 'readiness.rtm_identity',
    title: 'The RTM baseline passes the contract; DS01.3 would fail it on the logger identity',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    // The default baseline is the readiness demo itself: conformant under
    // cce-interop 0.8.1, and missing the five logger-identity properties
    // (LDOP, LMFR, LMOD, LPQS, LSER) the Annex 4 draft makes required on an
    // rtmd-report. No transform — the gap is the fixture.
    posts: [{ transforms: [setTransferId('T-readiness-rtm-identity')], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },
  {
    id: 'readiness.dual_pass',
    title: 'A transmission carrying the logger identity passes the contract and DS01.3 alike',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    baseline: dualPassBaseline,
    posts: [{ transforms: [setTransferId('T-readiness-dual-pass')], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '5.3.2', severity: 'pass', profile: 'ds013' },
    ],
  },
  {
    id: 'readiness.date_pattern',
    title:
      'A production date written 2026-7-4 passes the contract with an advisory; DS01.3 would fail it',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    baseline: dualPassBaseline,
    // The ADVISORY/SHADOW INTERACTION, end to end. cce-interop 0.8.1 declares
    // the DS01 date objects as bare strings with no pattern, so `2026-7-4`
    // validates and the only thing the contract run has to say about it is the
    // `adv.date_format` observation — an `info` finding that moves no status.
    // Annex 4 gives those objects a `YYYY-MM-DD` pattern, so the same value is a
    // schema failure there. One payload, three different things said about it,
    // and the case pins all three: the schema outcome stays `valid` because that
    // is the CONTRACT's verdict, which is what ../cases.test.ts checks.
    posts: [
      {
        transforms: [
          setTransferId('T-readiness-date-pattern'),
          setNonIsoDate('/data/0/ADOP', '2026-7-4'),
        ],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: 'adv.date_format', severity: 'info' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },
];
