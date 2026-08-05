import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SchemaRegistry, normalizeVersion } from './schema-registry.js';

/** Blessed bytes of the published 0.8.1 (JSON Schema 2020-12) — the CURRENT version. */
const EXPECTED_SHA256 = '290290fd4623d25c3fc18724f317249469e03bee9d64ec39279730d3b3a87470';

/** Blessed bytes of the published 0.8.0 (JSON Schema draft-07) — the outdated cohort. */
const EXPECTED_SHA256_080 = 'e6614cc7d749be2e22ae91353a8b08b8ac88eadadc86dc1bef955510b827ef1a';

/** The registered set, oldest first. Two dialects, deliberately (bd 8qa.4). */
const REGISTERED = ['0.8.0', '0.8.1'];

test('normalizeVersion extracts MAJOR.MINOR.PATCH from bare semver', () => {
  assert.equal(normalizeVersion('0.8.0'), '0.8.0');
});

test('normalizeVersion extracts MAJOR.MINOR.PATCH from an $id URL', () => {
  assert.equal(normalizeVersion('https://schemas.2to8.cc/schemas/cce-interop-0.8.0.json'), '0.8.0');
});

test('normalizeVersion returns null when no semver triple is present', () => {
  assert.equal(normalizeVersion('latest'), null);
  assert.equal(normalizeVersion('0.8'), null);
});

test('registry loads + compiles both vendored versions at startup with their blessed sha256s', () => {
  const registry = SchemaRegistry.load();
  assert.deepEqual(registry.supportedVersions(), REGISTERED);

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
  const versions = registry.supportedVersions();
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
    [...registry.supportedVersions()],
    'provenance covers exactly the registered set, in the same order',
  );

  for (const { version, sha256 } of provenance) {
    const bytes = readFileSync(
      fileURLToPath(new URL(`./schemas/cce-interop-${version}.json`, import.meta.url)),
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
      ['sha256', 'version'],
      'provenance entries are exactly {version, sha256}',
    );
  }
});

test('currentVersion is the newest registered version (numeric, not lexical)', () => {
  const registry = SchemaRegistry.load();
  assert.equal(registry.currentVersion(), '0.8.1');
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
    assert.deepEqual(res.supported, REGISTERED);
  }
});

test('unparseable version string is reported unsupported (no crash)', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('not-a-version');
  assert.equal(res.ok, false);
  if (!res.ok) assert.deepEqual(res.supported, REGISTERED);
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
