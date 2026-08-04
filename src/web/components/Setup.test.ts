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
 *
 * The README quick-start (xl7) is guarded here too, in the same file, because it
 * is the SECOND copy of this body and Setup.tsx's docblock claims the two are
 * the same shape. Those tests need only the registry, not the panel — see
 * {@link readmeSampleBody} for why the README copy rots differently. That "same
 * shape" claim is itself asserted at the bottom of the file (82p): schema
 * validity never implied it, and a still-valid divergence passed green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

/**
 * The README's copy of the first-run body, lifted out of its fenced shell block.
 *
 * Resolved from this file's own URL, never `process.cwd()`, so the test holds
 * wherever the runner is invoked from.
 *
 * Deliberately unclever, and deliberately noisy on a miss: every step that could
 * silently match nothing asserts instead, because a guard that passes when it
 * finds no body is worse than no guard at all — it would go on reporting green
 * through exactly the edit it exists to catch. So it pins the block by the
 * ingest curl inside it rather than by position, requires EXACTLY one such
 * block and exactly one `-d '…'` in it, and fails with what it was looking for
 * if the fence, the flag, or the quoting ever changes.
 *
 * The single-quote scan is what makes the lazy `'…'` match sound: the body may
 * not contain a single quote (the test above holds the panel's copy to that, and
 * the README's `-d '<body>'` depends on it the same way), so the first `'` after
 * the flag is necessarily the closing one.
 */
function readmeSampleBody(): unknown {
  const readmePath = new URL('../../../README.md', import.meta.url);
  const readme = readFileSync(readmePath, 'utf8');

  const blocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const ingest = blocks.filter((b) => /curl\s+[^\n]*\$BASE\/i\//.test(b));
  assert.equal(
    ingest.length,
    1,
    `expected exactly 1 fenced bash block POSTing to $BASE/i/ in README.md, found ${ingest.length}` +
      ' — the quick-start moved, its fence changed, or it was duplicated',
  );

  const block = ingest[0];
  const bodies = [...block.matchAll(/-d '([^']*)'/g)].map((m) => m[1]);
  assert.equal(
    bodies.length,
    1,
    `expected exactly 1 single-quoted -d body in the README quick-start, found ${bodies.length}`,
  );

  const parsed: unknown = JSON.parse(bodies[0]);
  assert.equal(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    true,
    'README quick-start -d body did not parse to a JSON object',
  );
  return parsed;
}

/**
 * Why this is a test and not a fix in the README: README.md hardcodes
 * `"schemaVersion": "0.8.1"`. The panel deliberately stopped doing that (48h,
 * 3cq — it derives the version from `SchemaRegistry.provenance()`), but static
 * markdown cannot derive anything at runtime. So the staleness is designed to
 * surface HERE, loudly, the moment the registry's current version moves. Fix it
 * by editing the README's literal; do not make the README dynamic.
 */
test('the README quick-start body declares the registry current version', () => {
  const current = registry.currentVersion();
  assert.notEqual(current, null, 'registry must register at least one version');

  const body = readmeSampleBody() as { meta?: { schemaVersion?: string } };
  assert.equal(
    body.meta?.schemaVersion,
    current,
    'README.md hardcodes schemaVersion; the registry current version moved — update the README',
  );
});

test('the README quick-start body is one the newest registered schema accepts', () => {
  const current = registry.currentVersion();
  assert.notEqual(current, null, 'registry must register at least one version');

  const found = registry.lookup(current!);
  if (!found.ok) assert.fail(`registry cannot look up its own current version ${current}`);

  const valid = found.entry.validate(readmeSampleBody());
  assert.ok(valid, `README sample body is invalid: ${JSON.stringify(found.entry.validate.errors)}`);
});

/** What a node is, ignoring what it holds — the only thing "shape" grades. */
type NodeKind = 'object' | 'array' | 'leaf';

function nodeKind(value: unknown): NodeKind {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object' && value !== null) return 'object';
  return 'leaf';
}

/**
 * Flatten a parsed body to `path → kind` for every node below the root, e.g.
 * `meta.transferId → leaf`, `data → array`, `data[0].records[0].TVC → leaf`.
 *
 * Values are deliberately not recorded: the two copies legitimately carry
 * different sample values (transferId demo-001 vs T-001, ALRM null vs "HEAT",
 * BEMD 100 vs 14.3, different timestamps), and grading those would make the
 * guard fire on edits it has no business objecting to. `null` is a leaf like any
 * other scalar, so a null↔string difference is a value difference, not a shape
 * one.
 *
 * ARRAYS ARE ENUMERATED BY INDEX (`data[0]`, `data[1]`, …), which is the whole
 * array decision, made here rather than left incidental. Both `data` and
 * `records` hold exactly one element today. Indexing means each element is
 * compared with its counterpart at the same position, and a length difference —
 * including one side going empty — surfaces as paths present on one side only,
 * named individually. The alternative (compare only element 0, or union the
 * element shapes) would let an extra or emptied element pass unexamined, which
 * is the silent-green failure this whole guard exists to stop. If the two
 * samples ever legitimately want different element counts, that is a decision to
 * take deliberately here, not to discover as a test surprise.
 *
 * Recording the KIND alongside the path is what catches an object/array/scalar
 * swap that happens to keep the same key set (`DLST: {…}` becoming `DLST: 5`).
 */
function shapeOf(
  value: unknown,
  path = '',
  into = new Map<string, NodeKind>(),
): Map<string, NodeKind> {
  const kind = nodeKind(value);
  if (path !== '') into.set(path, kind);

  if (kind === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      shapeOf(child, path === '' ? key : `${path}.${key}`, into);
    }
  } else if (kind === 'array') {
    (value as unknown[]).forEach((el, i) => shapeOf(el, `${path}[${i}]`, into));
  }
  return into;
}

/**
 * The third rot mode (82p): Setup.tsx's docblock claims the panel's sample is the
 * "Same shape as the README quick-start", and until now nothing asserted it. The
 * two tests above hold the README copy to being schema-VALID and current-versioned
 * only, so any divergence that is still valid passed green — measured on bce308d,
 * an extra `"transferSubject": "cce"` under the README's `meta` left all four
 * tests green while the panel's copy did not gain it. The docblock was false and
 * the guard said nothing.
 *
 * So this compares key structure, not values, and reports the diverging paths by
 * name and by side — whoever trips this in a year needs the answer, not two key
 * trees to diff by eye.
 */
test('the panel sample and the README quick-start body are the same shape', () => {
  const panel = shapeOf(JSON.parse(sampleBody(panelSchemas())));
  const readme = shapeOf(readmeSampleBody());

  const divergences: string[] = [];
  for (const [path, kind] of panel) {
    const other = readme.get(path);
    if (other === undefined) divergences.push(`${path} — present in the PANEL only`);
    else if (other !== kind)
      divergences.push(`${path} — ${kind} in the PANEL, ${other} in the README`);
  }
  for (const path of readme.keys()) {
    if (!panel.has(path)) divergences.push(`${path} — present in the README only`);
  }
  divergences.sort();

  assert.equal(
    divergences.length,
    0,
    'Setup.tsx sampleBody() claims "Same shape as the README quick-start", but the two bodies' +
      ` diverge at ${divergences.length} path(s):\n  ${divergences.join('\n  ')}\n` +
      'Edit whichever copy drifted (src/web/components/Setup.tsx sampleBody() or the README' +
      ' quick-start block), or drop the docblock claim if the divergence is deliberate.' +
      ' Sample VALUES may differ freely; key structure may not.',
  );
});
