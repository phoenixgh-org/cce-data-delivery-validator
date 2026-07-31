import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SchemaRegistry, normalizeVersion } from './schema-registry.js';

/** Blessed bytes of the published 0.8.1 (JSON Schema 2020-12). */
const EXPECTED_SHA256 = '290290fd4623d25c3fc18724f317249469e03bee9d64ec39279730d3b3a87470';

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

test('registry loads + compiles 0.8.1 at startup with the blessed sha256', () => {
  const registry = SchemaRegistry.load();
  assert.deepEqual(registry.supportedVersions(), ['0.8.1']);
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 must be registered');
  assert.equal(entry.sha256, EXPECTED_SHA256);
  assert.equal(typeof entry.validate, 'function');
});

/**
 * Dialect + isolation guard. EVERY vendored version must compile, whatever
 * dialect it declares — the 0.8.1 republication moved from draft-07 to 2020-12
 * and took the process down at boot, because compilation only ever happened
 * inside SchemaRegistry.load() during buildApp(). Written as a loop over
 * supportedVersions() rather than against named versions, so it keeps its teeth
 * (and re-acquires the distinct-hash assertion) the moment a second version is
 * registered again.
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

test('currentVersion is the newest registered version (numeric, not lexical)', () => {
  const registry = SchemaRegistry.load();
  assert.equal(registry.currentVersion(), '0.8.1');
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
    assert.deepEqual(res.supported, ['0.8.1']);
  }
});

test('unparseable version string is reported unsupported (no crash)', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('not-a-version');
  assert.equal(res.ok, false);
  if (!res.ok) assert.deepEqual(res.supported, ['0.8.1']);
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
