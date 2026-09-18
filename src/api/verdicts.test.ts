/**
 * Verdict + readiness engine (by1c.8, with the §1.8 case from by1c.10).
 *
 * The properties pinned here are the ones the whole shadow design rests on and
 * none of which the compiler can hold: that a shadow failure never reaches the
 * contract verdict, that "nothing to say" is a third answer rather than a quiet
 * pass — and that it is narrower than "the shadow did not run", since a contract
 * failure the clause map carries forward is reported even when the shadow
 * validator never ran (tfnv.3) — that a transport breach graded once counts
 * under both lineages while a §3.2 schema failure does not, and that the rule is
 * symmetric: the day `CONTRACT_PROFILE` flips, the roles swap with no change
 * here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Severity, SignatureFinding, SignatureTransmission } from './signatures.js';
import { readiness, verdict } from './verdicts.js';
import type { Profile } from '../schema-registry.js';

const CONTRACT: Profile = '2025';
const SHADOW: Profile = 'ds013';

/** One finding, defaulted so each case states only what it varies. */
function f(over: {
  requirement: string;
  severity: Severity;
  profile: Profile;
  code?: string | null;
  keyword?: string | null;
  instancePath?: string | null;
  param?: string | null;
}): SignatureFinding {
  return {
    detail: null,
    pointer: null,
    outdated: false,
    keyword: null,
    instancePath: null,
    param: null,
    code: null,
    ...over,
  };
}

/** A clean contract run: the §3.2 pass finding the schema stage writes. */
const contractPass = f({ requirement: '3.2', severity: 'pass', profile: CONTRACT });
/** A clean shadow run: the ONE pass finding that proves the shadow ran. */
const shadowPass = f({ requirement: '5.3.2', severity: 'pass', profile: SHADOW });

let seq = 0;

/** A transmission, in the shape both the verdict engine and the fold read. */
function tx(findings: SignatureFinding[], over: Partial<SignatureTransmission> = {}) {
  seq += 1;
  return {
    id: `tx-${seq}`,
    received_at: new Date(Date.UTC(2026, 8, 14, 12, 0, seq)).toISOString(),
    source: 'acme',
    findings,
    ...over,
  };
}

// ── the contract verdict: today's txFailing, unchanged ──────────────────────

test('contract verdict is pass with no findings at all', () => {
  assert.equal(verdict(tx([]), CONTRACT, CONTRACT), 'pass');
});

test('contract verdict fails on a contract-lineage fail', () => {
  const t = tx([f({ requirement: '1.4', severity: 'fail', profile: CONTRACT })]);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'fail');
});

test('a shadow failure never reaches the contract verdict', () => {
  const t = tx([
    contractPass,
    f({ requirement: '5.3.2', severity: 'fail', profile: SHADOW, keyword: 'required' }),
  ]);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'pass');
  assert.equal(verdict(t, SHADOW, CONTRACT), 'fail');
});

// ── null: nothing this lineage can say ──────────────────────────────────────

test('a transport halt fails the shadow lineage through the clause map (tfnv.3)', () => {
  // The body never reached the schema stage, so no shadow finding exists — but
  // §1.4 maps onto clause 5.1.6, and a failed clause is a failed clause however
  // the halt was numbered. "Not graded here" would understate it.
  const t = tx([f({ requirement: '1.4', severity: 'fail', profile: CONTRACT })]);
  assert.equal(verdict(t, SHADOW, CONTRACT), 'fail');
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'fail');
});

test('null is not a soft fail: an unresolved schemaVersion grades neither lineage', () => {
  // §3.2 is the one forward entry that is NOT re-tagged (RE_RUN_UNDER_SHADOW):
  // its counterpart 5.3.2 is re-run by the shadow validator, which here never
  // ran. So nothing was measured and nothing carries forward — genuinely null.
  const t = tx([
    f({
      requirement: '3.2',
      severity: 'fail',
      profile: CONTRACT,
      code: 'tx.unsupported_schema_version',
    }),
  ]);
  assert.equal(verdict(t, SHADOW, CONTRACT), null);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'fail');
});

test('null survives a finding that grades nothing: an advisory carries nowhere', () => {
  // An advisory is an observation about a conformant payload, not a defect, so
  // it is not a contract failure to carry forward. With no shadow finding either
  // there is nothing to report under the draft.
  const t = tx([
    f({
      requirement: 'adv.null_padding',
      severity: 'info',
      profile: CONTRACT,
      code: 'adv.null_padding',
    }),
  ]);
  assert.equal(verdict(t, SHADOW, CONTRACT), null);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'pass');
});

test('a clean shadow run passes on its single pass finding', () => {
  assert.equal(verdict(tx([contractPass, shadowPass]), SHADOW, CONTRACT), 'pass');
});

// ── mixed-lineage streams ───────────────────────────────────────────────────

test('2025-primary with a failing shadow: contract pass, DS01.3 fail', () => {
  // The canonical readiness demo — the 0.8.1 RTM fixture, which is conformant
  // today and misses five Annex 4 logger-identity properties.
  const t = tx([
    contractPass,
    ...['LDOP', 'LMFR', 'LMOD', 'LPQS', 'LSER'].map((p) =>
      f({
        requirement: '5.3.2',
        severity: 'fail',
        profile: SHADOW,
        keyword: 'required',
        instancePath: '/data/0',
        param: p,
      }),
    ),
  ]);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'pass');
  assert.equal(verdict(t, SHADOW, CONTRACT), 'fail');
});

test('ds013-primary rejected 422 with a clean 2025 shadow: contract pass, DS01.3 fail', () => {
  // Verdict is by profile, NOT by HTTP status (epic by1c item 8): the Annex 4
  // run drove the 422, and the contract lineage found nothing wrong.
  const t = tx([
    f({ requirement: '5.3.3', severity: 'fail', profile: SHADOW, keyword: 'pattern' }),
    contractPass,
  ]);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'pass');
  assert.equal(verdict(t, SHADOW, CONTRACT), 'fail');
});

test('the rule is symmetric: flipping the contract profile swaps the roles', () => {
  const t = tx([
    contractPass,
    f({ requirement: '5.3.2', severity: 'fail', profile: SHADOW, keyword: 'required' }),
  ]);
  // With DS01.3 as the contract, the same transmission fails the contract and
  // passes the (now 2025) shadow. No logic here changes — only the constant.
  assert.equal(verdict(t, SHADOW, SHADOW), 'fail');
  assert.equal(verdict(t, CONTRACT, SHADOW), 'pass');
});

// ── the re-tag rule ─────────────────────────────────────────────────────────

test('a contract fail on a forward-mapped requirement fails the shadow too', () => {
  // §1.6 → 5.1.8: a transport breach is graded ONCE and re-tagged, not re-run.
  const t = tx([
    f({ requirement: '1.6', severity: 'fail', profile: CONTRACT, code: 'tx.double_encoded' }),
    shadowPass,
  ]);
  assert.equal(verdict(t, SHADOW, CONTRACT), 'fail');
});

test('a §3.2 fail alone does NOT fail the shadow — Annex 4 is re-run, not re-tagged', () => {
  // A body that fails cce-interop 0.8.1 can still satisfy Annex 4; the shadow
  // run measured that directly, and re-tagging would contradict the measurement.
  const t = tx([
    f({
      requirement: '3.2',
      severity: 'fail',
      profile: CONTRACT,
      keyword: 'enum',
      instancePath: '/data/0/TVC',
    }),
    shadowPass,
  ]);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'fail');
  assert.equal(verdict(t, SHADOW, CONTRACT), 'pass');
});

test('an advisory never fails either verdict', () => {
  // Advisories are `info` today; the guard holds even if one ever carried a
  // fail severity, because an advisory grades against no lineage at all.
  const t = tx([
    contractPass,
    shadowPass,
    f({
      requirement: 'adv.null_padding',
      severity: 'fail',
      profile: CONTRACT,
      code: 'adv.null_padding',
    }),
  ]);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'pass');
  assert.equal(verdict(t, SHADOW, CONTRACT), 'pass');
});

// ── §1.8 duplicates (by1c.10) ───────────────────────────────────────────────

test('a duplicate transferId fails BOTH profiles (by1c.10)', () => {
  // DECIDED (by1c.2, D2): §1.8 stays a contract fail and DS01.3 5.1.10 — which
  // turns the "should not" into a "shall not" — is a pure re-tag. So a duplicate
  // is never a readiness reason: it is already a defect under the contract.
  const t = tx([
    contractPass,
    shadowPass,
    f({ requirement: '1.8', severity: 'fail', profile: CONTRACT, code: 'tx.duplicate_transfer' }),
  ]);
  assert.equal(verdict(t, CONTRACT, CONTRACT), 'fail');
  assert.equal(verdict(t, SHADOW, CONTRACT), 'fail');
});

// ── readiness ───────────────────────────────────────────────────────────────

const readinessOptions = {
  contractProfile: CONTRACT,
  shadowProfile: SHADOW,
};

/** A shadow `required` failure naming one missing property. */
function missingUnderAnnex4(param: string): SignatureFinding {
  return f({
    requirement: '5.3.2',
    severity: 'fail',
    profile: SHADOW,
    keyword: 'required',
    instancePath: '/data/0',
    param,
  });
}

test('readiness counts contract-passing and dual-passing transmissions', () => {
  const r = readiness(
    [
      tx([contractPass, shadowPass]), // passes both
      tx([contractPass, shadowPass]), // passes both
      tx([contractPass, missingUnderAnnex4('LSER')]), // contract only
      tx([f({ requirement: '1.4', severity: 'fail', profile: CONTRACT }), shadowPass]), // neither
    ],
    readinessOptions,
  );
  assert.equal(r.passingContract, 3);
  assert.equal(r.passingBoth, 2);
});

test('a transmission whose shadow never ran counts in neither number', () => {
  const r = readiness([tx([contractPass]), tx([contractPass, shadowPass])], readinessOptions);
  assert.equal(r.passingContract, 2, 'it still passes the contract');
  assert.equal(r.passingBoth, 1, 'but nothing was measured under DS01.3');
});

test('contract-FAILING traffic is outside both numbers, however it fares under DS01.3', () => {
  // The supplier has something to fix under the contract first, and readiness is
  // a statement about traffic that conforms today.
  const r = readiness(
    [
      tx([contractPass, missingUnderAnnex4('LSER')]),
      tx([contractPass, missingUnderAnnex4('LSER')]),
      tx([
        f({ requirement: '1.4', severity: 'fail', profile: CONTRACT }),
        missingUnderAnnex4('LMOD'),
      ]),
    ],
    readinessOptions,
  );
  assert.equal(r.passingContract, 2);
  assert.equal(r.passingBoth, 0);
});

test('a contract failure keeps a transmission out of readiness, even re-tagged forward', () => {
  // The by1c.10 case at the readiness level: the duplicate fails the contract,
  // so its transmission is outside both numbers entirely.
  const r = readiness(
    [
      tx([
        contractPass,
        shadowPass,
        f({
          requirement: '1.8',
          severity: 'fail',
          profile: CONTRACT,
          code: 'tx.duplicate_transfer',
        }),
      ]),
    ],
    readinessOptions,
  );
  assert.equal(r.passingContract, 0);
  assert.equal(r.passingBoth, 0);
});

test('the forward-mapped rule leaves readiness where it was (tfnv.3)', () => {
  // The reorder flips a transport halt's shadow verdict from null to 'fail', and
  // neither readiness number can move with it: both fold over contract-PASSING
  // transmissions only, and a failure carried forward is by definition a
  // contract failure. The halted transmission is outside both either way.
  const halted = tx([f({ requirement: '1.4', severity: 'fail', profile: CONTRACT })]);
  assert.equal(verdict(halted, SHADOW, CONTRACT), 'fail');
  const r = readiness([halted, tx([contractPass, shadowPass])], readinessOptions);
  assert.equal(r.passingContract, 1);
  assert.equal(r.passingBoth, 1);
});

test('readiness over an empty scope is two zeroes, and nothing else on the wire', () => {
  const r = readiness([], readinessOptions);
  // deepEqual on the WHOLE object: `reasons` left the wire with tfnv.4, and a
  // stray third field would be a claim the DS01.3 lens already makes row by row.
  assert.deepEqual(r, { passingContract: 0, passingBoth: 0 });
});
