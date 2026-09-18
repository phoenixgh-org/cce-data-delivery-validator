/**
 * The docked detail's list rules under the grading lens (by1c.14, tfnv.7) — the
 * rules, not the markup.
 *
 * What is pinned here is what no type can hold, each with a way of going wrong
 * quietly:
 *
 *   1. THE DEFAULT VIEW IS UNCHANGED. Under the contract lens the list is the
 *      contract lineage's findings under their own ids, in order — what the pane
 *      rendered before the lens, minus the retired "· also 5.x.x" suffix.
 *   2. THE TRANSLATION. Under the draft lens a contract finding is shown under
 *      its DS01.3 clause and keeps its stored 2025 id; §3.2 is shown NOWHERE,
 *      because Annex 4 re-runs that clause and files its own findings, and the
 *      other lineage's findings are invisible under the contract lens.
 *   3. WHICH ROWS KEEP THE SCHEMA PHRASING. A failure of the lens's own lineage
 *      collapses, takes its title from the matching signature and shows a
 *      generalized pointer; a PASS of that lineage does not — it is a graded
 *      finding like any other and needs its severity on screen.
 *   4. THE COLLAPSE, THE POINTER PAIR AND THE `transferredAt` PHRASING, each
 *      carried over from the shadow group unchanged.
 *
 * Pure functions on the Node runner, like profiles.test.ts: detailGroups.ts
 * pulls in no JSX-bearing sibling, so no React shim and no dynamic import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_PROFILE, type FindingView, type Signature } from './api.js';
import {
  clauseRowText,
  detailGroupCopy,
  detailRows,
  rowPointer,
  transferredAtPhrase,
  type ClauseRow,
  type FindingRow,
} from './detailGroups.js';
import { PROFILE_NAME } from './profiles.js';
import { findingSignatureKey } from './signatureKey.js';

const DRAFT = 'ds013';

/** A finding as the session read serves it, defaulted so a case states its point. */
function finding(over: Partial<FindingView> = {}): FindingView {
  return {
    requirement: '1.1',
    severity: 'fail',
    summary: null,
    detail: null,
    pointer: null,
    outdated: false,
    keyword: null,
    instancePath: null,
    param: null,
    code: null,
    profile: CONTRACT_PROFILE,
    ...over,
  };
}

/** The signature the server would have folded `f` into, with a readable title. */
function signatureFor(f: FindingView, title: string): Signature {
  return {
    key: findingSignatureKey(f),
    req: f.requirement,
    profile: f.profile,
    title,
    kind: f.keyword === null ? 'check' : 'schema',
    sev: f.severity,
    count: 1,
    txCount: 1,
    sourceCount: 1,
    first: '2026-09-14T00:00:00.000Z',
    last: '2026-09-14T00:00:00.000Z',
    examplePointer: f.pointer,
  };
}

/** A ds013 `required` failure at one record index. */
function missing(index: number, param: string): FindingView {
  return finding({
    requirement: '5.3.2',
    profile: DRAFT,
    keyword: 'required',
    instancePath: `/data/${index}`,
    param,
    detail: `schema violation at /data/${index}: must have required property '${param}' (§5.3.2)`,
  });
}

/** The one `pass` finding a clean DS01.3 run writes — the proof that it ran. */
function draftRan(): FindingView {
  return finding({
    requirement: '5.3.2',
    profile: DRAFT,
    severity: 'pass',
    detail: 'validated against DRAFT 1 (§5.3.2)',
  });
}

/** The clause rows of a list, for the cases that are about the schema phrasing. */
function clauseRows(rows: readonly (FindingRow | ClauseRow)[]): ClauseRow[] {
  return rows.filter((r): r is ClauseRow => r.kind === 'clause');
}

// ── 1. the default view ────────────────────────────────────────────────────

test('under the contract lens the list is today’s rows, ids and order', () => {
  const findings = [
    finding({ requirement: '1.1', code: 'tx.missing_charset' }),
    finding({ requirement: '3.2', severity: 'pass' }),
    finding({ requirement: '3.4', severity: 'info', outdated: true }),
  ];
  const rows = detailRows([...findings, draftRan(), missing(0, 'LSER')], CONTRACT_PROFILE);

  assert.deepEqual(
    rows.map((r) => r.id),
    ['1.1', '3.2', '3.4'],
  );
  assert.deepEqual(
    rows.map((r) => (r.kind === 'finding' ? r.finding : null)),
    findings,
  );
  // Nothing is translated, so no row carries a second id, and nothing is tagged.
  assert.deepEqual(
    rows.map((r) => (r.kind === 'finding' ? r.storedId : 'clause')),
    [null, null, null],
  );
  assert.deepEqual(
    rows.map((r) => r.tightened),
    [false, false, false],
  );
});

test('advisories are never rows, under either lens', () => {
  const advisory = finding({
    requirement: 'adv.null_padding',
    code: 'adv.null_padding',
    severity: 'info',
  });
  assert.deepEqual(detailRows([advisory], CONTRACT_PROFILE), []);
  assert.deepEqual(detailRows([advisory], DRAFT), []);
});

// ── 2. the translation ─────────────────────────────────────────────────────

test('under the draft lens a contract finding shows its clause and keeps its stored id', () => {
  const rows = detailRows([finding({ requirement: '1.4', code: 'tx.too_large' })], DRAFT);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, 'finding');
  assert.equal(row.id, '5.1.6');
  assert.equal(row.kind === 'finding' && row.storedId, '1.4');
});

test('§3.2 is shown nowhere under the draft lens — Annex 4 files its own', () => {
  const rows = detailRows(
    [finding({ requirement: '3.2', keyword: 'type' }), missing(0, 'LSER')],
    DRAFT,
    CONTRACT_PROFILE,
    { signatures: [] },
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['5.3.2'],
  );
  assert.equal(rows[0]?.kind, 'clause');
});

test('the other package’s findings are invisible under the contract lens', () => {
  assert.deepEqual(detailRows([missing(0, 'LSER'), draftRan()], CONTRACT_PROFILE), []);
});

test('a requirement the clause map does not carry forward is shown nowhere', () => {
  assert.deepEqual(detailRows([finding({ requirement: '9.9' })], DRAFT), []);
});

test('the §3.1 custom-object finding lands on 5.3.5, the rest of §3.1 on 5.3.3', () => {
  const rows = detailRows(
    [
      finding({ requirement: '3.1', code: 'tx.missing_custom_schema' }),
      finding({ requirement: '3.1', code: 'tx.transferred_at_missing' }),
    ],
    DRAFT,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['5.3.5', '5.3.3'],
  );
});

test('a tightened clause is tagged under the draft lens and nowhere else', () => {
  // 1.8 → 5.1.10, one of the four clauses whose conformance changed.
  const tightened = detailRows([finding({ requirement: '1.8' })], DRAFT);
  assert.equal(tightened[0]?.id, '5.1.10');
  assert.equal(tightened[0]?.tightened, true);
  // 1.4 → 5.1.6 is a renumbering, not a tightening.
  assert.equal(detailRows([finding({ requirement: '1.4' })], DRAFT)[0]?.tightened, false);
  // Under the contract lens nothing is tightened: it is the package a tightening
  // would be measured against.
  assert.equal(
    detailRows([finding({ requirement: '1.8' })], CONTRACT_PROFILE)[0]?.tightened,
    false,
  );
});

// ── 3. which rows keep the schema phrasing ─────────────────────────────────

test('a failure of the lens’s own lineage is a clause row; its pass finding is not', () => {
  const fail = missing(0, 'LSER');
  const rows = detailRows([draftRan(), fail], DRAFT, CONTRACT_PROFILE, {
    signatures: [signatureFor(fail, 'Missing required property LSER')],
  });
  // The pass keeps the finding rendering — its severity has to stay on screen.
  assert.equal(rows[0]?.kind, 'finding');
  assert.equal(rows[0]?.id, '5.3.2');
  // The failure takes the schema phrasing, and sorts after the finding rows.
  assert.equal(rows[1]?.kind, 'clause');
  assert.equal(clauseRowText(clauseRows(rows)[0]!), '5.3.2 schema — LSER required');
});

test('a clean run under the draft lens lists the carried-forward findings and the pass', () => {
  const rows = detailRows(
    [finding({ requirement: '1.1', severity: 'pass' }), draftRan()],
    DRAFT,
    CONTRACT_PROFILE,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['5.1.3', '5.3.2'],
  );
  assert.deepEqual(clauseRows(rows), []);
});

// ── 4. the required collapse ───────────────────────────────────────────────

test('required failures at one generalized path collapse to a single row', () => {
  const findings = [missing(0, 'LSER'), missing(0, 'LMOD'), missing(7, 'LSER')];
  const signatures = findings.map((f) => signatureFor(f, `Missing required property ${f.param}`));
  const rows = clauseRows(detailRows(findings, DRAFT, CONTRACT_PROFILE, { signatures }));
  assert.equal(rows.length, 1);
  assert.equal(clauseRowText(rows[0]!), '5.3.2 schema — LSER, LMOD required');
});

test('required failures at two paths stay two rows', () => {
  const meta = finding({
    requirement: '5.3.3',
    profile: DRAFT,
    keyword: 'required',
    instancePath: '/meta',
    param: 'customDataSchema',
  });
  const findings = [missing(0, 'LSER'), meta];
  const signatures = findings.map((f) => signatureFor(f, `Missing required property ${f.param}`));
  const rows = clauseRows(detailRows(findings, DRAFT, CONTRACT_PROFILE, { signatures }));
  assert.deepEqual(rows.map(clauseRowText), [
    '5.3.2 schema — LSER required',
    '5.3.3 schema — customDataSchema required',
  ]);
  // Both clauses are ones DS01.3 tightened, so both rows carry the tag.
  assert.deepEqual(
    rows.map((r) => r.tightened),
    [true, true],
  );
});

test('a non-required failure keeps its signature title and detail', () => {
  const f = finding({
    requirement: '5.3.2',
    profile: DRAFT,
    keyword: 'type',
    instancePath: '/data/0/TVC',
    detail: 'schema violation at /data/0/TVC: must be number (§5.3.2)',
  });
  const rows = clauseRows(
    detailRows([f], DRAFT, CONTRACT_PROFILE, {
      signatures: [signatureFor(f, 'TVC has the wrong type')],
    }),
  );
  assert.equal(
    clauseRowText(rows[0]!),
    '5.3.2 TVC has the wrong type — schema violation at /data/0/TVC: must be number (§5.3.2)',
  );
  assert.equal(rows[0]?.sig?.title, 'TVC has the wrong type');
});

test('a row with no matching signature falls back to the finding’s own detail', () => {
  const f = finding({
    requirement: '5.3.2',
    profile: DRAFT,
    keyword: 'enum',
    instancePath: '/meta/transferType',
    detail: 'schema violation at /meta/transferType: must be equal to one of the allowed values',
  });
  const rows = clauseRows(detailRows([f], DRAFT, CONTRACT_PROFILE, { signatures: [] }));
  assert.equal(rows[0]?.sig, null);
  assert.equal(
    clauseRowText(rows[0]!),
    '5.3.2 schema violation at /meta/transferType: must be equal to one of the allowed values',
  );
});

// ── the transferredAt phrasing ─────────────────────────────────────────────

test('the transferredAt row shows the offset the payload sent', () => {
  assert.equal(
    transferredAtPhrase({ meta: { transferredAt: '2026-09-14T08:00:00+03:00' } }),
    '+03:00 → needs Z',
  );
  assert.equal(
    transferredAtPhrase({ meta: { transferredAt: '2026-09-14T08:00:00-05:30' } }),
    '-05:30 → needs Z',
  );
});

test('a body with no usable transferredAt yields no phrase', () => {
  assert.equal(transferredAtPhrase({ meta: { transferredAt: '2026-09-14T08:00:00Z' } }), null);
  assert.equal(transferredAtPhrase({ meta: {} }), null);
  assert.equal(transferredAtPhrase(null), null);
  assert.equal(transferredAtPhrase('not an object'), null);
});

test('the transferredAt row is phrased from the body, and falls back without one', () => {
  const f = finding({
    requirement: '5.3.3',
    profile: DRAFT,
    keyword: 'pattern',
    instancePath: '/meta/transferredAt',
    param: 'pattern',
    detail: 'schema violation at /meta/transferredAt: must match pattern (§5.3.3)',
  });
  const signatures = [signatureFor(f, 'transferredAt does not match the required pattern')];

  const phrased = clauseRows(
    detailRows([f], DRAFT, CONTRACT_PROFILE, {
      signatures,
      body: { meta: { transferredAt: '2026-09-14T08:00:00+03:00' } },
    }),
  );
  assert.equal(clauseRowText(phrased[0]!), '5.3.3 transferredAt +03:00 → needs Z');

  const fallback = clauseRows(
    detailRows([f], DRAFT, CONTRACT_PROFILE, { signatures, body: { meta: {} } }),
  );
  assert.equal(
    clauseRowText(fallback[0]!),
    '5.3.3 transferredAt does not match the required pattern — schema violation at /meta/transferredAt: must match pattern (§5.3.3)',
  );
});

test('both phrasings keep the signature key, so the row still cross-filters', () => {
  const f = finding({
    requirement: '5.3.3',
    profile: DRAFT,
    keyword: 'pattern',
    instancePath: '/meta/transferredAt',
    param: 'pattern',
  });
  const rows = clauseRows(
    detailRows([f], DRAFT, CONTRACT_PROFILE, {
      signatures: [signatureFor(f, 'transferredAt does not match the required pattern')],
      body: { meta: { transferredAt: '2026-09-14T08:00:00+03:00' } },
    }),
  );
  assert.equal(rows[0]?.key, findingSignatureKey(f));
  assert.equal(rows[0]?.sig?.key, findingSignatureKey(f));
});

// ── the list copy ──────────────────────────────────────────────────────────

test('the heading names the selected package from the vocabulary, never a literal', () => {
  assert.equal(
    detailGroupCopy(CONTRACT_PROFILE, 2).heading,
    `Findings · ${PROFILE_NAME[CONTRACT_PROFILE]}`,
  );
  assert.equal(detailGroupCopy(DRAFT, 2).heading, `Findings · ${PROFILE_NAME[DRAFT]}`);
});

test('an empty list says so on the heading’s right, and otherwise carries the § hint', () => {
  assert.equal(detailGroupCopy(DRAFT, 0).note, 'none — passes');
  assert.equal(detailGroupCopy(DRAFT, 1).note, 'click § to open the requirement');
  assert.equal(detailGroupCopy(CONTRACT_PROFILE, 1).note, 'click § to open the requirement');
});

// ── the row's pointer (by1c.40) ────────────────────────────────────────────

/**
 * A clause row is clickable into the raw payload, the way every finding row is.
 * The collapsed row is the awkward one: it folds several records, so what it
 * SHOWS is the generalized path the fold buckets on and what it OPENS is the
 * first concrete path — a generalized path matches no line in the inspector.
 */
test('a collapsed row shows the generalized path and opens the first concrete one', () => {
  const findings = [missing(0, 'LSER'), missing(0, 'LMOD'), missing(7, 'LSER')];
  const signatures = findings.map((f) => signatureFor(f, `Missing required property ${f.param}`));
  const rows = clauseRows(detailRows(findings, DRAFT, CONTRACT_PROFILE, { signatures }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.pointer, '/data/*');
  assert.equal(rows[0]?.locate, '/data/0');
});

test('a row that folds nothing shows and opens its own pointer', () => {
  const f = finding({
    requirement: '5.3.2',
    profile: DRAFT,
    keyword: 'type',
    instancePath: '/data/0/TVC',
    detail: 'schema violation at /data/0/TVC: must be number (§5.3.2)',
  });
  const rows = clauseRows(
    detailRows([f], DRAFT, CONTRACT_PROFILE, {
      signatures: [signatureFor(f, 'TVC has the wrong type')],
    }),
  );
  assert.equal(rows[0]?.pointer, '/data/0/TVC');
  assert.equal(rows[0]?.locate, '/data/0/TVC');
});

test('the pointer helper generalizes only for the collapse, and nulls the locate with no path', () => {
  const at = missing(3, 'LSER');
  assert.deepEqual(rowPointer(at, true), { pointer: '/data/*', locate: '/data/3' });
  assert.deepEqual(rowPointer(at, false), { pointer: '/data/3', locate: '/data/3' });
  const rootless = finding({ profile: DRAFT, instancePath: null, pointer: null });
  assert.deepEqual(rowPointer(rootless, false), { pointer: null, locate: null });
});
