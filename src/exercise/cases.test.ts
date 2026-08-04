/**
 * Direction checks for the exercise case table (8qa.1; epic 8qa "CI story").
 *
 * The live suite never runs in CI — it needs a deployed instance. But the case
 * table and the transforms are pure, so THESE tests run in `npm test` and hold
 * the table honest: every case's declared direction is checked as far as it is
 * checkable without a server, using the real schema registry and the real Ajv
 * validator over the vendored bytes.
 *
 * WHAT IS CHECKED WHERE. A case's defect can sit at one of three layers, and
 * only the first is decidable here:
 *
 *   - SCHEMA — each materialized payload's declared {@link SchemaOutcome} is run
 *     against the registry + Ajv: `invalid` mutants must actually fail
 *     validation, `unsupported-version` must actually miss the registry, and
 *     everything else must still validate. This is the direction check the epic
 *     asks for, and it is what stops a fail-direction case silently decaying
 *     into a payload the validator would happily accept.
 *   - SEMANTIC / TRANSPORT — a §3.1, §3.4, §1.8, or transport-level defect leaves
 *     the payload schema-valid by construction, so there is nothing for Ajv to
 *     say. For those the tests assert what IS checkable at this layer: internal
 *     consistency of the declaration (direction ↔ fault ↔ expected statuses ↔
 *     expected findings) and that the transforms produce the wire request they
 *     claim (see ./case.test.ts). The live grade belongs to the runner (8qa.2).
 *
 * The table-wide invariants also cover SESSION HYGIENE: the runner plays every
 * case against a single session, so the cases must not collide with each other
 * there (today: the transferId a POST carries, which §1.8 grades session-wide).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPLIANCE_MATRIX } from '../api/compliance-matrix.js';
import { SchemaRegistry } from '../schema-registry.js';
import {
  isAcceptedStatus,
  materializeCase,
  requiresAuthEnabled,
  type ExerciseCase,
} from './case.js';
import { EXERCISE_CASES, PAYLOAD_CASES, SEQUENCE_CASES, TRANSPORT_CASES } from './cases.js';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const MATRIX_IDS = new Set(COMPLIANCE_MATRIX.map((row) => row.requirement));

/** The §6 status codes an ingest POST can come back with (DESIGN.md §6). */
const KNOWN_STATUSES = new Set([200, 400, 401, 404, 405, 413, 422]);

function declaredVersion(payload: { meta: Record<string, unknown> }): string {
  const raw = payload.meta.schemaVersion;
  assert.equal(typeof raw, 'string', 'every materialized payload declares a schemaVersion');
  return raw as string;
}

// ── table-wide invariants ───────────────────────────────────────────────────

test('the index carries every per-domain case module', () => {
  // The table is assembled from ./cases/*.ts (ke6). A module the index forgot to
  // concatenate would silently stop being played AND stop being checked here —
  // every invariant below reads the aggregate.
  const modules = { PAYLOAD_CASES, SEQUENCE_CASES, TRANSPORT_CASES };
  let total = 0;
  for (const [name, table] of Object.entries(modules)) {
    assert.ok(table.length > 0, `${name} is empty — a domain module lost its cases`);
    total += table.length;
    for (const kase of table) {
      assert.ok(
        EXERCISE_CASES.includes(kase),
        `${name}: ${kase.id} is missing from EXERCISE_CASES`,
      );
    }
  }
  assert.equal(EXERCISE_CASES.length, total, 'EXERCISE_CASES is exactly the domain modules');
});

test('case ids are unique', () => {
  const ids = EXERCISE_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate case id in ${ids.join(', ')}`);
});

/**
 * A case that expects a §1.8 FAIL is exercising the duplicate heuristic itself,
 * so its POSTs repeat a transferId on purpose. Every other case must not.
 */
function isIntentionalDuplicate(kase: ExerciseCase): boolean {
  return kase.expectedFindings.some((f) => f.requirement === '1.8' && f.severity === 'fail');
}

function transferIdOf(post: { payload: { meta: Record<string, unknown> } }): string {
  const raw = post.payload.meta.transferId;
  assert.equal(typeof raw, 'string', 'every materialized payload declares a transferId');
  return raw as string;
}

test('no two POSTs in the table share a transferId unless the case is a deliberate replay', () => {
  // The runner plays the WHOLE table against ONE session and §1.8 is
  // session-scoped, so a transferId shared by unrelated cases would record a
  // §1.8 fail caused purely by table ordering — on pass-direction cases too
  // (5xi). Distinct ids also make the serialized bytes distinct, which clears
  // the content-replay flavour of the same check. (POSTs whose body a transport
  // wrapper replaces outright — oversize, unparseable — are exempt in practice:
  // they halt at §6 long before the semantic stage.)
  //
  // A deliberate-replay case is exempt only WITHIN ITSELF (hn5): its pinned id is
  // still recorded, so a collision between that id and any other case's — two
  // replay cases sharing one id, or an unrelated case pinning the same string —
  // still fails here rather than surfacing live as an unexplained §1.8 fail.
  const seen = new Map<string, string>();
  for (const kase of EXERCISE_CASES) {
    const exempt = isIntentionalDuplicate(kase);
    const withinCase = new Set<string>();
    for (const post of materializeCase(kase)) {
      const where = `${kase.id}[${post.label}]`;
      const transferId = transferIdOf(post);
      // The repeat this case exists to send: already recorded by its own earlier
      // POST, and the record must keep naming that first POST.
      if (exempt && withinCase.has(transferId)) continue;
      const prior = seen.get(transferId);
      assert.equal(
        prior,
        undefined,
        `${where}: transferId "${transferId}" already sent by ${prior}`,
      );
      seen.set(transferId, where);
      withinCase.add(transferId);
    }
  }
});

test('a deliberate-replay case really does repeat its transferId across POSTs', () => {
  // The other half of the invariant: the duplicate cases must keep PINNING
  // their id rather than inheriting whatever the baseline generates, or they
  // stop exercising §1.8 the moment the baseline changes.
  const duplicates = EXERCISE_CASES.filter(isIntentionalDuplicate);
  assert.ok(duplicates.length > 0, 'the table still carries a duplicate case');
  for (const kase of duplicates) {
    const ids = materializeCase(kase).map(transferIdOf);
    assert.ok(
      new Set(ids).size < ids.length,
      `${kase.id}: expects a §1.8 fail but its POSTs carry distinct transferIds (${ids.join(', ')})`,
    );
  }
});

test('a case reaching for a §1.3 credential wrapper declares setup: auth-enabled', () => {
  // §1.3 means nothing until the SESSION opts in: `bearerCredential()` throws
  // without a runner-supplied credential, and `noAuth()`/`badAuth()` only provoke
  // the 401 they expect on an auth-enabled session. The declaration is what makes
  // the runner enable auth and play the case last (./runner/run.ts). Keyed on the
  // wrapper's own `targets`, so a new §1.3 wrapper is covered for free.
  for (const kase of EXERCISE_CASES) {
    const usesCredentialWrapper = kase.posts.some((post) =>
      (post.transforms ?? []).some((t) => t.kind === 'transport' && t.targets.includes('1.3')),
    );
    if (!usesCredentialWrapper) continue;
    assert.ok(
      requiresAuthEnabled(kase),
      `${kase.id}: uses a §1.3 credential wrapper but does not declare setup: 'auth-enabled'`,
    );
  }
});

test('every requirement a case names exists in COMPLIANCE_MATRIX', () => {
  for (const kase of EXERCISE_CASES) {
    for (const requirement of kase.requirements) {
      assert.ok(MATRIX_IDS.has(requirement), `${kase.id}: unknown requirement ${requirement}`);
    }
    for (const finding of kase.expectedFindings) {
      assert.ok(
        MATRIX_IDS.has(finding.requirement),
        `${kase.id}: expected finding names unknown requirement ${finding.requirement}`,
      );
    }
  }
});

test('every targeted requirement is backed by an expected finding or a rejection', () => {
  // A case that claims to exercise a requirement must show its work: either a
  // finding on that requirement, or a non-2xx status (the §6 halts — notably
  // 405 — grade by status alone and persist no finding).
  for (const kase of EXERCISE_CASES) {
    const covered = new Set(kase.expectedFindings.map((f) => f.requirement));
    const rejects = kase.posts.some((p) => !isAcceptedStatus(p.expectedStatus));
    for (const requirement of kase.requirements) {
      assert.ok(
        covered.has(requirement) || rejects,
        `${kase.id}: targets ${requirement} but expects neither a finding on it nor a rejection`,
      );
    }
  }
});

test('every case declares at least one POST with a known §6 status', () => {
  for (const kase of EXERCISE_CASES) {
    assert.ok(kase.posts.length >= 1, `${kase.id}: a case needs at least one POST`);
    for (const post of kase.posts) {
      assert.ok(
        KNOWN_STATUSES.has(post.expectedStatus),
        `${kase.id}: ${post.expectedStatus} is not a §6 ingest status`,
      );
    }
  }
});

// ── direction consistency ───────────────────────────────────────────────────

test('pass-direction cases declare no fault, expect only 2xx and no fail findings', () => {
  for (const kase of EXERCISE_CASES.filter((c) => c.direction === 'pass')) {
    assert.equal(kase.fault, undefined, `${kase.id}: a pass-direction case declares no fault`);
    for (const post of kase.posts) {
      assert.ok(
        isAcceptedStatus(post.expectedStatus),
        `${kase.id}: pass-direction POST expects ${post.expectedStatus}`,
      );
    }
    const fails = kase.expectedFindings.filter((f) => f.severity === 'fail');
    assert.deepEqual(fails, [], `${kase.id}: a pass-direction case expects no fail findings`);
    assert.ok(
      kase.expectedFindings.some((f) => f.severity === 'pass'),
      `${kase.id}: a pass-direction case must expect at least one pass finding`,
    );
  }
});

test('fail-direction cases name their fault and expect a fail finding or a rejection', () => {
  for (const kase of EXERCISE_CASES.filter((c) => c.direction === 'fail')) {
    const fault = kase.fault;
    assert.ok(fault, `${kase.id}: a fail-direction case must name its fault`);
    assert.ok(fault.note.length > 0, `${kase.id}: the fault note must say what is broken`);

    const expectsFail = kase.expectedFindings.some((f) => f.severity === 'fail');
    const rejects = kase.posts.some((p) => !isAcceptedStatus(p.expectedStatus));
    assert.ok(
      expectsFail || rejects,
      `${kase.id}: a fail-direction case must expect a fail finding or a non-2xx status`,
    );

    // A sequence fault is one no single POST carries, so it needs ≥2 POSTs.
    if (fault.layer === 'sequence') {
      assert.ok(kase.posts.length >= 2, `${kase.id}: a sequence fault needs more than one POST`);
    }
  }
});

// ── the schema-layer direction check (real registry, real Ajv) ──────────────

/** Assert one materialized payload behaves exactly as its case declared. */
function assertSchemaOutcome(kase: ExerciseCase): void {
  for (const post of materializeCase(kase)) {
    const where = `${kase.id}[${post.label}]`;
    const version = declaredVersion(post.payload);
    const lookup = registry.lookup(version);

    if (post.schemaOutcome === 'unsupported-version') {
      assert.equal(
        lookup.ok,
        false,
        `${where}: declared unsupported-version but the registry carries ${version}`,
      );
      continue;
    }

    assert.ok(lookup.ok, `${where}: schemaVersion ${version} is not registered`);
    const valid = lookup.entry.validate(post.payload);
    const errors = lookup.entry.validate.errors ?? [];

    if (post.schemaOutcome === 'invalid') {
      assert.equal(
        valid,
        false,
        `${where}: declared schema-invalid but validated clean against ${version} — ` +
          `the mutant no longer breaks anything (applied: ${post.appliedTransforms.join(' + ')})`,
      );
      assert.ok(errors.length > 0, `${where}: an invalid payload must yield Ajv errors`);
      continue;
    }

    assert.equal(
      valid,
      true,
      `${where}: expected a schema-valid payload but Ajv rejected it: ` +
        errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`).join('; '),
    );
  }
}

for (const kase of EXERCISE_CASES) {
  test(`case ${kase.id}: payloads match their declared schema outcome`, () => {
    assertSchemaOutcome(kase);
  });
}

test('the table exercises both directions, both transform families and a multi-POST case', () => {
  // The representative set exists to prove the MODEL, so assert the model's
  // moving parts are actually covered by it (the per-requirement tables land in
  // 8qa.3-.5; coverage against the matrix is the runner's mechanical join).
  assert.ok(
    EXERCISE_CASES.some((c) => c.direction === 'pass'),
    'at least one pass-direction case',
  );
  assert.ok(
    EXERCISE_CASES.some((c) => c.direction === 'fail'),
    'at least one fail-direction case',
  );
  assert.ok(
    EXERCISE_CASES.some((c) => c.posts.length > 1),
    'at least one multi-POST (sequence) case',
  );
  const layers = new Set(EXERCISE_CASES.flatMap((c) => (c.fault ? [c.fault.layer] : [])));
  assert.ok(layers.has('payload'), 'a payload-layer fault');
  assert.ok(layers.has('transport'), 'a transport-layer fault');
  assert.ok(layers.has('sequence'), 'a sequence-layer fault');
  const outcomes = new Set(
    EXERCISE_CASES.flatMap((c) => materializeCase(c).map((p) => p.schemaOutcome)),
  );
  assert.deepEqual(
    [...outcomes].sort(),
    ['invalid', 'unsupported-version', 'valid'],
    'all three schema outcomes are exercised',
  );
});
