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

import type { FindingView, Severity } from '../api';

(globalThis as unknown as { React: typeof React }).React = React;

// Dynamic + awaited so the assignment above runs BEFORE the component graph
// evaluates (static imports are all hoisted, which would defeat it).
const {
  metaCells,
  deriveTransmissionType,
  META_GRID_COLUMNS,
  findingsCell,
  flaggedPointers,
  signatureEyebrow,
} = await import('./TransmissionsCard.js');

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

/**
 * The row's far-right findings cell (7hz): the total finding count used to
 * render there (`{n}f`, red on any failure, muted otherwise, with a separate
 * faint `ok` for zero findings) gave no way to tell "N failed" from "N total,
 * none failed" apart. `findingsCell` collapses every no-failure case to one
 * green OK and switches to the FAIL count — never the total — only when a
 * failure is actually present.
 */
function finding(severity: Severity): FindingView {
  return {
    requirement: '1.1',
    severity,
    detail: null,
    pointer: null,
    outdated: false,
    keyword: null,
    instancePath: null,
    param: null,
    code: null,
  };
}

test('no findings at all reads as a green OK with a "No findings" tooltip', () => {
  const cell = findingsCell([]);
  assert.equal(cell.text, 'OK');
  assert.equal(cell.color, 'var(--pass)');
  assert.equal(cell.title, 'No findings');
});

test('all-pass findings read as OK, not the total count', () => {
  const cell = findingsCell([finding('pass'), finding('pass'), finding('pass')]);
  assert.equal(cell.text, 'OK');
  assert.equal(cell.color, 'var(--pass)');
  assert.equal(cell.title, '3 findings, none failed');
});

test('info-only findings read as OK too — info is not a failure', () => {
  const cell = findingsCell([finding('info'), finding('info')]);
  assert.equal(cell.text, 'OK');
  assert.equal(cell.color, 'var(--pass)');
  assert.equal(cell.title, '2 findings, none failed');
});

test('a pass+fail mix shows the FAIL count, not the total', () => {
  const cell = findingsCell([finding('pass'), finding('pass'), finding('fail'), finding('pass')]);
  assert.equal(cell.text, '1f');
  assert.equal(cell.color, 'var(--fail)');
  assert.equal(cell.title, '1 of 4 findings failed');
});

test('fail-only findings show every one as the fail count', () => {
  const cell = findingsCell([finding('fail'), finding('fail'), finding('fail')]);
  assert.equal(cell.text, '3f');
  assert.equal(cell.color, 'var(--fail)');
  assert.equal(cell.title, '3 of 3 findings failed');
});

test('singular wording: one finding total reads "1 finding", not "1 findings"', () => {
  assert.equal(findingsCell([finding('pass')]).title, '1 finding, none failed');
  assert.equal(findingsCell([finding('fail')]).title, '1 of 1 finding failed');
});

/**
 * ADVISORIES in the transmission row and the raw-payload inspector (pwd/bva).
 *
 * An advisory is raised against a payload that broke no rule, so a supplier at
 * 100 % conformance must be able to carry them with nothing on the row reading
 * as a failure — which means the two places a finding leaks a tone or a number
 * have to ignore them: the row's verdict cell, and the inspector's amber
 * line-highlight (--mixed, the dashboard's warning tone).
 */
function advisoryFinding(id: string, pointer: string | null = null): FindingView {
  // The shape slice A's advisory() helper emits: severity info, the adv.* id in
  // both requirement and code, outdated left false.
  return { ...finding('info'), requirement: id, code: id, pointer };
}

test('advisories are counted nowhere in the row’s findings cell', () => {
  // Three passes plus two advisories: still an unqualified OK, and the tooltip
  // counts the graded findings only — an advisory must not give a conformant
  // transmission a number to explain.
  const cell = findingsCell([
    finding('pass'),
    finding('pass'),
    finding('pass'),
    advisoryFinding('adv.null_padding'),
    advisoryFinding('adv.null_identity'),
  ]);
  assert.equal(cell.text, 'OK');
  assert.equal(cell.color, 'var(--pass)');
  assert.equal(cell.title, '3 findings, none failed');
});

test('advisories never join the fail count or its denominator', () => {
  const cell = findingsCell([
    finding('fail'),
    finding('pass'),
    advisoryFinding('adv.null_padding'),
  ]);
  assert.equal(cell.text, '1f');
  assert.equal(cell.title, '1 of 2 findings failed');
});

test('the inspector highlights finding pointers but never an advisory’s', () => {
  const flagged = flaggedPointers([
    { ...finding('fail'), pointer: '/data/0/TVC', instancePath: '/data/0/TVC' },
    advisoryFinding('adv.null_padding', '/data/0/TCON'),
  ]);

  // The highlight paints in --mixed, the warning tone — an advisory's lines must
  // stay untouched. Its `pointer:` button still scrolls there by data-path.
  assert.deepEqual([...flagged], ['/data/0/TVC']);
});

test('the cross-filter chip calls an advisory an Advisory, not an Issue', () => {
  // agj.18: the eyebrow was the literal "Issue" for whatever signature the
  // compliance column picked. Since agj.16 that can be an advisory — raised
  // against a payload that broke no rule — and labelling it a defect is the one
  // thing DESIGN §7.1 forbids the category.
  assert.equal(signatureEyebrow({ kind: 'advisory' }), 'Advisory');
  assert.equal(signatureEyebrow({ kind: 'schema' }), 'Issue');
  assert.equal(signatureEyebrow({ kind: 'check' }), 'Issue');
});
