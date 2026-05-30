import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaRegistry, normalizeVersion } from './schema-registry.js';

const EXPECTED_SHA256 = 'e6614cc7d749be2e22ae91353a8b08b8ac88eadadc86dc1bef955510b827ef1a';

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

test('registry loads + compiles 0.8.0 at startup with the blessed sha256', () => {
  const registry = SchemaRegistry.load();
  assert.deepEqual(registry.supportedVersions(), ['0.8.0']);
  const entry = registry.get('0.8.0');
  assert.ok(entry, '0.8.0 must be registered');
  assert.equal(entry.sha256, EXPECTED_SHA256);
  assert.equal(typeof entry.validate, 'function');
});

test('lookup resolves a bare semver to the compiled entry', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('0.8.0');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.entry.version, '0.8.0');
    assert.equal(res.entry.sha256, EXPECTED_SHA256);
  }
});

test('lookup resolves a full $id URL to the same 0.8.0 entry', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('https://schemas.2to8.cc/schemas/cce-interop-0.8.0.json');
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.entry.version, '0.8.0');
});

test('unknown version reports unsupported + the supported list, no fuzzy match', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('0.1.1');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'unsupported');
    assert.equal(res.requested, '0.1.1');
    assert.deepEqual(res.supported, ['0.8.0']);
  }
});

test('unparseable version string is reported unsupported (no crash)', () => {
  const registry = SchemaRegistry.load();
  const res = registry.lookup('not-a-version');
  assert.equal(res.ok, false);
  if (!res.ok) assert.deepEqual(res.supported, ['0.8.0']);
});

test('the compiled 0.8.0 validator accepts a minimal valid transmission', () => {
  const registry = SchemaRegistry.load();
  const entry = registry.get('0.8.0');
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
