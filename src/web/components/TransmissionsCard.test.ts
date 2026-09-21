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
import { readFileSync } from 'node:fs';
import * as React from 'react';

import { CONTRACT_PROFILE } from '../api';
import type { FindingView, Severity } from '../api';
import { PROFILE_NAME } from '../profiles.js';

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
  dotTone,
  flaggedPointers,
  signatureEyebrow,
  verdictColumns,
  chipTitle,
  rawPayloadSummary,
  advisoryLine,
  AdvisoryItem,
  translatedIdTitle,
  tightenedHint,
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
 * THE CELL ANSWERS FOR THE SELECTED PACKAGE (by1c.8, tfnv.7).
 *
 * Under the default lens it answers the question it always did — did this
 * transmission fail the contract in force? — so the other package's findings are
 * invisible to it. A payload that conforms to cce-interop 0.8.1 and misses Annex
 * 4's logger-identity properties is the canonical case: five DS01.3 failures, and
 * an unqualified OK here.
 *
 * Under the draft lens the same cell answers for DS01.3, and the three ways the
 * two packages differ all show up in one number: a §3.2 failure drops out (Annex
 * 4 re-runs that clause and files its own), a DS01.3 failure joins, and a
 * transport failure stays, carried forward by the clause map.
 */
test('DS01.3 findings reach neither the fail count nor the total under the default lens', () => {
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

test('a contract failure still shows, DS01.3 findings notwithstanding', () => {
  const cell = findingsCell([finding('fail'), finding('pass'), shadowFinding('fail')]);
  assert.equal(cell.text, '1f');
  assert.equal(cell.title, '1 of 2 findings failed');
});

test('under the draft lens the cell counts that package’s failures', () => {
  // §1.4 carries forward to 5.1.5 and still fails; the §3.2 result is not the
  // draft's to report; the DS01.3 failure is.
  const findings: FindingView[] = [
    { ...finding('fail'), requirement: '1.4', code: 'tx.too_large' },
    { ...finding('fail'), requirement: '3.2', keyword: 'type' },
    shadowFinding('fail'),
    { ...shadowFinding('pass'), requirement: '5.3.3' },
  ];
  const draft = findingsCell(findings, 'ds013', CONTRACT_PROFILE);
  assert.equal(draft.text, '2f');
  assert.equal(draft.title, '2 of 3 findings failed');

  // The same transmission under the contract package: both contract failures,
  // neither DS01.3 finding.
  const contract = findingsCell(findings, CONTRACT_PROFILE, CONTRACT_PROFILE);
  assert.equal(contract.text, '2f');
  assert.equal(contract.title, '2 of 2 findings failed');
});

test('a transmission that only fails §3.2 reads OK under the draft lens', () => {
  // Not a claim that the payload satisfies Annex 4 — the DS01.3 run files its own
  // findings, and this transmission carries none, so the draft found nothing to
  // report on it. Counting the 2025 schema result here would report a defect the
  // draft never measured.
  const cell = findingsCell(
    [{ ...finding('fail'), requirement: '3.2', keyword: 'type' }],
    'ds013',
    CONTRACT_PROFILE,
  );
  assert.equal(cell.text, 'OK');
  assert.equal(cell.title, 'No findings');
});

test('advisories are counted nowhere under either lens', () => {
  const findings = [finding('pass'), advisoryFinding('adv.null_padding')];
  assert.equal(findingsCell(findings, 'ds013', CONTRACT_PROFILE).title, '1 finding, none failed');
});

/**
 * The row's 6px tone dot (tfnv.18). It folds the same set the findings cell
 * counts, so the two ends of one row cannot report different packages: the dot
 * used to colour the contract lineage alone, which under the draft lens painted
 * a green dot beside a red fail count.
 */
test('the tone dot follows the selected package', () => {
  // Conforms to the contract, fails Annex 4: the draft re-runs §3.2 and files its
  // own finding, so the 2025 pass is not the draft's to show.
  const findings: FindingView[] = [
    { ...finding('pass'), requirement: '3.2' },
    shadowFinding('fail'),
  ];

  assert.equal(dotTone(findings, 'ds013', CONTRACT_PROFILE), 'fail');
  assert.equal(dotTone(findings, CONTRACT_PROFILE, CONTRACT_PROFILE), 'pass');
});

test('the tone dot is unchanged under the contract lens, which is the default', () => {
  assert.equal(dotTone([]), 'neutral');
  assert.equal(dotTone([finding('pass'), finding('pass')]), 'pass');
  assert.equal(dotTone([finding('fail')]), 'fail');
  assert.equal(dotTone([finding('pass'), finding('fail')]), 'mixed');
  // Nothing graded either way: info-only, and an advisory is not a verdict.
  assert.equal(dotTone([finding('info')]), 'neutral');
  assert.equal(dotTone([advisoryFinding('adv.null_padding')]), 'neutral');
  // A DS01.3 failure is no part of the contract verdict.
  assert.equal(dotTone([finding('pass'), shadowFinding('fail')]), 'pass');
});

test('the tone dot still reads mixed where the draft grades a pass and a fail', () => {
  // §1.4 carries forward to 5.1.5 and passed there; the DS01.3 run failed 5.3.2.
  const findings: FindingView[] = [
    { ...finding('pass'), requirement: '1.4' },
    shadowFinding('fail'),
  ];

  assert.equal(dotTone(findings, 'ds013', CONTRACT_PROFILE), 'mixed');
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
 * The cross-filter chip's title (by1c.12, tfnv.7). It used to be prefixed with
 * the package name for a signature of any lineage but the contract, so that a
 * cross-filter from the shadow surfaces could not be read as a defect against the
 * obligations in force. The grading lens retires the prefix: the page names the
 * selected package in its header, its banner and its verdict column, and the
 * signature list a chip comes from is grouped by package on the server.
 *
 * What this pins is that no package name is composed here at all — including for
 * a signature of the other lineage, which is the case the prefix existed for.
 */
test('the chip shows the signature title alone, naming no package', () => {
  assert.equal(
    chipTitle({ title: 'RTM logger identity missing', profile: 'ds013' }),
    'RTM logger identity missing',
  );
  assert.equal(
    chipTitle({ title: 'transferredAt has offset', profile: CONTRACT_PROFILE }),
    'transferredAt has offset',
  );
  assert.equal(
    chipTitle({ title: 'Null padding observed', profile: null }),
    'Null padding observed',
  );
  for (const name of Object.values(PROFILE_NAME)) {
    assert.doesNotMatch(chipTitle({ title: 'RTM logger identity missing' }), new RegExp(name));
  }
});

/**
 * WHAT AN ADVISORY ROW SHOWS (agj.17, synm). The row is the OBSERVATION —
 * `summary`, this payload's own numbers — and nothing else in prose: the
 * rationale is static per advisory id, so it belongs on the advisory's row in
 * the compliance column rather than behind a per-transmission expander that
 * would repeat the same paragraph on every row that carried the id.
 *
 * The claim worth pinning is the FALLBACK, because it is invisible in the happy
 * path and it is what keeps two cohorts of stored findings readable: a finding
 * written before `summary` existed and still inside the retention window, and a
 * check whose copy has not been converted yet. Either one carries `detail` alone
 * and must still render a line rather than an empty row.
 */
test('an advisory carrying a summary shows the observation, not the rationale', () => {
  assert.equal(
    advisoryLine({
      summary: '3 of 12 reports carry no appliance serial number.',
      detail: 'ASER is the appliance serial number, as assigned by the manufacturer.',
    }),
    '3 of 12 reports carry no appliance serial number.',
  );
  // A summary with nothing behind it is still the line.
  assert.equal(
    advisoryLine({ summary: '7 gaps exceed the 900 s period.', detail: null }),
    '7 gaps exceed the 900 s period.',
  );
});

test('an advisory with no summary falls back to its detail as the line', () => {
  // A finding stored before the summary existed, or a check not yet converted.
  assert.equal(
    advisoryLine({ summary: null, detail: 'Across the 48 records, TAMB is null.' }),
    'Across the 48 records, TAMB is null.',
  );
  // Blank is the same case as absent: a summary of spaces is not a line to show.
  assert.equal(
    advisoryLine({ summary: '   ', detail: 'Across the 48 records, TAMB is null.' }),
    'Across the 48 records, TAMB is null.',
  );
  // Nothing either way renders no line at all.
  assert.equal(advisoryLine({ summary: null, detail: null }), null);
});

/** Every element of one type in a returned tree, in render order. */
function elementsOfType(node: unknown, type: unknown): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!React.isValidElement(n)) return;
    if (n.type === type) found.push(n);
    walk((n.props as { children?: unknown }).children);
  };
  walk(node);
  return found;
}

/**
 * THE ADVISORY TITLE IS A CROSS-LINK (synm), on the same `onSelectReq` a
 * finding's § id uses. It has to be that callback and not a second mechanism:
 * the compliance card keys its open row off the value, so an advisory row opens
 * and scrolls exactly as a requirement row does — and the value it is handed is
 * the `adv.*` id, which is what the row is keyed by and cannot collide with a
 * clause id.
 *
 * AdvisoryItem is hook-free, so it is CALLED as a plain function and its tree
 * walked, the Setup.test.ts pattern.
 */
test('the advisory title opens that advisory in the compliance column', () => {
  const opened: string[] = [];
  const tree = AdvisoryItem({
    finding: advisoryFinding('adv.blank_admin'),
    onSelectReq: (req: string) => opened.push(req),
  });

  const controls = elementsOfType(tree, 'button');
  assert.equal(controls.length, 1, 'the title is the only control (the "why" expander is gone)');
  (controls[0]?.props as { onClick: () => void }).onClick();
  assert.deepEqual(opened, ['adv.blank_admin']);
});

/**
 * THE TWO TOOLTIPS THE DETAIL ROWS CARRY (tfnv.12, tfnv.7). Both compose a
 * package name, both are invisible until a pointer rests on the element, and
 * neither is derivable — so a rename could reword them with nothing to notice.
 *
 *   1. THE NAME COMES FROM THE VOCABULARY. The expectations are built from
 *      `PROFILE_NAME`, never from the words themselves, so renaming a package in
 *      src/web/profiles.ts moves the tooltip and this pin together. What would
 *      fail here is a tooltip that named a package from a literal, or abbreviated
 *      it to fit.
 *   2. THE OTHER NUMBER IS NAMED FOR WHAT IT IS. A row under the draft lens shows
 *      §5.1.5 where the database holds §1.4, and a supplier reconciling against
 *      their own logs needs to know which package the second number belongs to —
 *      "§1.4" alone would read as a second, unexplained clause.
 */
test('a translated id names the package its stored number belongs to', () => {
  assert.equal(
    translatedIdTitle('1.4', CONTRACT_PROFILE),
    `§1.4 under ${PROFILE_NAME[CONTRACT_PROFILE]}`,
  );
  assert.ok(translatedIdTitle('1.4', CONTRACT_PROFILE).startsWith('§1.4 under '));
});

test('the TIGHTENED tag’s tooltip says the clause changed, not that it moved', () => {
  const hint = tightenedHint('ds013');
  assert.ok(hint.startsWith(`${PROFILE_NAME.ds013} tightens`), hint);
  assert.match(hint, /not a renumbering/);
});

/**
 * WHO MAY SCROLL THE PAGE TO THE RAW-PAYLOAD REGION (bcb, ei0). Two claims the
 * compiler cannot hold, and which no test here can hold by rendering either:
 * this file reaches pure functions only (see the header), the suite has no DOM,
 * and both claims live in a component's hook wiring. They are pinned against the
 * source text instead, which is enough to notice the wiring being rewired.
 *
 *   1. THE LOCATE LINK REVEALS, ONCE (ei0). "Show this location in the raw
 *      payload" has to end with the location on the screen. Opening the
 *      inspector scrolls its INNER container to the pointer; only a `revealSeq`
 *      bump scrolls the page to the region itself, which can otherwise sit well
 *      below the fold. Exactly one bump per locate: the counter is the whole
 *      signal, and a second bump in the same handler is a second scroll.
 *   2. THE REVEAL EFFECT STILL KEYS ON `revealSeq` ALONE (bcb). That is what
 *      keeps the page still on an open transition nobody asked to be taken to —
 *      row selection, the section's own heading row. Adding `open` to the
 *      dependencies would make every later open scroll the page, because
 *      `revealSeq` never returns to 0.
 */
const componentSource = readFileSync(new URL('./TransmissionsCard.tsx', import.meta.url), 'utf8');

/** The body of a `const <name> = useCallback((…) => { … }, [deps]);` binding. */
function callbackBody(name: string): string {
  const start = componentSource.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(start, -1, `${name} not found — the pin below cannot hold`);
  const end = componentSource.indexOf('\n  }, [', start);
  assert.notEqual(end, -1, `${name} has no recognisable end`);
  return componentSource.slice(start, end);
}

test('a locate call bumps the reveal counter exactly once', () => {
  const body = callbackBody('onLocate');
  assert.equal((body.match(/setRevealSeq\(/g) ?? []).length, 1, body);
  assert.match(body, /setRevealSeq\(\(n\) => n \+ 1\)/);
});

test('the header control is the only other control that bumps it', () => {
  assert.equal((componentSource.match(/setRevealSeq\(/g) ?? []).length, 2);
  assert.match(
    callbackBody('toggleRawFromHeader'),
    /if \(!rawOpen\) setRevealSeq\(\(n\) => n \+ 1\)/,
  );
});

test('the reveal effect keys on the counter alone, so an unasked-for open does not scroll', () => {
  assert.match(
    componentSource,
    /rootRef\.current\?\.scrollIntoView\(\{ block: 'nearest'[^}]*\}\);\n\s*\}, \[revealSeq\]\);/,
  );
});

/**
 * THE DETAIL PANE IS ITS OWN CARD (tast; mq8x). The pane used to sit one 2px
 * divider below the list and open on a bare mono `t-` line, which let a reader
 * take it as describing the list's last row rather than the selected one. tast
 * put a gap there instead, but both regions still sat inside ONE card, so the
 * gap could only show that card's own `--surface-tx` and the two went on reading
 * as one surface. mq8x made them siblings. Four claims fix that, all of them
 * styling a component renders rather than a value it returns — so, like the
 * reveal wiring above, they are pinned against the source text. Nothing here can
 * be held by the compiler and nothing here has a DOM to be held against.
 *
 *   1. TWO CARDS, AND PAGE GROUND BETWEEN THEM. Each card carries its own
 *      border, radius and shadow, and both take the draft lens's border tint
 *      from the same expression, so the lens cannot tint one and miss the other.
 *      The gap is a `gap` on the column that holds them, over a `var(--bg)`
 *      ground — not a margin inside a card over `--surface-tx`.
 *   2. THE GAP IS ALSO A HEIGHT-BUDGET TERM, hence the arithmetic pinned below.
 *   3. THE TITLED, STICKY BAND. `Transmission detail` at the list card's own
 *      title size and weight, plus the identity line, sticking at `top: 0` so the
 *      identity survives a scroll deep into a long payload. The `t-` id under it
 *      is NOT bold: with a bold title above it, the title is what has to win.
 *   4. ONE ACCENT, TWO SURFACES. The selected row's left bar and the band's left
 *      bar must be the same width and the same token, or the tie they exist to
 *      make is not a tie. The width comes from one constant; both read
 *      `var(--accent)`.
 *
 * A fourth claim used to be here — that the band stayed sensible with nothing
 * selected — and it was retired with the branch it described (gcfj). The card
 * docks the newest transmission whenever the list is non-empty and renders the
 * band only there, so "nothing selected" was a state the pane could not reach;
 * `TxDetailHeader` now takes a non-null `TransmissionView` and the compiler
 * holds what that test was standing in for.
 */

/** The body of a `function <name>(…) { … }` declaration, to its closing brace. */
function functionBody(name: string): string {
  const start = componentSource.indexOf(`\nfunction ${name}(`);
  assert.notEqual(start, -1, `${name} not found — the pin below cannot hold`);
  const end = componentSource.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name} has no recognisable end`);
  return componentSource.slice(start, end);
}

test('the list and the detail are sibling cards with page ground between them', () => {
  assert.match(componentSource, /const DETAIL_GAP_PX = (1[2-6]);/);
  // The gap is the column's own `gap`, over a --bg ground, and no longer a
  // margin inside a card whose --surface-tx was all it could ever show.
  assert.match(componentSource, /gap: DETAIL_GAP_PX,/);
  assert.doesNotMatch(componentSource, /marginTop: DETAIL_GAP_PX,/);
  assert.match(componentSource, /background: 'var\(--bg\)',/);
  // Two cards: two borders, two radii, two shadows — and one expression for the
  // draft lens's tint, used twice, so the lens cannot tint one and miss the
  // other.
  const tinted =
    componentSource.match(
      /border: `1px solid var\(\$\{draftLens \? '--draft-border' : '--border-strong'\}\)`,/g,
    ) ?? [];
  assert.equal(tinted.length, 2, tinted.join('\n'));
  assert.equal((componentSource.match(/boxShadow: 'var\(--shadow\)',/g) ?? []).length, 2);
  // The 2px --border-strong divider is long gone, and so is the single card's
  // one-sided top edge on the detail region.
  assert.doesNotMatch(componentSource, /borderTop: '2px solid var\(--border-strong\)'/);
  assert.doesNotMatch(componentSource, /borderTop: '1px solid var\(--border-strong\)'/);
});

test('the detail header band is sticky, titled, and names the transmission', () => {
  const header = functionBody('TxDetailHeader');
  assert.match(header, /position: 'sticky',\n\s*top: 0,/);
  // Sentence case, at the list card's own title size and weight — not the
  // shared eyebrow style, which rendered it as faint small capitals.
  assert.match(header, /style=\{\{ fontSize: 13, fontWeight: 700 \}\}>Transmission detail</);
  assert.doesNotMatch(header, /style=\{eyebrow\}/);
  // …and the id below it carries no competing weight.
  assert.match(header, /style=\{\{ \.\.\.mono, fontSize: 13 \}\}>t-\{shortId\(tx\.id\)\}/);
  assert.doesNotMatch(header, /fontWeight: 700 \}\}>t-/);
  // The identity line the pane already showed, lifted into the band whole.
  assert.match(header, /t-\{shortId\(tx\.id\)\}/);
  assert.match(header, /\{tx\.sourceLabel\} · HTTP \{tx\.http_status \?\? '—'\} · \{relativeAgo\(/);
  // …and no longer duplicated in the body below it.
  assert.doesNotMatch(functionBody('TxDetail'), /shortId\(tx\.id\)/);
});

test('the selected row and the detail header share one accent bar', () => {
  assert.match(componentSource, /const ACCENT_BAR_PX = \d+;/);
  // Both bars take their width from the constant, so neither can drift alone.
  // The row's colour is conditional (transparent when unselected) and the band's
  // is not, so the pin is on the width and the token, not on the expression.
  const bars = componentSource.match(/borderLeft: `\$\{ACCENT_BAR_PX\}px solid [^`]+`/g) ?? [];
  assert.equal(bars.length, 2, bars.join('\n'));
  for (const bar of bars) assert.match(bar, /var\(--accent\)/);
  // The row's old marker was --text, which tied it to nothing.
  assert.doesNotMatch(componentSource, /2px solid var\(--text\)/);
});

test('the height-budget docblock does the arithmetic the constants actually make', () => {
  const rows = Number(/const LIST_VISIBLE_ROWS = (\d+);/.exec(componentSource)?.[1]);
  const rowPx = Number(/const ROW_ESTIMATE_PX = (\d+);/.exec(componentSource)?.[1]);
  const gap = Number(/const DETAIL_GAP_PX = (\d+);/.exec(componentSource)?.[1]);
  assert.ok(rows > 0 && rowPx > 0 && gap > 0);

  // The docblock states the cap as a product and the budget as a sum ending in
  // the list and the gap. Both have to be the sum the constants produce, or the
  // fold conclusion drawn from them is about a layout that does not ship.
  const product = new RegExp(
    `if the row chrome changes: ${rows} × ${rowPx} = ${rows * rowPx}px\\.`,
  );
  assert.match(componentSource, product);
  const sum = /\+ list (\d+) \+ detail gap (\d+)\s+= (\d+)/.exec(componentSource);
  assert.ok(sum, 'the budget sum line is missing');
  assert.equal(Number(sum[1]), rows * rowPx);
  assert.equal(Number(sum[2]), gap);
  // 214 above the pane + 16 body padding + 3 card edges + 44 card header
  // + 41 verdict header. The card-edges term is the list card's top and bottom
  // borders and the detail card's top border (mq8x) — one 1px border per card
  // boundary the column now has above the detail card's content box.
  assert.equal(Number(sum[3]), 214 + 16 + 3 + 44 + 41 + rows * rowPx + gap);
});
