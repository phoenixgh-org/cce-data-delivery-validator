/**
 * The CI stand-in for a readiness case's SHADOW expectation (meyf).
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
 * WHAT THIS DOES NOT CHECK. The shadow FINDING — its requirement id, its detail,
 * the fact that it moves no status — is the grader's business and belongs to the
 * live runner. This checks the schema verdict the grader reads, and stops there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_PROFILE, SchemaRegistry } from '../../schema-registry.js';
import { materializeCase, type ExerciseCase } from '../case.js';
import { SHADOW_CASES } from './shadow.js';

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
 * Materialize a case the way ../cases.test.ts does, with the same stand-in for
 * the show-once §1.3 credential the live runner supplies (8qa.3). Nothing here
 * reads the Authorization header's value; the payload is the whole subject.
 */
function materialize(kase: ExerciseCase) {
  return materializeCase(kase, { transport: { credential: 'exercise-placeholder-credential' } });
}

/** The shadow-profile expectations a case declares, as (clause, severity) pairs. */
function shadowExpectations(kase: ExerciseCase) {
  return kase.expectedFindings.filter(
    (finding) => finding.profile !== undefined && finding.profile !== CONTRACT_PROFILE,
  );
}

test('the shadow lineage is registered under the key these cases are graded against', () => {
  assert.ok(
    draft !== undefined,
    "registry key '1' (the DS01.3 Annex 4 draft) is gone — the readiness cases grade against " +
      'it, so a re-keyed or unregistered shadow entry must be reconciled here, not silently ' +
      'skipped',
  );
});

for (const kase of SHADOW_CASES) {
  test(`case ${kase.id}: the draft verdict matches its ds013 expectation`, () => {
    assert.ok(draft !== undefined, "registry key '1' is not registered");
    const expectations = shadowExpectations(kase);
    assert.ok(
      expectations.length > 0,
      `${kase.id}: a case in the shadow module asserts nothing about the shadow run`,
    );

    for (const expectation of expectations) {
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
