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
 *
 * They also hold the three DECLARATIVE CAPABILITIES honest — `setup:
 * 'auth-enabled'`, `delivery: 'concurrent'` and `baseline` — by checking that a
 * case expecting what only that capability can produce actually declares it, and
 * that declaring it actually produces it. Those are the checks that keep a marker
 * from being dropped without the case visibly changing meaning: a case that lost
 * its `baseline` would still look like an EMS exercise while sending rtm.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPLIANCE_MATRIX } from '../api/compliance-matrix.js';
import { isAdvisoryId } from '../ingest/stages/semantic/advisory.js';
import { SchemaRegistry } from '../schema-registry.js';
import { DEFAULT_BASELINE, emsBaseline } from './baseline.js';
import {
  isAcceptedStatus,
  materializeCase,
  requiresAuthEnabled,
  resolveBaseline,
  type ExerciseCase,
} from './case.js';
import { EXERCISE_CASES, PAYLOAD_CASES, SEQUENCE_CASES, TRANSPORT_CASES } from './cases.js';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

/**
 * Materialize a case the way THESE tests need it: with a stand-in for the
 * show-once §1.3 credential the live runner supplies (8qa.3).
 *
 * `bearerCredential()` refuses to materialize without one — deliberately, so a
 * live §1.3 pass can never go out silently uncredentialed and collapse to a 401
 * (src/exercise/transforms/transport.ts). Nothing below inspects the token: these
 * invariants read the payload and the wire request, never the Authorization
 * header's value, so any non-empty string serves.
 */
function materialize(kase: ExerciseCase) {
  return materializeCase(kase, { transport: { credential: 'exercise-placeholder-credential' } });
}

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
    for (const post of materialize(kase)) {
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
    const ids = materialize(kase).map(transferIdOf);
    assert.ok(
      new Set(ids).size < ids.length,
      `${kase.id}: expects a §1.8 fail but its POSTs carry distinct transferIds (${ids.join(', ')})`,
    );
  }
});

test('a case expecting a §2.1 fail declares concurrent delivery of more than one POST', () => {
  // Added with the concurrency capability (8qa.5), and the mirror of the
  // deliberate-replay tripwire above: §2.1's fail branch is reachable ONLY from a
  // genuinely overlapping request — the grader reads the in-flight count captured
  // at handler entry (src/ingest/concurrency-tracker.ts), which a sequential
  // player can never push above 1. A case that lost its `delivery: 'concurrent'`
  // marker, or was trimmed to a single POST, would still LOOK like a §2.1 exercise
  // while quietly asserting something the runner cannot produce.
  const concurrentFails = EXERCISE_CASES.filter((kase) =>
    kase.expectedFindings.some((f) => f.requirement === '2.1' && f.severity === 'fail'),
  );
  assert.ok(concurrentFails.length > 0, 'the table still exercises the §2.1 fail direction');
  for (const kase of concurrentFails) {
    assert.equal(
      kase.delivery,
      'concurrent',
      `${kase.id}: expects a §2.1 fail but its POSTs go out sequentially`,
    );
    assert.ok(kase.posts.length >= 2, `${kase.id}: nothing overlaps a single POST`);
  }
});

test('a concurrent case has POSTs to overlap', () => {
  // The other half: `delivery: 'concurrent'` on a one-POST case is a marker that
  // does nothing, which reads as an exercise of §2.1 and is not one.
  for (const kase of EXERCISE_CASES.filter((c) => c.delivery === 'concurrent')) {
    assert.ok(
      kase.posts.length >= 2,
      `${kase.id}: declares concurrent delivery but sends one POST`,
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

// ── the declared BASELINE, and the silent cap it exists to prevent (1m8) ────

function transferTypeOf(post: { payload: { meta: Record<string, unknown> } }): unknown {
  return post.payload.meta.transferType;
}

test('a case declaring the EMS baseline really materializes an EMS-typed payload', () => {
  // THE ANTI-SILENT-CAP CHECK. Before `ExerciseCase.baseline` existed, both
  // consumers materialized with no baseline at all — ./runner/run.ts passes only
  // the transport context and `materialize()` above only the credential — so a
  // case meaning to exercise the schema's ems branch would have been played, and
  // checked right here, against the rtm baseline: still green, still titled EMS,
  // exercising `rtmd-record`. That is the failure this suite is least willing to
  // ship, since the coverage report would go on printing EMS coverage nobody has.
  //
  // Keyed on the DECLARATION rather than on ids or titles, so it holds for any
  // case that reaches for the generator however it is named or filed. The other
  // direction — an EMS case that FORGETS the declaration — is caught structurally
  // instead: the EMS-only mutators throw when handed a payload without the
  // mains/report-level shape they mutate (../transforms/payload.ts), so such a
  // case cannot materialize at all.
  const emsCases = EXERCISE_CASES.filter((kase) => kase.baseline === emsBaseline);
  assert.ok(
    emsCases.length > 0,
    'the table no longer exercises the schema ems branch — the EMS group must be reworked, ' +
      'not deleted (bd 1m8)',
  );
  for (const kase of emsCases) {
    for (const post of materialize(kase)) {
      assert.equal(
        transferTypeOf(post),
        'ems',
        `${kase.id}[${post.label}]: declares the EMS baseline but materialized a ` +
          `${String(transferTypeOf(post))} payload — it is not exercising the ems branch`,
      );
    }
  }
});

test('a case that declares no baseline gets the default one', () => {
  // The other half of the precedence rule (../case.ts): declaring nothing must
  // stay exactly what every pre-1m8 case did, so adding the field churned no
  // existing case.
  for (const kase of EXERCISE_CASES.filter((k) => k.baseline === undefined)) {
    assert.equal(resolveBaseline(kase), DEFAULT_BASELINE, `${kase.id}: unexpected baseline`);
  }
});

test('the table exercises both branches of the root transferType conditional', () => {
  // The root `if/then/else` on `meta.transferType` picks rtmd-report/rtmd-record
  // or ems-report/ems-record, and the two are materially different — the ems side
  // requires a far larger admin set and carries three `oneOf`s the rtmd side has
  // none of. A table that sends only one type validates only half the schema.
  const types = new Set(EXERCISE_CASES.flatMap((kase) => materialize(kase).map(transferTypeOf)));
  assert.ok(types.has('rtm'), 'the table still sends rtm payloads');
  assert.ok(types.has('ems'), 'the table still sends ems payloads');
});

test('every requirement a case names exists in COMPLIANCE_MATRIX', () => {
  // TWO DIFFERENT RULES, deliberately (agj.1):
  //
  //   `requirements` is MATRIX-ONLY. It is what the coverage join reads
  //   (./runner/coverage.ts), and that join is onto COMPLIANCE_MATRIX — an id the
  //   matrix does not carry is a claim nobody joins to, which is indistinguishable
  //   from no claim at all. So an `adv.*` id is not admissible here, and a case
  //   exercising an advisory declares no requirements at all.
  //
  //   `expectedFindings` ALSO admits `adv.*` ids. Advisories are findings a
  //   session really shows — the runner matches expectations on (requirement,
  //   severity) presence over the pooled findings, and an advisory carries its
  //   `adv.*` id in `requirement` exactly like a §7 finding carries '3.2'. They
  //   are simply not matrix rows, by construction: `computeComplianceSummary` maps
  //   over the static §7 rows and ignores every other id, which is HOW an advisory
  //   is guaranteed never to move a verdict (src/ingest/stages/semantic/
  //   advisory.ts). Admitting them here is what lets a case assert that the
  //   observation was made.
  for (const kase of EXERCISE_CASES) {
    for (const requirement of kase.requirements) {
      assert.ok(MATRIX_IDS.has(requirement), `${kase.id}: unknown requirement ${requirement}`);
    }
    for (const finding of kase.expectedFindings) {
      assert.ok(
        MATRIX_IDS.has(finding.requirement) || isAdvisoryId(finding.requirement),
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
    // POSITIVE EVIDENCE, not necessarily a `pass` finding (relaxed 2026-08-04,
    // bd 8qa.4). This used to demand severity `pass`, which was right while every
    // conformant transmission earned one. It is not right for the outdated-but-
    // valid grade: a body validating against a registered-but-older schema is
    // ACCEPTED, but §3.2 records `info` + `outdated` and deliberately NO pass
    // (2kx — the modifier, not the severity, is what makes the matrix row read
    // `pass-outdated` instead of `untested`). Demanding a pass finding there
    // would force the case to assert something the validator does not do.
    //
    // What survives is the property that mattered: a pass-direction case must
    // name at least one finding the session is required to SHOW, so it proves the
    // requirement was graded rather than merely not-failed. The stricter check
    // that an outdated case really is outdated lives below, where it can consult
    // the registry.
    assert.ok(
      kase.expectedFindings.length > 0,
      `${kase.id}: a pass-direction case must expect at least one finding as positive evidence`,
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
    // THE ADVISORY EXEMPTION (agj.1). An advisory case plants a payload the
    // validator is meant to NOTICE while breaking no rule at all: the schema
    // accepts the value and no §7 requirement covers it, which is the entire
    // reason the Advisories category exists. Such a case can therefore never
    // expect a fail finding (an advisory is built `severity: 'info'` and provably
    // cannot be anything else) nor a rejection (it is a 200). Its positive
    // evidence is the advisory itself — the same standard, met by the only
    // finding this defect can produce. An ordinary fail case is unaffected: an
    // `adv.*` expectation is the ONLY thing this admits.
    const expectsAdvisory = kase.expectedFindings.some((f) => isAdvisoryId(f.requirement));
    assert.ok(
      expectsFail || rejects || expectsAdvisory,
      `${kase.id}: a fail-direction case must expect a fail finding, an advisory, or a ` +
        `non-2xx status`,
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
  for (const post of materialize(kase)) {
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

/* ── schema CURRENCY: which side of currentVersion() a case sits on ──────────
 *
 * `schemaOutcome` says whether Ajv accepts the payload; it deliberately says
 * nothing about whether the version is the newest one (see the note on
 * SchemaOutcome in ./transforms/payload.ts). But the §3.2 grade forks on exactly
 * that: src/ingest/stages/schema.ts records a `pass` when the resolved version IS
 * `registry.currentVersion()` and `info` + `outdated` when it is older, and those
 * are the two branches the cases below claim. Currency is decidable in CI — it is
 * a registry fact — so it is checked here.
 *
 * This is also the replacement tripwire for bd aur. The old one hung off
 * `setUnsupportedSchemaVersion('0.8.0')` and asserted only that 0.8.0 was NOT
 * registered, so it trapped exactly one of the ways the registry could move:
 * registering 0.8.2 would have made 0.8.1 outdated, silently broken
 * '3.2-pass-baseline' live, and never tripped anything in CI. These two
 * assertions trip by name on ANY change to the registered set that moves a case
 * to the wrong side of current — in either direction.
 */

/**
 * A case claiming the outdated-but-valid grade. Keyed on the §3.2 `info` it
 * expects: schema.ts is the only producer of §3.2 findings and the outdated
 * branch is its only `info` one, so §3.2 info means outdated and nothing else.
 */
function expectsOutdatedGrade(kase: ExerciseCase): boolean {
  return kase.expectedFindings.some((f) => f.requirement === '3.2' && f.severity === 'info');
}

/** A case claiming the ordinary current-version §3.2 pass. */
function expectsCurrentSchemaPass(kase: ExerciseCase): boolean {
  return kase.expectedFindings.some((f) => f.requirement === '3.2' && f.severity === 'pass');
}

test('a case expecting the §3.2 outdated grade declares a registered version older than current', () => {
  const outdatedCases = EXERCISE_CASES.filter(expectsOutdatedGrade);
  assert.ok(
    outdatedCases.length > 0,
    'the table still exercises the outdated-but-valid grade — if the registry lost its older ' +
      'version, the pass-outdated case must be reworked, not deleted (bd 8qa.4)',
  );
  const current = registry.currentVersion();
  for (const kase of outdatedCases) {
    for (const post of materialize(kase)) {
      const version = declaredVersion(post.payload);
      const where = `${kase.id}[${post.label}]`;
      assert.ok(
        registry.lookup(version).ok,
        `${where}: expects the outdated grade but ${version} is not registered — that is a 422, ` +
          `not an accepted-with-info transmission`,
      );
      assert.notEqual(
        version,
        current,
        `${where}: expects the outdated grade but ${version} IS the current version — ` +
          `the stage would record a §3.2 pass instead`,
      );
    }
  }
});

test('a case expecting a §3.2 pass declares the CURRENT registered version', () => {
  const passCases = EXERCISE_CASES.filter(expectsCurrentSchemaPass);
  assert.ok(passCases.length > 0, 'the table still exercises the current-version §3.2 pass');
  const current = registry.currentVersion();
  for (const kase of passCases) {
    for (const post of materialize(kase)) {
      // Only POSTs that reach stage 7 can earn the pass; a body a transport
      // wrapper replaced outright (oversize, unparseable) halts long before, and
      // its payload's declared version is not what the session grades on.
      if (post.schemaOutcome !== 'valid') continue;
      assert.equal(
        declaredVersion(post.payload),
        current,
        `${kase.id}[${post.label}]: expects a §3.2 pass, but the current registered version is ` +
          `${current} — an older one is graded info+outdated, with no pass finding at all`,
      );
    }
  }
});

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
    EXERCISE_CASES.flatMap((c) => materialize(c).map((p) => p.schemaOutcome)),
  );
  assert.deepEqual(
    [...outcomes].sort(),
    ['invalid', 'unsupported-version', 'valid'],
    'all three schema outcomes are exercised',
  );
});
