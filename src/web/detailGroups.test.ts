/**
 * The docked detail's grouping rules (by1c.14) — the rules, not the markup.
 *
 * Four claims here are wording or policy that no type can hold, and each has a
 * way of going wrong quietly:
 *
 *   1. THE "· also 5.x.x" SUFFIX. It reports the re-tag rule in
 *      src/api/verdicts.ts (`RE_RUN_UNDER_SHADOW`, line 79): a contract failure
 *      counts under DS01.3 too, EXCEPT §3.2, whose counterpart the shadow
 *      validator re-runs for itself. Suffixing a §3.2 finding would claim a
 *      shadow result that was never produced.
 *   2. GROUP 2 IS CONDITIONAL. The shadow run writes a `pass` finding when it is
 *      clean, so "has ds013 findings" is not "would fail"; only a ds013 FAIL
 *      makes a row.
 *   3. THE COLLAPSE. Missing properties at one generalized path are one thing to
 *      fix; at two paths they are two.
 *   4. THE `transferredAt` PHRASING. It shows the supplier their own offset, so
 *      it depends on the body — and must fall back rather than invent one when
 *      the body does not carry it.
 *
 * Pure functions on the Node runner, like profiles.test.ts: detailGroups.ts
 * pulls in no JSX-bearing sibling, so no React shim and no dynamic import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_PROFILE, type FindingView, type Signature } from './api.js';
import {
  alsoFailsClause,
  detailGroupCopy,
  groupDetailFindings,
  shadowRowPointer,
  shadowRowText,
  transferredAtPhrase,
} from './detailGroups.js';
import { PROFILE_NAME } from './profiles.js';
import { findingSignatureKey } from './signatureKey.js';

const SHADOW = 'ds013';

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
    profile: SHADOW,
    keyword: 'required',
    instancePath: `/data/${index}`,
    param,
    detail: `schema violation at /data/${index}: must have required property '${param}' (§5.3.2)`,
  });
}

/** The one `pass` finding a clean shadow run writes — the proof that it ran. */
function shadowRan(): FindingView {
  return finding({
    requirement: '5.3.2',
    profile: SHADOW,
    severity: 'pass',
    detail: 'validated against DRAFT 1 (§5.3.2)',
  });
}

// ── 1. the "· also 5.x.x" suffix ───────────────────────────────────────────

test('a contract failure carrying a forward mapping is suffixed with its clause', () => {
  assert.equal(alsoFailsClause(finding({ requirement: '1.1' }), SHADOW, true), '5.1.3');
  assert.equal(alsoFailsClause(finding({ requirement: '4.3' }), SHADOW, true), '5.4.1');
});

test('§3.2 is never suffixed — the shadow validator re-runs it and files its own', () => {
  assert.equal(
    alsoFailsClause(finding({ requirement: '3.2', keyword: 'type' }), SHADOW, true),
    null,
  );
});

test('only a failure is suffixed, and only against a shadow lineage', () => {
  assert.equal(
    alsoFailsClause(finding({ requirement: '1.1', severity: 'pass' }), SHADOW, true),
    null,
  );
  assert.equal(
    alsoFailsClause(finding({ requirement: '1.1', severity: 'info' }), SHADOW, true),
    null,
  );
  assert.equal(alsoFailsClause(finding({ requirement: '1.1' }), null, true), null);
  assert.equal(
    alsoFailsClause(finding({ requirement: 'adv.null_padding', severity: 'info' }), SHADOW, true),
    null,
  );
});

test('a requirement outside the clause map gets no suffix', () => {
  assert.equal(alsoFailsClause(finding({ requirement: '9.9' }), SHADOW, true), null);
});

// ── 2. the two groups ──────────────────────────────────────────────────────

test('group 2 appears only when the shadow run failed on its own', () => {
  const clean = finding({
    requirement: '5.3.2',
    profile: SHADOW,
    severity: 'pass',
    detail: 'validated against DRAFT 1 (§5.3.2)',
  });
  const passing = groupDetailFindings([finding({ severity: 'pass' }), clean], SHADOW);
  assert.deepEqual(passing.shadow, []);

  const fail = missing(0, 'LSER');
  const failing = groupDetailFindings([clean, fail], SHADOW, {
    signatures: [signatureFor(fail, 'Missing required property LSER')],
  });
  assert.equal(failing.shadow.length, 1);
});

test('a contract failure that re-tags forward is not repeated as a shadow row', () => {
  const transport = finding({ requirement: '1.1', code: 'tx.missing_charset' });
  const groups = groupDetailFindings([transport, shadowRan()], SHADOW);
  assert.equal(groups.contract.length, 1);
  assert.equal(groups.contract[0]?.alsoFails, '5.1.3');
  assert.deepEqual(groups.shadow, []);
});

/**
 * THE SUFFIX GATES ON THE SHADOW HAVING RUN (by1c.41). A transport halt stops the
 * pipeline before the schema stage, so the shadow lineage files no finding and
 * this pane has no shadow run to point at.
 *
 * Since tfnv.3 the list row for such a transmission does read a DS01.3 fail —
 * `verdict()` consults forward-mapped contract failures before it answers null —
 * so the gate here is narrower than the verdict rule by design, and stays that
 * way until the grading lens replaces the suffix with one findings list per
 * lineage. See the docblock on `alsoFailsClause`.
 */
test('no shadow finding on the transmission means no suffix, whatever the clause map says', () => {
  const halted = finding({ requirement: '1.3', code: 'auth.missing_bearer' });
  assert.equal(alsoFailsClause(halted, SHADOW, false), null);
  const groups = groupDetailFindings([halted], SHADOW);
  assert.equal(groups.contract.length, 1);
  assert.equal(groups.contract[0]?.alsoFails, null);
});

test('a clean shadow run is a run: the re-tag suffix appears against its pass finding', () => {
  const halted = finding({ requirement: '1.3', code: 'auth.missing_bearer' });
  assert.equal(alsoFailsClause(halted, SHADOW, true), '5.1.5');
  const groups = groupDetailFindings([halted, shadowRan()], SHADOW);
  assert.equal(groups.contract[0]?.alsoFails, '5.1.5');
  assert.deepEqual(groups.shadow, []);
});

test('with no shadow lineage the groups are today’s split: every graded finding, no rows', () => {
  const findings = [
    finding({ requirement: '1.1', code: 'tx.missing_charset' }),
    finding({ requirement: '3.2', severity: 'pass' }),
    finding({ requirement: '3.4', severity: 'info', outdated: true }),
  ];
  const groups = groupDetailFindings(findings, null);
  assert.deepEqual(
    groups.contract.map((r) => r.finding),
    findings,
  );
  assert.deepEqual(
    groups.contract.map((r) => r.alsoFails),
    [null, null, null],
  );
  assert.deepEqual(groups.shadow, []);
});

test('a shadow finding never lands in the contract group', () => {
  const groups = groupDetailFindings([missing(0, 'LSER')], SHADOW);
  assert.deepEqual(groups.contract, []);
});

// ── 3. the required collapse ───────────────────────────────────────────────

test('required failures at one generalized path collapse to a single row', () => {
  const findings = [missing(0, 'LSER'), missing(0, 'LMOD'), missing(7, 'LSER')];
  const signatures = findings.map((f) => signatureFor(f, `Missing required property ${f.param}`));
  const { shadow } = groupDetailFindings(findings, SHADOW, { signatures });
  assert.equal(shadow.length, 1);
  assert.equal(shadowRowText(shadow[0]!), '5.3.2 schema — LSER, LMOD required');
});

test('required failures at two paths stay two rows', () => {
  const meta = finding({
    requirement: '5.3.3',
    profile: SHADOW,
    keyword: 'required',
    instancePath: '/meta',
    param: 'customDataSchema',
  });
  const findings = [missing(0, 'LSER'), meta];
  const signatures = findings.map((f) => signatureFor(f, `Missing required property ${f.param}`));
  const { shadow } = groupDetailFindings(findings, SHADOW, { signatures });
  assert.deepEqual(shadow.map(shadowRowText), [
    '5.3.2 schema — LSER required',
    '5.3.3 schema — customDataSchema required',
  ]);
});

test('a non-required shadow failure keeps its signature title and detail', () => {
  const f = finding({
    requirement: '5.3.2',
    profile: SHADOW,
    keyword: 'type',
    instancePath: '/data/0/TVC',
    detail: 'schema violation at /data/0/TVC: must be number (§5.3.2)',
  });
  const { shadow } = groupDetailFindings([f], SHADOW, {
    signatures: [signatureFor(f, 'TVC has the wrong type')],
  });
  assert.equal(
    shadowRowText(shadow[0]!),
    '5.3.2 TVC has the wrong type — schema violation at /data/0/TVC: must be number (§5.3.2)',
  );
  assert.equal(shadow[0]?.sig?.title, 'TVC has the wrong type');
});

test('a row with no matching signature falls back to the finding’s own detail', () => {
  const f = finding({
    requirement: '5.3.2',
    profile: SHADOW,
    keyword: 'enum',
    instancePath: '/meta/transferType',
    detail: 'schema violation at /meta/transferType: must be equal to one of the allowed values',
  });
  const { shadow } = groupDetailFindings([f], SHADOW, { signatures: [] });
  assert.equal(shadow[0]?.sig, null);
  assert.equal(
    shadowRowText(shadow[0]!),
    '5.3.2 schema violation at /meta/transferType: must be equal to one of the allowed values',
  );
});

// ── 4. the transferredAt phrasing ──────────────────────────────────────────

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
    profile: SHADOW,
    keyword: 'pattern',
    instancePath: '/meta/transferredAt',
    param: 'pattern',
    detail: 'schema violation at /meta/transferredAt: must match pattern (§5.3.3)',
  });
  const signatures = [signatureFor(f, 'transferredAt does not match the required pattern')];

  const phrased = groupDetailFindings([f], SHADOW, {
    signatures,
    body: { meta: { transferredAt: '2026-09-14T08:00:00+03:00' } },
  });
  assert.equal(shadowRowText(phrased.shadow[0]!), '5.3.3 transferredAt +03:00 → needs Z');

  const fallback = groupDetailFindings([f], SHADOW, { signatures, body: { meta: {} } });
  assert.equal(
    shadowRowText(fallback.shadow[0]!),
    '5.3.3 transferredAt does not match the required pattern — schema violation at /meta/transferredAt: must match pattern (§5.3.3)',
  );
});

test('both phrasings keep the signature key, so the row still cross-filters', () => {
  const f = finding({
    requirement: '5.3.3',
    profile: SHADOW,
    keyword: 'pattern',
    instancePath: '/meta/transferredAt',
    param: 'pattern',
  });
  const { shadow } = groupDetailFindings([f], SHADOW, {
    signatures: [signatureFor(f, 'transferredAt does not match the required pattern')],
    body: { meta: { transferredAt: '2026-09-14T08:00:00+03:00' } },
  });
  assert.equal(shadow[0]?.key, findingSignatureKey(f));
  assert.equal(shadow[0]?.sig?.key, findingSignatureKey(f));
});

// ── the group copy ─────────────────────────────────────────────────────────

test('the headings name the lineages from the vocabulary, never from a literal', () => {
  const copy = detailGroupCopy(SHADOW, 2);
  assert.equal(copy.contractHeading, `Findings · ${PROFILE_NAME[CONTRACT_PROFILE]}`);
  assert.equal(copy.shadowHeading, `Would also fail under ${PROFILE_NAME[SHADOW]}`);
});

test('an empty contract group says so on the header’s right', () => {
  assert.equal(detailGroupCopy(SHADOW, 0).contractNote, 'none — passes');
  assert.notEqual(detailGroupCopy(SHADOW, 1).contractNote, 'none — passes');
});

test('with no shadow lineage the eyebrow is the one it has always been', () => {
  const copy = detailGroupCopy(null, 0);
  assert.equal(copy.contractHeading, 'Findings · click § to open the requirement');
  assert.equal(copy.contractNote, null);
  assert.equal(copy.shadowHeading, null);
});

// ── 5. the row's pointer (by1c.40) ─────────────────────────────────────────

/**
 * A shadow row is clickable into the raw payload, the way every finding row is.
 * The collapsed row is the awkward one: it folds several records, so what it
 * SHOWS is the generalized path the fold buckets on and what it OPENS is the
 * first concrete path — a generalized path matches no line in the inspector.
 */
test('a collapsed row shows the generalized path and opens the first concrete one', () => {
  const findings = [missing(0, 'LSER'), missing(0, 'LMOD'), missing(7, 'LSER')];
  const signatures = findings.map((f) => signatureFor(f, `Missing required property ${f.param}`));
  const { shadow } = groupDetailFindings(findings, SHADOW, { signatures });
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0]?.pointer, '/data/*');
  assert.equal(shadow[0]?.locate, '/data/0');
});

test('a row that folds nothing shows and opens its own pointer', () => {
  const f = finding({
    requirement: '5.3.2',
    profile: SHADOW,
    keyword: 'type',
    instancePath: '/data/0/TVC',
    detail: 'schema violation at /data/0/TVC: must be number (§5.3.2)',
  });
  const { shadow } = groupDetailFindings([f], SHADOW, {
    signatures: [signatureFor(f, 'TVC has the wrong type')],
  });
  assert.equal(shadow[0]?.pointer, '/data/0/TVC');
  assert.equal(shadow[0]?.locate, '/data/0/TVC');
});

test('the pointer helper generalizes only for the collapse, and nulls the locate with no path', () => {
  const at = missing(3, 'LSER');
  assert.deepEqual(shadowRowPointer(at, true), { pointer: '/data/*', locate: '/data/3' });
  assert.deepEqual(shadowRowPointer(at, false), { pointer: '/data/3', locate: '/data/3' });
  const rootless = finding({ profile: SHADOW, instancePath: null, pointer: null });
  assert.deepEqual(shadowRowPointer(rootless, false), { pointer: null, locate: null });
});
