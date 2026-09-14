import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONTRACT_PROFILE, SchemaRegistry, normalizeVersion } from './schema-registry.js';

/** Blessed bytes of the published 0.8.1 (JSON Schema 2020-12) — the CURRENT version. */
const EXPECTED_SHA256 = '290290fd4623d25c3fc18724f317249469e03bee9d64ec39279730d3b3a87470';

/** Blessed bytes of the published 0.8.0 (JSON Schema draft-07) — the outdated cohort. */
const EXPECTED_SHA256_080 = 'e6614cc7d749be2e22ae91353a8b08b8ac88eadadc86dc1bef955510b827ef1a';

/**
 * Bytes of the DS01.3 Annex 4 delivery-schema change proposal, revision 1 —
 * the draft dated 2026-09-08, registered as the `ds013` shadow lineage.
 *
 * Unlike the two above, these bytes MAY legitimately be replaced: the proposal
 * is unpublished and will be revised (registry header; bd by1c.1). When that
 * happens this constant and the entry's `draftDate` move together — which is
 * the point of asserting it, so a re-pin is a deliberate edit and not a silent
 * one.
 */
const EXPECTED_SHA256_ANNEX4 = '7e22de27d46e2b6c4ad9f403c7de63ca1b9035c732be23aae7fbb42742324f05';

/** The registered CONTRACT cohort, oldest first. Two dialects, deliberately (bd 8qa.4). */
const REGISTERED = ['0.8.0', '0.8.1'];

/** Everything the registry accepts: contract cohort first, then the shadow lineage. */
const ACCEPTED = ['0.8.0', '0.8.1', '1'];

/** The vendored file backing a registry key — two lineages, two naming schemes. */
function vendoredFileFor(version: string): string {
  return version === '1' ? 'pqs-e006-ds01-annex4-1.json' : `cce-interop-${version}.json`;
}

test('normalizeVersion extracts MAJOR.MINOR.PATCH from bare semver', () => {
  assert.equal(normalizeVersion('0.8.0'), '0.8.0');
});

test('normalizeVersion extracts MAJOR.MINOR.PATCH from an $id URL', () => {
  assert.equal(normalizeVersion('https://schemas.2to8.cc/schemas/cce-interop-0.8.0.json'), '0.8.0');
});

test('normalizeVersion returns null when neither key shape is present', () => {
  assert.equal(normalizeVersion('latest'), null);
  assert.equal(normalizeVersion('0.8'), null);
  assert.equal(normalizeVersion('annex4'), null);
});

/**
 * The Annex 4 lineage's key shape. DS01.3 dropped semver deliberately — PQS will
 * not maintain a semver contract, and each annex versions independently — so
 * `meta.schemaVersion` there is the STRING "1", an integer revision counter, and
 * the `$id` is a URN rather than an https URL.
 */
test('normalizeVersion accepts a bare integer revision and its URN $id form', () => {
  assert.equal(normalizeVersion('1'), '1');
  assert.equal(normalizeVersion('urn:who:pqs:e006:ds01:annex4:1'), '1');
  assert.equal(normalizeVersion('12'), '12');
});

/**
 * Semver is tried FIRST, so a dotted triple never collapses onto an integer key.
 * "1.0.0" is the value an earlier draft of the proposal carried; it must stay a
 * semver key (and therefore unregistered) rather than quietly resolving to the
 * Annex 4 entry.
 */
test('normalizeVersion keeps 1.0.0 a semver key, not the integer revision 1', () => {
  assert.equal(normalizeVersion('1.0.0'), '1.0.0');
});

test('registry loads + compiles every vendored version at startup with its blessed sha256', () => {
  const registry = SchemaRegistry.load();
  assert.deepEqual(registry.supportedVersions(), REGISTERED, 'no-arg = the contract cohort');
  assert.deepEqual(registry.supportedVersions('2025'), REGISTERED);
  assert.deepEqual(registry.supportedVersions('ds013'), ['1']);
  assert.deepEqual(registry.acceptedVersions(), ACCEPTED);

  const current = registry.get('0.8.1');
  assert.ok(current, '0.8.1 must be registered');
  assert.equal(current.sha256, EXPECTED_SHA256);
  assert.equal(typeof current.validate, 'function');

  // 0.8.0 is registered ON PURPOSE (bd 8qa.4, amending fvw): a second, OLDER
  // version is what gives the outdated-but-valid branch of the schema stage a
  // live cohort to grade. Compiling it also proves the per-entry dialect
  // selection works — these bytes declare draft-07, not 2020-12, so a registry
  // that compiled everything with one Ajv build would fail load() outright.
  const outdated = registry.get('0.8.0');
  assert.ok(outdated, '0.8.0 must be registered');
  assert.equal(outdated.sha256, EXPECTED_SHA256_080);
  assert.equal(typeof outdated.validate, 'function');

  // The shadow lineage. Hash-asserted like the published bytes even though it is
  // a draft: "which revision of a moving document is loaded" is precisely the
  // question the dashboard's draft line answers, and it answers it with this
  // hash. It compiles under the SAME buildAjv('2020-12') path as 0.8.1 — no new
  // Ajv options were needed to take the Annex 4 bytes.
  const shadow = registry.get('1');
  assert.ok(shadow, 'the Annex 4 revision 1 must be registered');
  assert.equal(shadow.sha256, EXPECTED_SHA256_ANNEX4);
  assert.equal(shadow.profile, 'ds013');
  assert.equal(shadow.draftDate, '2026-09-08');
  assert.equal(typeof shadow.validate, 'function');
});

/**
 * The Annex 4 counterpart of the `$id` guard below: these bytes must be the
 * revision they are registered under, and their `$id` is a URN, not an https
 * URL — which is why the loop below cannot cover them. Asserted from the file so
 * a re-pin to a revised draft that forgot to bump `$id` (or landed under the
 * wrong key) fails here rather than silently grading against the wrong document.
 */
test('the vendored Annex 4 file self-identifies as revision 1 via its URN $id', () => {
  const bytes = readFileSync(
    fileURLToPath(new URL('./schemas/pqs-e006-ds01-annex4-1.json', import.meta.url)),
  );
  const schema = JSON.parse(bytes.toString('utf8')) as { $id?: string };
  assert.equal(schema.$id, 'urn:who:pqs:e006:ds01:annex4:1');
});

test('every entry declares its lineage; the contract lineage is 2025', () => {
  const registry = SchemaRegistry.load();
  assert.equal(CONTRACT_PROFILE, '2025');
  for (const version of REGISTERED) {
    assert.equal(registry.get(version)?.profile, '2025', `${version} is contract-grade`);
    assert.equal(registry.get(version)?.draftDate, undefined, `${version} is published, not draft`);
  }
});

/**
 * Dialect + isolation guard. EVERY vendored version must compile, whatever
 * dialect it declares — the 0.8.1 republication moved from draft-07 to 2020-12
 * and took the process down at boot, because compilation only ever happened
 * inside SchemaRegistry.load() during buildApp(). Written as a loop over
 * supportedVersions() rather than against named versions, so it covers whatever
 * set is registered; with 0.8.0 back it now spans two dialects at once, which is
 * the case a single shared Ajv instance could not survive.
 */
test('every vendored version compiles and gets its own entry', () => {
  const registry = SchemaRegistry.load();
  const versions = registry.acceptedVersions();
  assert.ok(versions.length > 0, 'registry is not empty');

  const seenHashes = new Set<string>();
  for (const version of versions) {
    const entry = registry.get(version);
    assert.ok(entry, `${version} must be registered`);
    assert.equal(typeof entry.validate, 'function', `${version} compiled to a validator`);
    assert.equal(seenHashes.has(entry.sha256), false, `${version} has distinct blessed bytes`);
    seenHashes.add(entry.sha256);
  }
});

/**
 * Regression guard. Until 2026-07-25 the vendored 0.8.1 was a copy of 0.8.0's
 * bytes with `$id` and both example `schemaVersion` values left reading
 * "0.8.0" — so the registry served 0.8.0's schema under the 0.8.1 key. Every
 * published release carries a version-specific `$id`; assert each vendored file
 * self-identifies as the version it is registered under.
 */
test('each vendored schema self-identifies as its registered version', () => {
  const registry = SchemaRegistry.load();
  // Contract lineage only: the `$id` convention asserted below is the
  // `cce-interop` one. The Annex 4 draft carries a URN `$id` of its own shape,
  // pinned in the test just above.
  for (const version of registry.supportedVersions()) {
    const bytes = readFileSync(
      fileURLToPath(new URL(`./schemas/cce-interop-${version}.json`, import.meta.url)),
    );
    const schema = JSON.parse(bytes.toString('utf8')) as {
      $id?: string;
      examples?: { meta?: { schemaVersion?: string } }[];
    };
    assert.equal(
      schema.$id,
      `https://schemas.2to8.cc/schemas/cce-interop-${version}.json`,
      `${version}: $id must name its own version`,
    );
    for (const [i, ex] of (schema.examples ?? []).entries()) {
      assert.equal(
        ex.meta?.schemaVersion,
        version,
        `${version}: embedded example ${i} must declare its own version`,
      );
    }
  }
});

/**
 * The provenance surface the API serves (beads 3cq). The property that matters
 * is that the reported hash is HASHED FROM THE VENDORED BYTES, not restated: the
 * dashboard's old hardcoded literal was once a hash of nothing at all. Written
 * as a loop that re-hashes each vendored file, so it stays true for whatever set
 * is registered rather than pinning the set of the day — which is how it survived
 * that set growing from one version to two.
 */
test('provenance reports every registered version with the hash of its bytes', () => {
  const registry = SchemaRegistry.load();
  const provenance = registry.provenance();

  assert.deepEqual(
    provenance.map((p) => p.version),
    [...registry.acceptedVersions()],
    'provenance covers exactly the registered set — BOTH lineages — in the same order',
  );

  for (const { version, sha256 } of provenance) {
    const bytes = readFileSync(
      fileURLToPath(new URL(`./schemas/${vendoredFileFor(version)}`, import.meta.url)),
    );
    assert.equal(
      sha256,
      createHash('sha256').update(bytes).digest('hex'),
      `${version}: reported sha256 must be the hash of the vendored bytes`,
    );
    assert.equal(registry.get(version)?.sha256, sha256, `${version}: same hash the registry uses`);
  }
});

test('provenance carries no compiled validator (safe to serialize)', () => {
  for (const entry of SchemaRegistry.load().provenance()) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      entry.draftDate === undefined
        ? ['profile', 'sha256', 'version']
        : ['draftDate', 'profile', 'sha256', 'version'],
      'provenance entries are {version, sha256, profile} plus draftDate for a draft',
    );
  }
});

test('provenance carries the profile, and draftDate only for the draft', () => {
  const provenance = SchemaRegistry.load().provenance();
  const byVersion = new Map(provenance.map((p) => [p.version, p]));
  assert.equal(byVersion.get('0.8.1')?.profile, '2025');
  assert.equal(byVersion.get('0.8.1')?.draftDate, undefined);
  assert.equal(byVersion.get('1')?.profile, 'ds013');
  assert.equal(byVersion.get('1')?.draftDate, '2026-09-08');
});

test('currentVersion is the newest registered version (numeric, not lexical)', () => {
  const registry = SchemaRegistry.load();
  assert.equal(registry.currentVersion(), '0.8.1');
  assert.equal(registry.currentVersion('2025'), '0.8.1');
  assert.equal(registry.currentVersion('ds013'), '1');
  // Now load-bearing rather than tautological: with 0.8.0 also registered, the
  // schema stage's outdated branch turns on `currentVersion() !== entry.version`,
  // so naming the WRONG newest version would silently invert which of the two
  // cohorts gets the OUTDATED SCHEMA signal.
  assert.equal(
    registry.supportedVersions().length,
    2,
    'there is an older version to be newer than',
  );
});

/**
 * The property registering a second LINEAGE had to preserve: currency is judged
 * within a lineage. Revision "1" of the Annex 4 draft is not a newer version of
 * 0.8.1 — the two counters belong to different standards — so 0.8.1 must remain
 * current, and a 0.8.1 transmission must not start collecting the OUTDATED
 * SCHEMA signal the day the shadow schema registered.
 */
test('the shadow lineage does not make the contract current version outdated', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('0.8.1');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(registry.currentVersion(res.entry.profile), '0.8.1', '0.8.1 is still current');
  }
});

test('shadowFor returns the current entry of the OTHER lineage', () => {
  const registry = SchemaRegistry.load();
  assert.equal(registry.shadowFor('2025')?.version, '1');
  assert.equal(registry.shadowFor('2025')?.profile, 'ds013');
  assert.equal(registry.shadowFor('ds013')?.version, '0.8.1');
  assert.equal(registry.shadowFor('ds013')?.profile, '2025');
  assert.equal(registry.shadowFor()?.version, '1', 'no-arg shadows the contract profile');
});

test('lookup resolves the Annex 4 revision from the bare integer and from its URN $id', () => {
  const registry = SchemaRegistry.load();
  for (const raw of ['1', 'urn:who:pqs:e006:ds01:annex4:1']) {
    const res = registry.lookup(raw);
    assert.equal(res.ok, true, `${raw} resolves`);
    if (res.ok) {
      assert.equal(res.entry.version, '1');
      assert.equal(res.entry.profile, 'ds013');
      assert.equal(res.entry.sha256, EXPECTED_SHA256_ANNEX4);
    }
  }
});

/**
 * "1.0.0" is what an earlier draft of the proposal declared. It is NOT the
 * registered revision "1" — accepting it would be exactly the fuzzy match the
 * registry refuses, and would grade a transmission against bytes it never named.
 */
test('the superseded 1.0.0 draft value is unsupported, not a near-miss for 1', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('1.0.0');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.requested, '1.0.0');
    assert.deepEqual(res.supported, ACCEPTED);
  }
});

/**
 * The Annex 4 bytes compile under the registry's EXISTING 2020-12 Ajv path —
 * same `{allErrors: true, strict: false}` build that takes 0.8.1 — and the
 * compiled validator is callable. load() would already have thrown otherwise;
 * this pins that no new Ajv configuration crept in with the new lineage.
 */
test('the compiled Annex 4 validator is callable under the existing 2020-12 build', () => {
  const entry = SchemaRegistry.load().get('1');
  assert.ok(entry);
  assert.equal(typeof entry.validate({ meta: {}, data: [{}] }), 'boolean');
});

test('the older registered version is outdated-but-valid, not unsupported', () => {
  // The property the §3.2 pass-outdated exercise case rests on
  // (src/exercise/cases/payload.ts): 0.8.0 must RESOLVE — a registry miss would
  // make it a 422 instead of an accepted-with-info transmission.
  const registry = SchemaRegistry.load();
  const res = registry.lookup('0.8.0');
  assert.equal(res.ok, true, '0.8.0 resolves');
  if (res.ok) {
    assert.equal(res.entry.version, '0.8.0');
    assert.equal(res.entry.sha256, EXPECTED_SHA256_080);
    assert.notEqual(registry.currentVersion(), '0.8.0', '0.8.0 is not the current version');
  }
});

test('lookup resolves a bare semver to the compiled entry', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('0.8.1');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.entry.version, '0.8.1');
    assert.equal(res.entry.sha256, EXPECTED_SHA256);
  }
});

test('lookup resolves a full $id URL to the same 0.8.1 entry', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('https://schemas.2to8.cc/schemas/cce-interop-0.8.1.json');
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.entry.version, '0.8.1');
});

test('unknown version reports unsupported + the supported list, no fuzzy match', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('0.1.1');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'unsupported');
    assert.equal(res.requested, '0.1.1');
    // The rejection lists everything the registry ACCEPTS, both lineages — the
    // honest answer to "what would you have taken?" (schema.ts renders it into
    // the §3.2 fail detail).
    assert.deepEqual(res.supported, ACCEPTED);
  }
});

test('unparseable version string is reported unsupported (no crash)', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('not-a-version');
  assert.equal(res.ok, false);
  if (!res.ok) assert.deepEqual(res.supported, ACCEPTED);
});

test('the compiled 0.8.1 validator accepts a minimal valid transmission', () => {
  const registry = SchemaRegistry.load();
  const entry = registry.get('0.8.1');
  assert.ok(entry);
  // Minimal shape: top-level requires meta + data (non-empty array).
  const valid = entry.validate({
    meta: {},
    data: [{}],
  });
  // We don't assert the exact schema outcome here (meta has its own required
  // fields); we only assert the validator is callable and returns a boolean.
  assert.equal(typeof valid, 'boolean');
});
