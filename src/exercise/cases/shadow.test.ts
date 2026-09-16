/**
 * The CI stand-in for a case's SHADOW expectation (meyf; widened in olpa).
 *
 * ../cases.test.ts already runs every materialized payload through the real
 * registry and the real Ajv build — but only against the CONTRACT validator,
 * because {@link MaterializedPost.schemaOutcome} is a statement about the
 * lineage in force and nothing else. That leaves the half of a readiness case
 * that is actually its point — "the DS01.3 Annex 4 draft would reject this" —
 * checked nowhere without a deployed instance, which is exactly the kind of
 * expectation that rots quietly: the draft may be re-pinned in place when the
 * proposal is revised (CLAUDE.md), and a rule it dropped would leave a case
 * asserting a shadow failure the draft no longer produces.
 *
 * So this module runs the same payloads through the draft validator and asserts
 * the case's own declaration about it: a `5.x.x` expectation at severity `pass`
 * means the payload must validate against registry key '1', and one at `fail`
 * means it must not. That is a mechanical restatement of what src/ingest/stages/
 * schema.ts does on the shadow run, so a case cannot claim a verdict the bytes
 * do not support.
 *
 * WHICH CASES. Every case in EXERCISE_CASES carrying at least one `ds013`
 * expectation, wherever it is declared — not only ./shadow.ts. The readiness
 * module is where a shadow expectation is the whole point of the case, but the
 * advisory tables declare them too (a case that plants a blank admin object is
 * a statement about the draft as well as about the advisory), and those sat
 * outside this loop until olpa. Only DECLARED expectations are checked: nothing is
 * asserted about a case that says nothing about the draft, since a payload may
 * legitimately fail the draft without the case caring.
 *
 * OVER-DETERMINATION, honestly. For a case built on the rtm baseline — the
 * readiness demo — the draft rejects the payload on the five logger-identity
 * properties (LDOP/LMFR/LMOD/LPQS/LSER) whatever the case mutates. For those
 * the loop proves "the draft rejects this payload", not "the draft rejects it
 * for the planted reason", so a revision dropping the rule under test would not
 * flip the expectation here. Of the four advisory cases olpa newly covered, TWO
 * are over-determined that way (`adv.null_identity-fail-blank-rtm-monitoring-id`
 * and `adv.blank_admin-fail-blank-rtm-admin`, both rtm-baseline) and TWO are
 * single-determined, which is what the widening actually protects:
 *
 *   - `adv.blank_admin-fail-second-of-two-ems-reports` — the EMS baseline passes
 *     the draft, so the blank `/data/1/AMFR`'s `minLength` is the draft's ONLY
 *     objection to the payload;
 *   - `adv.null_accumulator-fail-null-runtime-during-outage` — every objection
 *     the draft raises (`/data/0/records/1/CMPR` type, `/data/0/records/1/LERR`
 *     type, and the `records/1` oneOf they break) is a consequence of the planted
 *     nulls, nothing inherited from the baseline.
 *
 * A revision dropping either rule turns that case's expectation false — which
 * nothing in CI would have said before olpa.
 *
 * WHAT THIS DOES NOT CHECK. The shadow FINDING — its requirement id, its detail,
 * the fact that it moves no status — is the grader's business and belongs to the
 * live runner. This checks the schema verdict the grader reads, and stops there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaRegistry, type Profile } from '../../schema-registry.js';
import { materializeCase, type ExerciseCase } from '../case.js';
import { EXERCISE_CASES, SHADOW_CASES } from '../cases.js';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

/**
 * The DS01.3 Annex 4 draft's compiled validator, under its registry key: an
 * integer-valued string, not a semver triple, because the annex versions
 * independently of any semver contract (bd memory
 * schema-registry-0.8.1-current-outdated).
 */
const draft = registry.get('1');

/**
 * The lineage this module grades, named literally rather than as "whatever is
 * not `CONTRACT_PROFILE`": key '1' IS the `ds013` entry, so pinning the
 * profile keeps the expectations selected and the validator they are graded
 * against pointing at the same lineage even if the contract profile moves.
 */
const SHADOW_PROFILE: Profile = 'ds013';

/**
 * Materialize a case the way ../cases.test.ts does, with the same stand-in for
 * the show-once §1.3 credential the live runner supplies (8qa.3). Nothing here
 * reads the Authorization header's value; the payload is the whole subject.
 */
function materialize(kase: ExerciseCase) {
  return materializeCase(kase, { transport: { credential: 'exercise-placeholder-credential' } });
}

/** The shadow-profile expectations a case declares, as (clause, severity) pairs. */
function shadowExpectations(kase: ExerciseCase) {
  return kase.expectedFindings.filter((finding) => finding.profile === SHADOW_PROFILE);
}

/** Every case anywhere in the table that says something about the draft run. */
const SHADOW_GRADED_CASES = EXERCISE_CASES.filter((kase) => shadowExpectations(kase).length > 0);

/**
 * The advisory cases outside ./shadow.ts that carry a ds013 expectation today
 * (olpa). Named so the widening cannot silently regress to the readiness module:
 * dropping a case from the table is a deliberate edit that has to come here, but
 * narrowing the SELECTION back would otherwise go unnoticed.
 */
const PAYLOAD_SHADOW_CASE_IDS = [
  'adv.null_identity-fail-blank-rtm-monitoring-id',
  'adv.blank_admin-fail-blank-rtm-admin',
  'adv.blank_admin-fail-second-of-two-ems-reports',
  'adv.null_accumulator-fail-null-runtime-during-outage',
];

test('the shadow lineage is registered under the key these cases are graded against', () => {
  assert.ok(
    draft !== undefined,
    "registry key '1' (the DS01.3 Annex 4 draft) is gone — the readiness cases grade against " +
      'it, so a re-keyed or unregistered shadow entry must be reconciled here, not silently ' +
      'skipped',
  );
  assert.equal(
    draft.profile,
    SHADOW_PROFILE,
    `registry key '1' now belongs to profile ${draft.profile}, not ${SHADOW_PROFILE} — the ` +
      'expectations selected below and the validator they are graded against have come apart',
  );
});

test('every case in the shadow module asserts something about the shadow run', () => {
  for (const kase of SHADOW_CASES) {
    assert.ok(
      shadowExpectations(kase).length > 0,
      `${kase.id}: a case in the shadow module asserts nothing about the shadow run`,
    );
  }
});

test('the advisory cases carrying a ds013 expectation are graded here too', () => {
  const graded = new Set(SHADOW_GRADED_CASES.map((kase) => kase.id));
  for (const id of PAYLOAD_SHADOW_CASE_IDS) {
    assert.ok(
      graded.has(id),
      `${id} declares a ds013 expectation but is not in the draft-verdict loop — either the ` +
        'case lost that expectation or the selection narrowed back to the readiness module',
    );
  }
});

for (const kase of SHADOW_GRADED_CASES) {
  test(`case ${kase.id}: the draft verdict matches its ds013 expectation`, () => {
    assert.ok(draft !== undefined, "registry key '1' is not registered");

    for (const expectation of shadowExpectations(kase)) {
      // A clause expectation is a statement about the SCHEMA verdict: `pass`
      // when the draft accepts the payload, `fail` when it rejects it. No other
      // severity is a claim this layer can check.
      assert.ok(
        expectation.severity === 'pass' || expectation.severity === 'fail',
        `${kase.id}: a ${expectation.profile} expectation on ${expectation.requirement} carries ` +
          `severity ${expectation.severity}, which is not a schema verdict`,
      );
      const wantValid = expectation.severity === 'pass';

      for (const post of materialize(kase)) {
        const valid = draft.validate(post.payload);
        const errors = draft.validate.errors ?? [];
        const where = `${kase.id}[${post.label}]`;
        assert.equal(
          valid,
          wantValid,
          wantValid
            ? `${where}: expects a ${expectation.requirement} PASS under the draft, but it was ` +
                `rejected: ${errors
                  .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`)
                  .join('; ')}`
            : `${where}: expects a ${expectation.requirement} FAIL under the draft, but the ` +
                `payload validated clean (applied: ${post.appliedTransforms.join(' + ')}) — the ` +
                `mutation no longer reaches a rule the draft carries`,
        );
      }
    }
  });
}
