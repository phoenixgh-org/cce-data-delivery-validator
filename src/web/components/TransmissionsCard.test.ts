/**
 * Transmission detail meta grid — layout order and the `type` derivation (j1s).
 *
 * Two claims are pinned here, both of which the component states in prose and
 * neither of which the compiler can hold:
 *
 *   1. THE ROW SPLIT. Six cells over `META_GRID_COLUMNS` columns is what puts
 *      transferId/schema/type on the top row and bytes/compression/raw payload
 *      on the bottom. Nothing about a CSS grid says so — reorder `metaCells()`
 *      or move the column count and the two rows silently regroup. The test
 *      does the same arithmetic the browser does (fill left to right, wrap
 *      every `META_GRID_COLUMNS`) with the raw-payload control appended as the
 *      sixth cell, exactly as TxDetail renders it.
 *
 *   2. THE `type` VALUE. It used to be the request `Content-Type` and now names
 *      the transmission type off the payload, which is the one cell in the grid
 *      whose value is COMPUTED rather than passed through — including the
 *      `mixed` case that no conformant payload can produce (see
 *      `deriveTransmissionType`) and the null-body case that must not throw.
 *
 * Like Setup.test.ts, this reaches pure functions only — no React renderer, no
 * DOM. TransmissionsCard.tsx pulls in JSX-bearing siblings that evaluate at
 * module scope under esbuild's classic transform, hence the global React
 * binding plus the dynamic import; see Setup.test.ts for the full explanation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

(globalThis as unknown as { React: typeof React }).React = React;

// Dynamic + awaited so the assignment above runs BEFORE the component graph
// evaluates (static imports are all hoisted, which would defeat it).
const { metaCells, deriveTransmissionType, META_GRID_COLUMNS } =
  await import('./TransmissionsCard.js');

/** The meta-grid inputs, defaulted so each test states only what it varies. */
function tx(over: Partial<Parameters<typeof metaCells>[0]> = {}): Parameters<typeof metaCells>[0] {
  return {
    transfer_id: 'T-001',
    schema_version: '0.8.1',
    wire_bytes: '512',
    content_encoding: null,
    body: null,
    ...over,
  };
}

/** A body carrying `meta.transferType` and one report per entry of `types`. */
function bodyWith(metaType: string | null, ...types: (string | null)[]): unknown {
  return {
    meta: metaType === null ? {} : { transferType: metaType },
    data: types.map((t) => (t === null ? { CID: 'c' } : { CID: 'c', transferType: t })),
  };
}

/** Chunk the rendered cell keys the way the CSS grid lays them out. */
function rows(keys: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += META_GRID_COLUMNS) {
    out.push(keys.slice(i, i + META_GRID_COLUMNS));
  }
  return out;
}

test('the meta grid reads transferId/schema/type over bytes/compression/raw payload', () => {
  // TxDetail renders metaCells() then the raw-payload control as the sixth cell.
  const keys = [...metaCells(tx()).map((c) => c.key), 'raw payload'];

  assert.deepEqual(rows(keys), [
    ['transferId', 'schema', 'type'],
    ['bytes', 'compression', 'raw payload'],
  ]);
});

test('the meta cells carry the transmission values', () => {
  const cells = metaCells(
    tx({ wire_bytes: '512', content_encoding: 'gzip', body: bodyWith('ems', null) }),
  );
  const byKey = new Map(cells.map((c) => [c.key, c.value]));

  assert.equal(byKey.get('transferId'), 'T-001');
  assert.equal(byKey.get('schema'), 'v0.8.1');
  assert.equal(byKey.get('type'), 'ems');
  assert.equal(byKey.get('bytes'), '512');
  assert.equal(byKey.get('compression'), 'gzip');
});

test('a single-type transmission reads that type', () => {
  // The conformant shape: one meta type, reports that state nothing.
  assert.equal(deriveTransmissionType(bodyWith('rtm', null)), 'rtm');
  assert.equal(deriveTransmissionType(bodyWith('ems', null, null)), 'ems');
  // Reports may restate the meta type; agreeing is not "mixed".
  assert.equal(deriveTransmissionType(bodyWith('rtm', 'rtm', 'rtm')), 'rtm');
  // Casing is compared case-insensitively but DISPLAYED as first claimed.
  assert.equal(deriveTransmissionType(bodyWith('RTM', 'rtm')), 'RTM');
});

test('reports of differing types read as mixed', () => {
  assert.equal(deriveTransmissionType(bodyWith('rtm', 'rtm', 'ems')), 'mixed');
  // One dissenting report is enough, whether or not its siblings state a type.
  assert.equal(deriveTransmissionType(bodyWith('rtm', null, 'ems')), 'mixed');
  assert.equal(deriveTransmissionType(bodyWith('ems', 'rtm')), 'mixed');
});

test('the type is the meta value when the reports say nothing', () => {
  assert.equal(deriveTransmissionType({ meta: { transferType: 'ems' } }), 'ems');
  assert.equal(deriveTransmissionType({ meta: { transferType: 'ems' }, data: [] }), 'ems');
  assert.equal(deriveTransmissionType(bodyWith('ems', null, null)), 'ems');
});

test('an unknown type degrades to an em-dash rather than throwing', () => {
  // No payload retained / parse halted before the body stage — the common case.
  assert.equal(deriveTransmissionType(null), '—');
  assert.equal(deriveTransmissionType(undefined), '—');
  // Bodies that parsed but are not a transmission at all.
  assert.equal(deriveTransmissionType('{"meta":{}}'), '—');
  assert.equal(deriveTransmissionType([{ transferType: 'rtm' }]), '—');
  assert.equal(deriveTransmissionType({}), '—');
  assert.equal(deriveTransmissionType({ meta: null, data: null }), '—');
  // Present but not a usable string — never rendered as "undefined"/blank.
  assert.equal(deriveTransmissionType({ meta: { transferType: 7 } }), '—');
  assert.equal(deriveTransmissionType({ meta: { transferType: '  ' } }), '—');
  assert.equal(deriveTransmissionType({ meta: { transferType: '' }, data: [{}] }), '—');
});

test('a report type stands in when meta carries none', () => {
  assert.equal(deriveTransmissionType(bodyWith(null, 'rtm')), 'rtm');
  assert.equal(deriveTransmissionType(bodyWith(null, 'rtm', 'ems')), 'mixed');
  // A report that states nothing claims nothing — it is not a second type.
  assert.equal(deriveTransmissionType(bodyWith(null, null, 'ems')), 'ems');
});

test('the type cell renders what deriveTransmissionType() says', () => {
  const value = (body: unknown): string | undefined =>
    metaCells(tx({ body })).find((c) => c.key === 'type')?.value;

  assert.equal(value(bodyWith('rtm', null)), 'rtm');
  assert.equal(value(bodyWith('rtm', 'rtm', 'ems')), 'mixed');
  assert.equal(value(null), '—');
});
