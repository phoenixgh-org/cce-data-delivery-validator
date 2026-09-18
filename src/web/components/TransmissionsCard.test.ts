/**
 * Transmission detail meta grid — layout order and the `type` derivation (j1s).
 *
 * Two claims are pinned here, both of which the component states in prose and
 * neither of which the compiler can hold:
 *
 *   1. THE ROW SPLIT. Six VALUE cells over `META_GRID_COLUMNS` columns is what
 *      puts transferId/schema/type on the top row and reports/bytes/compression
 *      on the second. Nothing about a CSS grid says so — reorder `metaCells()`
 *      or move the column count and the two rows silently regroup. The test
 *      does the same arithmetic the browser does (fill left to right, wrap
 *      every `META_GRID_COLUMNS`).
 *
 *      The raw-payload control is NO LONGER part of that split. It was the sixth
 *      cell of a five-cell grid until frk added `reports`; a seventh cell would
 *      orphan a one-wide row, so TxDetail now gives the control a row of its own
 *      spanning all three columns and it is outside the arithmetic here.
 *
 *   1b. THE `reports` COUNT. `reportCount()` returns null — rendered `—` — for
 *      every case where `data[]` cannot be read, and never 0: a transmission
 *      that failed to parse still carried whatever it carried (frk). The row's
 *      tooltip then has to say WHICH of the two unknowns it is, which is
 *      `parse_ok`'s job and not something the count itself can tell (8js8).
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

import { CONTRACT_PROFILE } from '../api';
import type { FindingView, Severity } from '../api';
import { groupDetailFindings } from '../detailGroups.js';

(globalThis as unknown as { React: typeof React }).React = React;

// Dynamic + awaited so the assignment above runs BEFORE the component graph
// evaluates (static imports are all hoisted, which would defeat it).
const {
  metaCells,
  deriveTransmissionType,
  reportCount,
  reportCountLabel,
  reportCountTitle,
  META_GRID_COLUMNS,
  findingsCell,
  flaggedPointers,
  signatureEyebrow,
  verdictColumns,
  shadowFailCount,
  chipTitle,
  rawPayloadSummary,
  advisoryLine,
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

test('the meta grid reads transferId/schema/type over reports/bytes/compression', () => {
  // The raw-payload control spans all three columns on its own row below these,
  // so it takes no part in the split.
  const keys = metaCells(tx()).map((c) => c.key);

  assert.deepEqual(rows(keys), [
    ['transferId', 'schema', 'type'],
    ['reports', 'bytes', 'compression'],
  ]);
});

test('reportCount reads the length of data[], and null wherever it cannot', () => {
  assert.equal(reportCount({ meta: {}, data: [{ CID: 'a' }, { CID: 'b' }] }), 2);
  assert.equal(reportCount({ meta: {}, data: [{ CID: 'a' }] }), 1);
  // minItems is 1 in the schema, but an empty array is a real count, not unknown.
  assert.equal(reportCount({ meta: {}, data: [] }), 0);

  // Unknown, NOT zero: nothing to read, or the wrong shape to read it from.
  assert.equal(reportCount({ meta: {} }), null);
  assert.equal(reportCount({ data: { '0': { CID: 'a' } } }), null);
  assert.equal(reportCount({ data: 3 }), null);
  assert.equal(reportCount(null), null);
  assert.equal(reportCount([{ CID: 'a' }]), null);
  assert.equal(reportCount('{"data":[]}'), null);
});

test('a parse-failed transmission shows an em-dash for reports, never 0', () => {
  // body null is exactly what the API sends when the payload did not parse.
  const byKey = new Map(metaCells(tx({ body: null })).map((c) => [c.key, c.value]));
  assert.equal(byKey.get('reports'), '—');

  assert.equal(reportCountLabel(null), '—');
  assert.equal(reportCountLabel(1), '1 report');
  assert.equal(reportCountLabel(2), '2 reports');
  assert.equal(reportCountLabel(0), '0 reports');
});

test('the unknown-count tooltip says which of the two unknowns it is (8js8)', () => {
  // reportCount() returns null for two different reasons and `parse_ok` is what
  // tells them apart. Claiming a parse failure on a row the parse stage never
  // reached is a false causal statement — the size 413, the encoding 400s and
  // the enabled-auth 401 all persist a row with body null and parse_ok null.
  assert.equal(
    reportCountTitle(null, false),
    'Report count unknown — the payload did not parse, so data[] could not be read',
  );
  assert.equal(
    reportCountTitle(null, null),
    'Report count unknown — the pipeline halted before the payload was parsed, so data[] ' +
      'was never read',
  );
  // A halted row must not be told it failed to parse, in either direction.
  assert.doesNotMatch(reportCountTitle(null, null), /did not parse/);
  assert.doesNotMatch(reportCountTitle(null, false), /halted/);
});

test('an unknown count on a cleanly parsed row says the body was JSON null (g11f)', () => {
  // The third state: POSTing the four bytes `null` parses cleanly, so the row
  // carries parse_ok true, body null and a §1.1 pass. Neither of the other two
  // sentences is true of it — nothing halted and nothing failed to parse.
  assert.equal(
    reportCountTitle(null, true),
    'Report count unknown — the payload parsed to JSON null, so there is no data[] to read',
  );
  assert.doesNotMatch(reportCountTitle(null, true), /did not parse|halted/);
});

test('a known count keeps its own tooltip whatever parse_ok says', () => {
  assert.equal(reportCountTitle(1, true), '1 report in this transmission');
  assert.equal(reportCountTitle(2, true), '2 reports in this transmission');
  // parse_ok is read ONLY on the unknown branch, so a count of 0 — a body that
  // parsed to an empty data[] — never reads as an unknown.
  assert.equal(reportCountTitle(0, true), '0 reports in this transmission');
});

test('the raw-payload summary says which of the two unparsed rows it is (i83q)', () => {
  // Same false causal claim as the tooltip above, in the detail pane. A row the
  // parse stage rejected and a row it never reached both arrive here with body
  // null and raw_body set; parse_ok is the only thing that tells them apart.
  assert.equal(
    rawPayloadSummary({ body: null, raw_body: '{"meta":{}}', parse_ok: false }),
    'raw bytes — payload did not parse',
  );
  assert.equal(
    rawPayloadSummary({ body: null, raw_body: '{"meta":{}}', parse_ok: null }),
    'raw bytes — the pipeline halted before the payload was parsed',
  );
  // The §1.4 413, the §1.6 encoding 400s and the enabled-auth 401 are the rows
  // that carry parse_ok null, and none of them may be told its payload failed.
  assert.doesNotMatch(
    rawPayloadSummary({ body: null, raw_body: 'x', parse_ok: null }),
    /did not parse/,
  );
  assert.doesNotMatch(rawPayloadSummary({ body: null, raw_body: 'x', parse_ok: false }), /halted/);
});

test('the raw-payload summary names the row whose JSON was the literal null (g11f)', () => {
  // Measured live: POST the four bytes `null` and the row persists as parse_ok
  // true, body null, raw_body "null", beside a §1.1 pass. The summary moves with
  // reportCountTitle, which reads parse_ok the same way (26b6a0e).
  assert.equal(
    rawPayloadSummary({ body: null, raw_body: 'null', parse_ok: true }),
    'raw bytes — the payload parsed to JSON null, so there is nothing to render',
  );
  assert.doesNotMatch(
    rawPayloadSummary({ body: null, raw_body: 'null', parse_ok: true }),
    /did not parse|halted/,
  );
  // Nothing retained still wins over parse_ok, in the new state as in the others.
  assert.equal(rawPayloadSummary({ body: null, raw_body: null, parse_ok: true }), 'not retained');
});

test('the raw-payload summary names the parsed and the not-retained rows', () => {
  // A parsed body wins over anything parse_ok says: the bytes are on hand AS JSON.
  assert.equal(
    rawPayloadSummary({ body: { meta: {} }, raw_body: null, parse_ok: true }),
    'parsed JSON',
  );
  assert.equal(rawPayloadSummary({ body: null, raw_body: null, parse_ok: false }), 'not retained');
  assert.equal(rawPayloadSummary({ body: null, raw_body: null, parse_ok: null }), 'not retained');
});

test('the meta cells carry the transmission values', () => {
  const cells = metaCells(
    tx({ wire_bytes: '512', content_encoding: 'gzip', body: bodyWith('ems', null) }),
  );
  const byKey = new Map(cells.map((c) => [c.key, c.value]));

  assert.equal(byKey.get('transferId'), 'T-001');
  assert.equal(byKey.get('schema'), 'v0.8.1');
  assert.equal(byKey.get('type'), 'ems');
  assert.equal(byKey.get('reports'), '1');
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
    summary: null,
    detail: null,
    pointer: null,
    outdated: false,
    keyword: null,
    instancePath: null,
    param: null,
    code: null,
    profile: CONTRACT_PROFILE,
  };
}

/** A DS01.3 shadow finding — a different lineage's verdict on the same payload. */
function shadowFinding(severity: Severity): FindingView {
  return { ...finding(severity), requirement: '5.3.2', profile: 'ds013' };
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

/**
 * DS01.3 SHADOW FINDINGS in the row's verdict cell (by1c.8).
 *
 * The cell answers one question — did this transmission fail the contract in
 * force? — so the second lineage's verdict has to be invisible to it. A payload
 * that conforms to cce-interop 0.8.1 and misses Annex 4's logger-identity
 * properties is the canonical case: five shadow failures, and an unqualified OK
 * here until by1c.12 gives DS01.3 its own column.
 */
test('DS01.3 shadow findings reach neither the fail count nor the total', () => {
  const cell = findingsCell([
    finding('pass'),
    finding('pass'),
    shadowFinding('fail'),
    shadowFinding('fail'),
  ]);
  assert.equal(cell.text, 'OK');
  assert.equal(cell.color, 'var(--pass)');
  assert.equal(cell.title, '2 findings, none failed');
});

test('a contract failure still shows, shadow findings notwithstanding', () => {
  const cell = findingsCell([finding('fail'), finding('pass'), shadowFinding('fail')]);
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

/**
 * The verdict columns (by1c.12). The header's labels and the dots a row draws
 * come from ONE function so the two cannot drift, and the shadow column exists
 * only when the session reports a shadow lineage — the hide signal is served
 * (`session.shadowProfile`), never inferred from whether shadow findings happen
 * to be present.
 */
test('the shadow column appears only when a shadow lineage is registered', () => {
  assert.deepEqual(verdictColumns('ds013'), [CONTRACT_PROFILE, 'ds013']);
  assert.deepEqual(verdictColumns(null), [CONTRACT_PROFILE]);
});

/**
 * The cross-filter chip's title (by1c.12). A shadow cross-filter must announce
 * the lineage it came from, or it reads as a defect against obligations that are
 * not in force. The rule tests "not the contract profile" rather than naming
 * ds013, and an advisory — which grades against no lineage at all — takes no
 * prefix.
 */
test('a shadow signature prefixes the chip title with its lineage; a contract one does not', () => {
  assert.equal(
    chipTitle({ title: 'RTM logger identity missing', profile: 'ds013' }),
    'DS01.3 DRAFT · RTM logger identity missing',
  );
  assert.equal(
    chipTitle({ title: 'transferredAt has offset', profile: CONTRACT_PROFILE }),
    'transferredAt has offset',
  );
  assert.equal(
    chipTitle({ title: 'Null padding observed', profile: null }),
    'Null padding observed',
  );
});

/**
 * The SHADOW FAIL COUNT (by1c.38, by1c.39) — the number in the verdict tooltip's
 * parenthetical ("DS01.3: fail (5 findings)") and, since by1c.39, the number on
 * the detail pane's "Would also fail under DS01.3 DRAFT" header.
 *
 * Three rules ride on it, none of them visible in its signature:
 *
 *   1. it counts the SHADOW lineage's failures, never the row's total — a
 *      contract failure is a different lineage's verdict and belongs to the
 *      other dot;
 *   2. advisories are excluded, the rule `findingsCell` follows for the same
 *      reason: an advisory is not a verdict and must never inflate a number a
 *      supplier has to explain;
 *   3. it is zero when the shadow never ran, and zero when no shadow lineage is
 *      registered at all — in neither case is there a failure to report.
 */
test('the count is the shadow lineage’s failures, not the transmission’s', () => {
  const findings = [
    finding('fail'),
    finding('fail'),
    shadowFinding('fail'),
    shadowFinding('fail'),
    shadowFinding('pass'),
  ];
  assert.equal(shadowFailCount(findings, 'ds013'), 2);
});

test('advisories never join the shadow fail count', () => {
  const advisory: FindingView = {
    ...finding('info'),
    requirement: 'adv.null_padding',
    code: 'adv.null_padding',
    profile: 'ds013',
  };
  assert.equal(shadowFailCount([shadowFinding('fail'), advisory], 'ds013'), 1);
});

test('a transmission the shadow never graded counts zero, and so does no shadow lineage', () => {
  assert.equal(shadowFailCount([finding('fail'), finding('pass')], 'ds013'), 0);
  assert.equal(shadowFailCount([shadowFinding('fail'), shadowFinding('fail')], null), 0);
});

/**
 * ONE TRANSMISSION, ONE NUMBER (by1c.39). The detail pane's group header used to
 * show the number of rows, which is the count AFTER several missing properties at
 * one path collapse into a single line — so the list row said "(5 findings)" and
 * the header immediately below it said "1". The header shows the raw fail count
 * now; the collapse still governs what the rows look like, not what they total.
 */
test('the DS01.3 group header shows the same count as the row’s tooltip', () => {
  const missing = (index: number, param: string): FindingView => ({
    ...shadowFinding('fail'),
    keyword: 'required',
    instancePath: `/data/${index}`,
    param,
    detail: `schema violation at /data/${index}: must have required property '${param}'`,
  });
  const findings = [
    missing(0, 'LSER'),
    missing(0, 'LMOD'),
    missing(0, 'LMFR'),
    missing(0, 'LTYP'),
    missing(0, 'LID'),
  ];
  const { shadow } = groupDetailFindings(findings, 'ds013');
  assert.equal(shadow.length, 1, 'five omissions at one path are one row');
  assert.equal(shadowFailCount(findings, 'ds013'), 5);
});

/**
 * WHAT AN ADVISORY ROW SHOWS (agj.17). Advisory prose is two pieces — `summary`
 * is the one-line observation with its numbers, `detail` the rationale — and the
 * row shows the observation with the rationale behind a "why" expander.
 *
 * The claim worth pinning is the FALLBACK, because it is invisible in the happy
 * path and it is what keeps two cohorts of stored findings readable: a finding
 * written before `summary` existed and still inside the retention window, and a
 * check whose copy has not been converted yet. Either one carries `detail` alone
 * and must render exactly as it did before the split — as the line, with nothing
 * behind an expander that would open on empty.
 */
test('an advisory carrying a summary shows it, with the rationale behind the expander', () => {
  const { line, expandable } = advisoryLine({
    summary: '3 of 12 reports carry no appliance serial number.',
    detail: 'ASER is the appliance serial number, as assigned by the manufacturer.',
  });
  assert.equal(line, '3 of 12 reports carry no appliance serial number.');
  assert.equal(expandable, true);
});

test('an advisory with no summary shows its detail on the row and offers no expander', () => {
  // A finding stored before the column existed, or a check not yet converted.
  const stored = advisoryLine({ summary: null, detail: 'Across the 48 records, TAMB is null.' });
  assert.equal(stored.line, 'Across the 48 records, TAMB is null.');
  assert.equal(stored.expandable, false);

  // Blank is the same case as absent: a summary of spaces is not a line to show.
  const blank = advisoryLine({ summary: '   ', detail: 'Across the 48 records, TAMB is null.' });
  assert.equal(blank.line, 'Across the 48 records, TAMB is null.');
  assert.equal(blank.expandable, false);
});

test('a summary with no rationale behind it opens no empty expander', () => {
  const { line, expandable } = advisoryLine({
    summary: '7 gaps exceed the 900 s period.',
    detail: null,
  });
  assert.equal(line, '7 gaps exceed the 900 s period.');
  assert.equal(expandable, false);
});
