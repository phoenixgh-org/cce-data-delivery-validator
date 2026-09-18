/**
 * The browser's clause translation must equal the server's (by1c.14, tfnv.7).
 *
 * src/web/clauseMap.ts hand-copies six tables and one rule out of src/api —
 * `FORWARD`, `TIGHTENED`, `NEW_IN_DS013` and `DS013_TITLE` from clause-map.ts,
 * `RE_RUN_UNDER_SHADOW` from verdicts.ts, `CUSTOM_SCHEMA_CODES` from the
 * custom-object check, and the fold rule from lens.ts. Each server module has its
 * own test joining it against `docs/clause-mapping.md` or the §7 matrix, so what
 * THIS file protects is the COPY: a rule changed on the server and not here would
 * renumber, hide or double-count a finding in the docked detail — silently, and
 * with nothing for a supplier to notice.
 *
 * The last two are pinned for a different reason (tfnv.6). Nothing in the browser
 * reads them yet — the compliance card's NEW tag asks the served row, and a row's
 * words are its served `summary` — so no rendering regression would catch a drift
 * in them. The equality below is the whole of their protection, and it is what
 * makes them safe to reach for later.
 *
 * The rule is pinned against the server's OWN FOLD rather than against a
 * transcription of it: every fixture finding is run through `foldUnderLens` and
 * the row it lands on is compared with what the mirror answers. `rowFor` is not
 * exported, and a fold of one finding is exactly it.
 *
 * Importing server modules from a web test is the Setup.test.ts pattern; web
 * tests are excluded from `typecheck:web`, so nothing here reaches the bundle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DS013_TITLE as SERVER_DS013_TITLE,
  FORWARD as SERVER_FORWARD,
  NEW_IN_DS013 as SERVER_NEW_IN_DS013,
  TIGHTENED as SERVER_TIGHTENED,
  forwardClause as serverForwardClause,
} from '../api/clause-map.js';
import {
  clauseUnderLens as serverContractClause,
  foldUnderLens,
  type LensFinding,
} from '../api/lens.js';
import { RE_RUN_UNDER_SHADOW as SERVER_RE_RUN } from '../api/verdicts.js';
import { DS013_MATRIX } from '../api/matrix-ds013.js';
import { CUSTOM_SCHEMA_CODES as SERVER_CUSTOM_CODES } from '../ingest/stages/semantic/custom-schema.js';
import { CONTRACT_PROFILE } from './api.js';
import {
  CUSTOM_SCHEMA_CODES,
  DS013_TITLE,
  FORWARD,
  NEW_IN_DS013,
  RE_RUN_UNDER_SHADOW,
  TIGHTENED,
  clauseUnderLens,
  failCountUnderLens,
  forwardClause,
  tightenedUnderLens,
} from './clauseMap.js';

const DRAFT = 'ds013';

test('the mirrored FORWARD map is the server map, row for row', () => {
  assert.deepEqual(FORWARD, SERVER_FORWARD);
});

test('forwardClause answers as the server does, including for ids off the map', () => {
  for (const req of Object.keys(SERVER_FORWARD)) {
    assert.equal(forwardClause(req), serverForwardClause(req), req);
  }
  for (const req of ['adv.null_padding', '9.9', '', 'toString']) {
    assert.equal(forwardClause(req), serverForwardClause(req), req);
    assert.equal(forwardClause(req), null, req);
  }
});

test('the re-run, tightened and custom-code tables are the server’s', () => {
  assert.deepEqual([...RE_RUN_UNDER_SHADOW].sort(), [...SERVER_RE_RUN].sort());
  assert.deepEqual([...TIGHTENED].sort(), [...SERVER_TIGHTENED].sort());
  assert.deepEqual(CUSTOM_SCHEMA_CODES, { ...SERVER_CUSTOM_CODES });
});

test('the added-clause list and the clause titles are the server’s (tfnv.6)', () => {
  // Order is part of the copy for NEW_IN_DS013: the server keeps it in DS01.3
  // document order, and a surface listing the added clauses would show that order.
  assert.deepEqual(NEW_IN_DS013, [...SERVER_NEW_IN_DS013]);
  assert.deepEqual(DS013_TITLE, { ...SERVER_DS013_TITLE });
});

/**
 * The two mirrored tables also have to agree with the MATRIX the lens serves,
 * which is the thing a future consumer would be rendering beside them. Both joins
 * are the server's own (matrix-ds013.test.ts makes them there too); repeating
 * them on the mirror is what says the copy is usable, not merely identical.
 */
test('the mirrored tables cover the DS01.3 matrix: every clause titled, the added ones listed', () => {
  const added = DS013_MATRIX.filter((row) => row.members.length === 0).map((row) => row.clause);
  assert.deepEqual([...added].sort(), [...NEW_IN_DS013].sort());
  for (const row of DS013_MATRIX) {
    assert.equal(typeof DS013_TITLE[row.clause], 'string', row.clause);
  }
});

/**
 * THE TRANSLATION IS THE SERVER'S FOLD (tfnv.7).
 *
 * The fixtures below cover every branch of the rule — a contract finding the map
 * carries forward, the §3.2 exception, the §3.1 split on the custom-object codes,
 * a DS01.3-numbered finding, an advisory id, an id off the map — under both
 * lenses. The expectation is computed by the server, never written here, so the
 * pin cannot drift into agreeing with a stale copy of the rule.
 */
const FIXTURES: LensFinding[] = [
  { requirement: '1.1', severity: 'fail', profile: CONTRACT_PROFILE, outdated: false },
  { requirement: '1.4', severity: 'fail', profile: CONTRACT_PROFILE, outdated: false },
  { requirement: '1.8', severity: 'pass', profile: CONTRACT_PROFILE, outdated: false },
  // §3.2 — re-run by the Annex 4 validator, so it translates to nothing.
  { requirement: '3.2', severity: 'fail', profile: CONTRACT_PROFILE, outdated: false },
  { requirement: '3.2', severity: 'info', profile: CONTRACT_PROFILE, outdated: true },
  // §3.1 — 5.3.3 in general, 5.3.5 when it is the custom-object half.
  { requirement: '3.1', severity: 'fail', profile: CONTRACT_PROFILE, outdated: false },
  {
    requirement: '3.1',
    severity: 'fail',
    profile: CONTRACT_PROFILE,
    outdated: false,
    code: SERVER_CUSTOM_CODES.fail,
  },
  {
    requirement: '3.1',
    severity: 'pass',
    profile: CONTRACT_PROFILE,
    outdated: false,
    code: SERVER_CUSTOM_CODES.pass,
  },
  { requirement: '4.3', severity: 'fail', profile: CONTRACT_PROFILE, outdated: false },
  { requirement: '5.3', severity: 'fail', profile: CONTRACT_PROFILE, outdated: false },
  // Findings already numbered in DS01.3 — their own clause, either way.
  { requirement: '5.3.2', severity: 'fail', profile: DRAFT, outdated: false },
  { requirement: '5.3.3', severity: 'fail', profile: DRAFT, outdated: false },
  { requirement: '5.3.2', severity: 'pass', profile: DRAFT, outdated: false },
  // Off the map: an advisory id and a requirement that does not exist.
  { requirement: 'adv.null_padding', severity: 'info', profile: CONTRACT_PROFILE, outdated: false },
  { requirement: '9.9', severity: 'fail', profile: CONTRACT_PROFILE, outdated: false },
];

/** The row the server's fold puts one finding on, or null when it counts it nowhere. */
function serverRow(f: LensFinding, lens: 'ds013' | typeof CONTRACT_PROFILE): string | null {
  const { counts } = foldUnderLens([f], lens, CONTRACT_PROFILE);
  return Object.keys(counts)[0] ?? null;
}

test('clauseUnderLens lands every fixture where the server’s fold lands it', () => {
  for (const lens of [CONTRACT_PROFILE, DRAFT] as const) {
    for (const f of FIXTURES) {
      assert.equal(
        clauseUnderLens(f, lens, CONTRACT_PROFILE),
        serverRow(f, lens),
        `${f.profile} §${f.requirement}${f.code ? ` (${f.code})` : ''} under ${lens}`,
      );
    }
  }
});

test('the contract-finding half matches the server function it mirrors', () => {
  for (const f of FIXTURES) {
    if (f.profile !== CONTRACT_PROFILE) continue;
    assert.equal(
      clauseUnderLens(f, DRAFT, CONTRACT_PROFILE),
      serverContractClause(f.requirement, f.code),
      `§${f.requirement}`,
    );
  }
});

test('under the contract lens the translation is the identity, and hides the other package', () => {
  assert.equal(
    clauseUnderLens(
      { requirement: '3.2', profile: CONTRACT_PROFILE },
      CONTRACT_PROFILE,
      CONTRACT_PROFILE,
    ),
    '3.2',
  );
  assert.equal(
    clauseUnderLens({ requirement: '5.3.2', profile: DRAFT }, CONTRACT_PROFILE, CONTRACT_PROFILE),
    null,
  );
});

/**
 * THE TIGHTENED CLAUSES ARE DERIVED (tfnv.7). The four are `TIGHTENED` carried
 * through the forward map, so re-pointing a row in `FORWARD` moves the tag with
 * it. The pin states the four so a change has to be deliberate, and joins them
 * against the matrix the server serves — the DS01.3 rows that carry
 * `tightened: true` are exactly these.
 */
test('tightenedUnderLens answers for the four DS01.3 clauses the draft tightened', () => {
  const tightened = DS013_MATRIX.filter((row) => row.tightened).map((row) => row.clause);
  assert.deepEqual([...tightened].sort(), ['5.1.10', '5.3.2', '5.3.3', '5.4.1']);
  for (const clause of tightened) assert.equal(tightenedUnderLens(clause), true, clause);
  for (const clause of ['5.1.3', '5.1.6', '5.3.4', '5.4.4', '5.3.5', '1.8', '']) {
    assert.equal(tightenedUnderLens(clause), false, clause);
  }
});

/**
 * THE ROW'S FAIL COUNT UNDER THE LENS (tfnv.7) — what the `{n}f` cell and the
 * verdict tooltip count. Three claims, one per package boundary it crosses.
 */
test('the fail count follows the lens: §3.2 drops out, 5.3.2 joins, transport stays', () => {
  const findings = [
    { requirement: '1.4', severity: 'fail', profile: CONTRACT_PROFILE, code: 'tx.too_large' },
    { requirement: '3.2', severity: 'fail', profile: CONTRACT_PROFILE, code: null },
    { requirement: '5.3.2', severity: 'fail', profile: DRAFT, code: null },
    { requirement: '5.3.2', severity: 'pass', profile: DRAFT, code: null },
  ];
  // Under the contract package: the two contract failures, neither DS01.3 one.
  assert.equal(failCountUnderLens(findings, CONTRACT_PROFILE, CONTRACT_PROFILE), 2);
  // Under the draft: §1.4 carried forward to 5.1.6 plus the DS01.3 failure;
  // §3.2 is re-run by Annex 4 and its 2025 result is not the draft's to report.
  assert.equal(failCountUnderLens(findings, DRAFT, CONTRACT_PROFILE), 2);
});

test('advisories never join the fail count, under either lens', () => {
  const findings = [
    {
      requirement: 'adv.null_padding',
      severity: 'fail',
      profile: CONTRACT_PROFILE,
      code: 'adv.null_padding',
    },
    { requirement: '1.1', severity: 'pass', profile: CONTRACT_PROFILE, code: null },
  ];
  assert.equal(failCountUnderLens(findings, CONTRACT_PROFILE, CONTRACT_PROFILE), 0);
  assert.equal(failCountUnderLens(findings, DRAFT, CONTRACT_PROFILE), 0);
});

test('the count is findings, not rows: five omissions at one path count five', () => {
  const missing = { requirement: '5.3.2', severity: 'fail', profile: DRAFT };
  const findings = [missing, missing, missing, missing, missing];
  assert.equal(failCountUnderLens(findings, DRAFT, CONTRACT_PROFILE), 5);
});
