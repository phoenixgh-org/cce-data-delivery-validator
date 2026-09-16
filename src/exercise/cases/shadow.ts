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
 * §3.2 here would print one extra §3.2 pass exercise per case, every one of them
 * a re-run of `3.2-pass-baseline`, which is the coverage inflation that rule
 * exists to stop.
 * The §3.2 pass stays in `expectedFindings`, where it is the positive evidence a
 * pass-direction case owes.
 *
 * Naming 'ds013' as a literal here is data, not a label: this module IS the
 * lineage it exercises, and a case that defaulted its profile would be asserting
 * the contract's verdict instead. Everything that DEFAULTS a profile reads
 * `CONTRACT_PROFILE` off the registry (../runner/assertions.ts).
 *
 * ── THE EMS GROUP (meyf) ─────────────────────────────────────────────────────
 * The readiness cases were rtm-only at first, which left the draft's largest
 * change unexercised. Annex 4 rewrites `ems-record`: where cce-interop 0.8.x
 * ties a null reading to an explanation code for TVC alone, the draft adds five
 * more rules — BEMD null requires a non-null EERR, and CMPR, DORV, TAMB and BLOG
 * null each require a non-null LERR. It tightens the report level too, excluding
 * the null case and adding `minLength: 1` to nearly every `ems-report`
 * administrative object, so a blank that the contract can only observe as an
 * advisory becomes a schema failure. The six cases below put one EMS payload on
 * each side of that: an untouched baseline that passes both lineages, three
 * unexplained record nulls, the rtm form of the BEMD rule, and a blank AMFR.
 *
 * TAMB AND BLOG CANNOT BE READINESS CASES, although the draft names them. Neither
 * is nullable on `ems-record` under cce-interop 0.8.1, so a null in either is a
 * §3.2 rejection and a 422 — the contract already refuses the payload, and a
 * readiness case needs one the contract accepts. Only BEMD, CMPR and DORV sit in
 * the gap between the two lineages (measured 2026-09-16 against the vendored
 * bytes; bd memories annex4-ems-record-null-explanations and
 * annex4-tightens-admin-objects).
 *
 * ONE CASE THE ISSUE ASKED FOR IS ABSENT, deliberately: a `meta.transferredAt`
 * carrying a `+03:00` offset instead of a trailing `Z`. Measured against the
 * vendored bytes, cce-interop 0.8.1 already pins that field to a pattern ending
 * in `Z`, so an offset is a §3.2 fail and a 422 under the CONTRACT — not a
 * DS01.3 tightening, and not something a readiness case can express. There is no
 * substitute for it; the draft's clause 5.3.3 is reachable only on a payload the
 * contract already rejects.
 */

import { ADVISORY_IDS } from '../../ingest/stages/semantic/advisory.js';
import { dualPassBaseline, emsBaseline } from '../baseline.js';
import type { ExerciseCase } from '../case.js';
import {
  blankAdminObject,
  nullRecordProperty,
  setNonIsoDate,
  setTransferId,
} from '../transforms/payload.js';

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
  {
    id: 'readiness.ems_dual_pass',
    title: 'The EMS baseline passes the contract and DS01.3 alike',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    baseline: emsBaseline,
    // The EMS half of `readiness.dual_pass`, and the anchor the five cases below
    // are read against: the untouched EMS baseline clears the draft's seven
    // `ems-record` rules and its tightened admin objects with no transform at
    // all, so every shadow failure that follows is attributable to the one
    // mutation its case makes rather than to a fixture that was never going to
    // pass. Its own case (`3.2-pass-ems-baseline`, ./payload.ts) claims the §3.2
    // row; this one claims nothing but the shadow run.
    posts: [{ transforms: [setTransferId('T-readiness-ems-dual-pass')], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '5.3.2', severity: 'pass', profile: 'ds013' },
    ],
    // A payload that passes both lineages is also the payload every advisory is
    // obliged to say nothing about, so the whole registered set is declared
    // silent here exactly as the two baseline pass cases declare it (496w). It
    // matters more on a readiness case than elsewhere: a shadow PASS says only
    // that the draft is satisfied, and without this the case could go green on a
    // payload the contract run was filing observations about.
    absentFindings: ADVISORY_IDS.map((id) => ({ requirement: id })),
  },
  {
    id: 'readiness.ems_bemd_unexplained',
    title:
      'An EMS record reporting no battery-empty days with no error code beside it would fail DS01.3',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    baseline: emsBaseline,
    // BEMD null is the draft's rule (2): it requires a non-null EERR to explain
    // it. The EMS baseline already sends `EERR: null` on every record, so the
    // single mutation is enough and the case stays one fact wide. Under the
    // contract the null needs nothing — 0.8.x ties an explanation to TVC alone —
    // so the transmission is accepted with a §3.2 pass and the shadow run is the
    // only thing with anything to say about it.
    posts: [
      {
        transforms: [setTransferId('T-readiness-ems-bemd'), nullRecordProperty('BEMD')],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },
  {
    id: 'readiness.ems_cmpr_unexplained',
    title: 'An EMS record with a null compressor runtime and mains supply intact would fail DS01.3',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    baseline: emsBaseline,
    // The draft's rule (3): CMPR null requires a non-null LERR. SVA stays at the
    // baseline's 900 and both codes stay null, so the record says the supply was
    // available for the whole period and declines to say what the compressor did.
    //
    // THE ADVISORY THAT DOES NOT FIRE IS HALF THE CASE. `adv.null_accumulator`
    // reads the CORRELATED form — SVA 0 beside a null accumulator — and stays
    // silent when supply was available, which is the bare intermittent null it
    // deliberately defers (src/ingest/stages/semantic/null-accumulator.ts). So
    // this payload is one the contract lineage has NOTHING to say about, by
    // schema or by advisory, while the draft rejects it outright — the widest gap
    // between the two lineages the suite can show, and the absence below is what
    // makes it visible rather than assumed.
    posts: [
      {
        transforms: [setTransferId('T-readiness-ems-cmpr'), nullRecordProperty('CMPR')],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
    // `adv.null_padding` needs twelve records carrying a column of nulls before
    // it calls one padded; the EMS baseline sends three, so a single null CMPR
    // comes nowhere near it.
    absentFindings: [{ requirement: 'adv.null_accumulator' }, { requirement: 'adv.null_padding' }],
  },
  {
    id: 'readiness.ems_dorv_unexplained',
    title: 'An EMS record with a null door-open duration and no error code would fail DS01.3',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    baseline: emsBaseline,
    // The draft's rule (4): DORV null requires a non-null LERR. The third and
    // last of the objects that sit in the gap — BEMD, CMPR, DORV — and the one
    // no advisory reads at all, so the shadow fail is the entire finding the case
    // is about.
    posts: [
      {
        transforms: [setTransferId('T-readiness-ems-dorv'), nullRecordProperty('DORV')],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },
  {
    id: 'readiness.rtm_bemd_unexplained',
    title:
      'An RTMD record reporting no battery-empty days with its error code cleared would fail DS01.3',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    baseline: dualPassBaseline,
    // The one explanation rule the draft gives `rtmd-record`: BEMD null requires
    // a non-null EERR. Built on the dual-pass fixture so the logger-identity
    // tightening `readiness.rtm_identity` is about cannot be what fails here —
    // the payload clears the draft in every respect but this one.
    //
    // BOTH MUTATIONS ARE THE CASE. That fixture sends `EERR: "none"`, a non-null
    // string, and the draft asks only whether a code is present — so nulling BEMD
    // alone leaves the payload passing both lineages (measured). Clearing EERR is
    // what makes the null unexplained.
    posts: [
      {
        transforms: [
          setTransferId('T-readiness-rtm-bemd'),
          nullRecordProperty('BEMD'),
          nullRecordProperty('EERR'),
        ],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },
  {
    id: 'readiness.ems_blank_admin',
    title:
      'An EMS report delivering AMFR as an empty string draws an advisory today and would fail DS01.3',
    requirements: [],
    shadowClauses: ['5.3.2'],
    direction: 'pass',
    baseline: emsBaseline,
    // The ADMIN half of the draft's tightening, and the second advisory/shadow
    // interaction in this module after `readiness.date_pattern`. cce-interop
    // 0.8.x gives the admin objects no `minLength`, so an empty AMFR validates
    // and the contract run can only observe it — `adv.blank_admin` raises an
    // `info` naming the blank, which moves no status. Annex 4 adds `minLength: 1`
    // to AMFR and ten of its neighbours, so the same value is a schema failure
    // there. One payload, three things said about it, all three pinned.
    posts: [
      {
        transforms: [setTransferId('T-readiness-ems-blank-admin'), blankAdminObject('AMFR')],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: '3.2', severity: 'pass' },
      { requirement: 'adv.blank_admin', severity: 'info' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
    ],
  },
];
