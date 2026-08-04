/**
 * Setup panel — sample-request guard (lg8).
 *
 * The Setup panel hands a first-run supplier a copy-paste curl snippet, and the
 * only thing that has ever asserted the body inside it is a comment. It drifted
 * twice: 48h fixed a hardcoded version string, auu fixed the body SHAPE (root
 * `schemaVersion`/`transferId`, a root `records`, empty `data` — a guaranteed
 * 422 the docblock claimed was a 200). Both were caught by manual audit only.
 *
 * So this pins the two claims the docblock makes:
 *
 *   1. the rendered body validates against the newest REGISTERED schema — the
 *      same compiled validator ingest grades with, reached through the real
 *      {@link SchemaRegistry}, not a re-read of the vendored bytes;
 *   2. it contains no single quote, because both call sites embed it in the
 *      shell snippet as `-d '<body>'` (Setup.tsx) and one quote would silently
 *      break the paste.
 *
 * `sampleBody` is a pure string function — no React, no DOM — so this needs no
 * component-test harness, and the repo still has none.
 *
 * The one concession: Setup.tsx pulls in JSX-bearing siblings (ui/Icon.tsx
 * evaluates JSX at module scope), and `tsx` finds NO jsx setting for src/web —
 * tsconfig.json excludes that tree, so esbuild falls back to the classic
 * `React.createElement` transform. Hence the global React binding and the
 * dynamic import below: they let the module graph load under the plain
 * `tsx --test` runner with no build-config change and no DOM. Nothing here
 * renders a component; only the pure function is called. If src/web ever gains
 * its own tsconfig (jsx: react-jsx), this shim can become a static import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import { SchemaRegistry } from '../../schema-registry.js';

(globalThis as unknown as { React: typeof React }).React = React;

// Dynamic + awaited so the assignment above runs BEFORE Setup's graph evaluates
// (static imports are all hoisted, which would defeat it).
const { sampleBody } = await import('./Setup.js');

/** The live registry, exactly as the service loads it at boot. */
const registry = SchemaRegistry.load();

/**
 * What the API serves the panel (GET /api/sessions/:uuid → `schemas`): the
 * registry's own provenance, oldest first. Copied into a mutable array because
 * the browser-side `SchemaProvenance[]` mirror is not readonly.
 */
function panelSchemas(): { version: string; sha256: string }[] {
  return registry.provenance().map(({ version, sha256 }) => ({ version, sha256 }));
}

test('sampleBody() renders a body the newest registered schema accepts', () => {
  const current = registry.currentVersion();
  assert.notEqual(current, null, 'registry must register at least one version');

  const body = JSON.parse(sampleBody(panelSchemas())) as { meta?: { schemaVersion?: string } };

  // The sample must declare the version it is graded against, or the round trip
  // through ingest would resolve a different validator than the one asserted on.
  assert.equal(body.meta?.schemaVersion, current);

  const found = registry.lookup(current!);
  if (!found.ok) assert.fail(`registry cannot look up its own current version ${current}`);

  const valid = found.entry.validate(body);
  assert.ok(valid, `sample body is invalid: ${JSON.stringify(found.entry.validate.errors)}`);
});

test('sampleBody() stays free of single quotes for the -d snippet', () => {
  assert.equal(sampleBody(panelSchemas()).includes("'"), false);
});
