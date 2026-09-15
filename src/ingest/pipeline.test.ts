/**
 * Pipeline framework unit tests (no DB). Exercises the runner's ordering,
 * short-circuit-vs-continue semantics, and finding accumulation in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTINUE,
  DEFAULT_SUCCESS_STATUS,
  SYNTHETIC_DATA_NOTICE,
  buildResponseBody,
  halt,
  record,
  runPipeline,
  type PipelineContext,
  type Stage,
} from './pipeline.js';
import { advisory } from './stages/semantic/advisory.js';
import { CONTRACT_PROFILE, SchemaRegistry, type Profile } from '../schema-registry.js';

/** A bare context sufficient for runner tests (stages here ignore most fields). */
function fakeCtx(): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'test',
    rawBody: Buffer.alloc(0),
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
    primaryProfile: null,
    shadowProfile: null,
    contentType: null,
    contentEncoding: null,
    parseOk: null,
    schemaOk: null,
  };
}

test('runner continues through all stages → default success status', async () => {
  const order: string[] = [];
  const mk = (name: string): Stage => ({
    name,
    run() {
      order.push(name);
      return CONTINUE;
    },
  });
  const ctx = fakeCtx();
  const result = await runPipeline(ctx, [mk('a'), mk('b'), mk('c')]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(result.status, DEFAULT_SUCCESS_STATUS);
  assert.equal(result.haltedAt, null);
});

test('runner stops at the first halt and reports its status + stage name', async () => {
  const order: string[] = [];
  const mk = (name: string, out = CONTINUE): Stage => ({
    name,
    run() {
      order.push(name);
      return out;
    },
  });
  const ctx = fakeCtx();
  const result = await runPipeline(ctx, [mk('a'), mk('b', halt(413)), mk('c')]);
  assert.deepEqual(order, ['a', 'b'], 'c must not run after b halts');
  assert.equal(result.status, 413);
  assert.equal(result.haltedAt, 'b');
});

test('findings accumulate on ctx, including from the halting stage', async () => {
  const ctx = fakeCtx();
  const continuer: Stage = {
    name: 'note',
    run(c) {
      return record(c, { requirement: '1.2', severity: 'info', detail: 'observed' });
    },
  };
  const halter: Stage = {
    name: 'cap',
    run(c) {
      c.findings.push({ requirement: '1.4', severity: 'fail', detail: 'too big' });
      return halt(413);
    },
  };
  const result = await runPipeline(ctx, [continuer, halter]);
  assert.equal(result.findings.length, 2);
  assert.equal(ctx.findings.length, 2);
  assert.equal(result.status, 413);
});

test('buildResponseBody echoes id, status, count, and per-finding details (teaching surface)', () => {
  const findings = [
    { requirement: '1.4', severity: 'pass', detail: 'wire body is 12 bytes, within the 1MB cap' },
    { requirement: '3.3', severity: 'info', detail: 'present DS01 objects: AMID×1' },
  ] as const;
  const body = buildResponseBody(200, findings, 'tx-1');

  assert.equal(body.transmissionId, 'tx-1');
  assert.equal(body.status, 200);
  assert.equal(body.findings, 2, 'count is preserved from the original shape');
  // Per-finding echo carries requirement/severity/profile/detail (no internal
  // pointer). A finding written with no profile echoes the contract lineage, the
  // same default `insertFindings` applies on the way into the database.
  assert.deepEqual(body.findingDetails, [
    {
      requirement: '1.4',
      severity: 'pass',
      profile: '2025',
      detail: 'wire body is 12 bytes, within the 1MB cap',
    },
    {
      requirement: '3.3',
      severity: 'info',
      profile: '2025',
      detail: 'present DS01 objects: AMID×1',
    },
  ]);
});

test('buildResponseBody: advisories are carried in their own field, out of the tally (7rv)', () => {
  // An advisory never moves a requirement's status (DESIGN §7.1), so it must not
  // move the one number the response reports as the outcome either — the same
  // exclusion the dashboard's verdict cell makes (`findingsCell`). It is carried
  // rather than dropped: this body is the only surface some integrators read.
  const body = buildResponseBody(
    200,
    [
      { requirement: '1.2', severity: 'pass' },
      advisory({ id: 'adv.null_padding', detail: 'TCON was null in all 480 records' }),
    ],
    'tx-adv',
  );

  assert.equal(body.findings, 1, 'graded findings only');
  assert.deepEqual(
    body.findingDetails.map((f) => f.requirement),
    ['1.2'],
  );
  assert.deepEqual(body.advisories, [
    {
      requirement: 'adv.null_padding',
      severity: 'info',
      profile: '2025',
      detail: 'TCON was null in all 480 records',
    },
  ]);
  // The tally is what a lone graded pass would have produced, plus a separate
  // sentence for the advisory — never "2 findings (1 info)".
  assert.match(body.message, /^Accepted \(200\): data recorded; 1 finding\./);
  assert.match(body.message, /1 advisory, not graded and not counted above\.$/);
});

test('buildResponseBody: advisories alone leave a zero tally and no info count (7rv)', () => {
  const body = buildResponseBody(
    200,
    [advisory({ id: 'adv.date_format', detail: 'd' })],
    'tx-adv2',
  );

  assert.equal(body.findings, 0);
  assert.deepEqual(body.findingDetails, []);
  assert.equal(body.advisories.length, 1);
  assert.match(body.message, /^Accepted \(200\): data recorded; 0 findings\. /);
  assert.doesNotMatch(body.message, /info/, 'an advisory is never counted as an info finding');
});

test('buildResponseBody carries the synthetic-data-only notice on accepted AND rejected bodies', () => {
  // dkz.1 — the sandbox constraint has to reach an integrator who never opens
  // the dashboard, so it rides every response, not just the 2xx path.
  assert.equal(buildResponseBody(200, [], 'tx-2').notice, SYNTHETIC_DATA_NOTICE);
  assert.equal(buildResponseBody(422, [], 'tx-2').notice, SYNTHETIC_DATA_NOTICE);
  assert.match(SYNTHETIC_DATA_NOTICE, /Synthetic test data only/);
});

test('buildResponseBody message: accepted 2xx leads with "Accepted" and the tally', () => {
  const body = buildResponseBody(
    200,
    [
      { requirement: '1.2', severity: 'pass' },
      { requirement: '3.3', severity: 'info' },
    ],
    'tx-1',
  );
  assert.match(body.message, /^Accepted \(200\)/);
  assert.match(body.message, /2 findings/);
  assert.match(body.message, /1 info/, 'breaks down the info count');
});

test('buildResponseBody message: short-circuit leads with "Rejected (NNN)" + fail count', () => {
  const body = buildResponseBody(
    422,
    [
      { requirement: '1.1', severity: 'pass' },
      { requirement: '3.2', severity: 'fail', detail: 'schema violation at (root): is invalid' },
    ],
    'tx-2',
  );
  assert.match(body.message, /^Rejected \(422\)/);
  assert.match(body.message, /2 findings/);
  assert.match(body.message, /1 fail/, 'surfaces the fail count');
});

test('buildResponseBody: no-row pre-body halt (404) → null id, empty details, singular wording', () => {
  const body = buildResponseBody(404, [], null);
  assert.equal(body.transmissionId, null);
  assert.equal(body.status, 404);
  assert.equal(body.findings, 0);
  assert.deepEqual(body.findingDetails, []);
  assert.deepEqual(body.advisories, []);
  assert.match(body.message, /Rejected \(404\): 0 findings\./);
});

test('buildResponseBody: a single finding uses singular "finding"', () => {
  const body = buildResponseBody(200, [{ requirement: '1.2', severity: 'pass' }], 'tx-3');
  assert.match(body.message, /1 finding\./);
  assert.doesNotMatch(body.message, /1 findings/);
});

test('runPipeline result feeds buildResponseBody end-to-end (no DB)', async () => {
  const stage: Stage = {
    name: 'fail-stage',
    run(c) {
      c.findings.push({ requirement: '1.6', severity: 'fail', detail: 'undecodable' });
      return halt(400);
    },
  };
  const ctx = fakeCtx();
  const result = await runPipeline(ctx, [stage]);
  const body = buildResponseBody(result.status, result.findings, 'tx-4');

  assert.equal(body.status, 400);
  assert.equal(body.findings, 1);
  assert.equal(body.findingDetails[0]?.detail, 'undecodable');
  assert.match(body.message, /^Rejected \(400\): 1 finding \(1 fail\)\./);
});

// ── the lineage named on the wire (by1c.27) ─────────────────────────────────
//
// A supplier whose payload conforms to the contract still sees the shadow run's
// failures echoed in `findingDetails` under an HTTP 200. Two things say so:
// every entry carries the `profile` that graded it, and `message` gains a
// trailing sentence naming the shadow lineage by its draft date and hash. Both
// read off the registry entry, so neither restates a fact that could drift.

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

/** The pipeline context's two shadow-bearing fields, as the route passes them. */
function lineages(shadowProfile: Profile | null) {
  return { registry, shadowProfile };
}

/** The current entry of one lineage, for building the expected sentence. */
function entryOf(profile: Profile) {
  return registry.get(registry.currentVersion(profile)!)!;
}

test('buildResponseBody: every echoed finding names the lineage that graded it (by1c.27)', () => {
  const body = buildResponseBody(
    200,
    [
      // A transport finding carries no profile; it echoes the contract lineage.
      { requirement: '1.4', severity: 'pass' },
      { requirement: '3.2', severity: 'pass', profile: '2025' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013', detail: "must have 'LSER'" },
      advisory({ id: 'adv.date_format', detail: 'd' }),
    ],
    'tx-profile',
    lineages('ds013'),
  );

  assert.deepEqual(
    body.findingDetails.map((f) => `${f.profile}|${f.requirement}`),
    ['2025|1.4', '2025|3.2', 'ds013|5.3.2'],
    'both lineages are echoed, each naming itself',
  );
  assert.equal(body.advisories[0]?.profile, '2025', 'an advisory names its lineage too');
  assert.equal(body.findings, 2, 'the count stays contract-only');
});

test('an unstamped finding resolves to the contract lineage through CONTRACT_PROFILE (by1c.31)', () => {
  // Only the schema stage stamps a profile, so every transport and semantic
  // finding arrives without one. The expectations below are written against the
  // CONSTANT, not against the string it holds today: the point of the fix is
  // that the echoed lineage and the contract tally both follow the flip point,
  // and a test spelling out '2025' would still pass on the day they stop doing
  // so (bd by1c.31).
  const body = buildResponseBody(
    200,
    [{ requirement: '1.4', severity: 'pass' }, advisory({ id: 'adv.date_format', detail: 'd' })],
    'tx-unstamped',
    lineages('ds013'),
  );

  assert.equal(body.findingDetails[0]?.profile, CONTRACT_PROFILE, 'echoed as the contract lineage');
  assert.equal(body.advisories[0]?.profile, CONTRACT_PROFILE, 'an advisory too');
  assert.equal(body.findings, 1, 'and counted as a contract finding, not dropped');
});

test('message: shadow fails echoed → a trailing sentence with the count, date and hash', () => {
  const entry = entryOf('ds013');
  const shadowFails = [1, 2, 3, 4, 5].map(() => ({
    requirement: '5.3.2',
    severity: 'fail' as const,
    profile: 'ds013' as const,
  }));
  const body = buildResponseBody(
    200,
    [{ requirement: '3.2', severity: 'pass', profile: '2025' }, ...shadowFails],
    'tx-shadow',
    lineages('ds013'),
  );

  // The draft date and the full 64-hex hash come from the entry, never from a
  // literal — the same provenance form the §3.2 pass detail uses.
  assert.equal(
    body.message,
    'Accepted (200): data recorded; 1 finding. ' +
      `5 further findings under the DS01.3 draft of ${entry.draftDate} ` +
      `(sha256 ${entry.sha256}) did not affect this status.`,
  );
  assert.equal(body.findings, 1, 'the shadow findings move no count');
});

test('message: a clean shadow run says so — "Also passes the DS01.3 draft…"', () => {
  const entry = entryOf('ds013');
  const body = buildResponseBody(
    200,
    [
      { requirement: '3.2', severity: 'pass', profile: '2025' },
      { requirement: '5.3.2', severity: 'pass', profile: 'ds013' },
    ],
    'tx-clean',
    lineages('ds013'),
  );

  assert.equal(
    body.message,
    'Accepted (200): data recorded; 1 finding. ' +
      `Also passes the DS01.3 draft of ${entry.draftDate} (sha256 ${entry.sha256}).`,
  );
});

test('message: no sentence at all when no shadow run happened', () => {
  // `shadowProfile` stays null on an unresolved version, an unparseable body and
  // every pre-body transport halt — there is no second lineage to report on.
  const findings = [{ requirement: '3.2', severity: 'fail' as const, detail: 'unsupported' }];
  for (const [label, body] of [
    ['shadowProfile null', buildResponseBody(422, findings, 'tx-a', lineages(null))],
    ['no lineage source at all', buildResponseBody(422, findings, 'tx-b')],
  ] as const) {
    assert.equal(body.message, 'Rejected (422): 1 finding (1 fail).', label);
    assert.doesNotMatch(body.message, /draft|sha256|further/, label);
  }
});

test('message: the sentence follows ctx.shadowProfile, so the roles can swap', () => {
  // A payload declaring the Annex 4 revision is graded PRIMARY under ds013, and
  // the 2025 lineage becomes its shadow. Nothing in the sentence is written as a
  // literal, so it names that lineage — and describes a published schema as a
  // schema rather than as a draft.
  //
  // The name is the shared vocabulary's short form, "2025" (bd by1c.32). The
  // sentence said "cce-interop" while pipeline.ts kept its own map, which is the
  // fuller name the dashboard's provenance line still uses; the two surfaces now
  // read the same vocabulary, and a mid-sentence mention takes the short form on
  // both. No message the service sends today changes — the shadow lineage is
  // ds013, and it is named "DS01.3" either way.
  const entry = entryOf('2025');
  const body = buildResponseBody(
    200,
    [
      // Transport findings carry no profile. They must not be counted into the
      // shadow tally just because the contract lineage is the shadow today.
      { requirement: '1.4', severity: 'pass' },
      { requirement: '1.1', severity: 'pass' },
      { requirement: '5.3.2', severity: 'pass', profile: 'ds013' },
      { requirement: '3.2', severity: 'pass', profile: '2025' },
    ],
    'tx-swapped',
    lineages('2025'),
  );

  assert.equal(
    body.message,
    'Accepted (200): data recorded; 3 findings. ' +
      `Also passes the 2025 ${entry.version} schema (sha256 ${entry.sha256}).`,
  );
  assert.doesNotMatch(body.message, /DS01\.3/, 'the shadow today is the cce-interop lineage');
  assert.doesNotMatch(body.message, /draft/, 'published bytes are not called a draft');
});

test('message: the shadow sentence comes last, after the advisory sentence', () => {
  const body = buildResponseBody(
    200,
    [
      { requirement: '3.2', severity: 'pass', profile: '2025' },
      { requirement: '5.3.2', severity: 'fail', profile: 'ds013' },
      advisory({ id: 'adv.date_format', detail: 'd' }),
    ],
    'tx-both',
    lineages('ds013'),
  );

  assert.match(body.message, /^Accepted \(200\): data recorded; 1 finding\./);
  assert.match(body.message, /1 advisory, not graded and not counted above\. 1 further finding /);
  assert.match(body.message, /did not affect this status\.$/);
});
