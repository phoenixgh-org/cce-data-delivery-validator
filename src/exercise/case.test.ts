/**
 * Unit tests for the exercise core: materialization, the pluggable baseline, and
 * the two transform families (8qa.1).
 *
 * ./cases.test.ts checks the CASE TABLE against the real schema; this file
 * checks the MACHINERY the table is written in — that transforms produce the
 * payload and wire request they claim, and that the baseline is genuinely
 * swappable without touching a case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import { JSON_UTF8, validTransmission } from '../ingest/fixtures/transmissions.js';
import { SchemaRegistry } from '../schema-registry.js';
import {
  BASELINE_GENERATORS,
  emsBaseline,
  fixtureBaseline,
  type BaselineGenerator,
  type TransmissionPayload,
} from './baseline.js';
import { materializeCase, materializePost, type ExerciseCase } from './case.js';
import { deleteAtPointer, setAtPointer } from './pointer.js';
import {
  addCustomDataObject,
  declareCustomDataSchema,
  dropRequiredField,
  irregularCadence,
  regularCadence,
  setSchemaVersion,
  setTransferId,
  setUnsupportedSchemaVersion,
} from './transforms/payload.js';
import {
  badAuth,
  bearerCredential,
  contentType,
  customHeader,
  doubleGzip,
  gzip,
  method,
  noAuth,
  oversize,
  unparseableBody,
  unsupportedEncoding,
} from './transforms/transport.js';

const registry = SchemaRegistry.load();

/** Build a throwaway single-POST case around `transforms`. */
function caseWith(transforms: ExerciseCase['posts'][number]['transforms']): ExerciseCase {
  return {
    id: 'unit-under-test',
    title: 'ad-hoc case for a unit test',
    requirements: ['3.2'],
    direction: 'pass',
    posts: [{ transforms, expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
  };
}

/** Materialize a single-POST ad-hoc case. */
function only(transforms: ExerciseCase['posts'][number]['transforms']) {
  return materializePost(caseWith(transforms), 0);
}

// ── baseline ────────────────────────────────────────────────────────────────

test('the fixture baseline reproduces the valid ingest fixture but for its transferId', () => {
  const payload = fixtureBaseline({ caseId: 'x', index: 0 });
  const fixture = JSON.parse(JSON.stringify(validTransmission)) as typeof payload;
  assert.notEqual(payload.meta.transferId, fixture.meta.transferId);
  payload.meta.transferId = fixture.meta.transferId;
  assert.deepEqual(payload, fixture, 'nothing but the transferId differs from the fixture');
});

test('the fixture baseline derives a distinct transferId per case and POST', () => {
  // The §1.8 duplicate check is session-scoped and the runner plays the whole
  // table against ONE session, so two POSTs that are not deliberate replays must
  // never arrive carrying the same transferId (5xi).
  assert.equal(fixtureBaseline({ caseId: 'alpha', index: 0 }).meta.transferId, 'alpha#0');
  assert.equal(fixtureBaseline({ caseId: 'alpha', index: 1 }).meta.transferId, 'alpha#1');
  assert.equal(fixtureBaseline({ caseId: 'beta', index: 0 }).meta.transferId, 'beta#0');
});

test('the fixture baseline hands out an independent copy each call', () => {
  const first = fixtureBaseline({ caseId: 'x', index: 0 });
  first.meta.transferSrc = 'mutated';
  const second = fixtureBaseline({ caseId: 'x', index: 0 });
  assert.equal(second.meta.transferSrc, 'com.example', 'the second call is unaffected');
});

test('the baseline generator is swappable without touching the case', () => {
  const seen: { caseId: string; index: number }[] = [];
  const custom: BaselineGenerator = (request) => {
    seen.push({ caseId: request.caseId, index: request.index });
    const payload = fixtureBaseline(request);
    payload.meta.transferSrc = `com.example.generator.${request.index}`;
    return payload;
  };

  const kase: ExerciseCase = {
    ...caseWith([setTransferId('pinned')]),
    posts: [
      { transforms: [setTransferId('pinned')], expectedStatus: 200 },
      { transforms: [setTransferId('pinned')], expectedStatus: 200 },
    ],
  };
  const posts = materializeCase(kase, { baseline: custom });

  assert.deepEqual(seen, [
    { caseId: 'unit-under-test', index: 0 },
    { caseId: 'unit-under-test', index: 1 },
  ]);
  assert.equal(posts[0]?.payload.meta.transferSrc, 'com.example.generator.0');
  assert.equal(posts[1]?.payload.meta.transferSrc, 'com.example.generator.1');
  // The case's own transform still applies on top of whatever the generator made.
  assert.equal(posts[0]?.payload.meta.transferId, 'pinned');
  assert.equal(posts[1]?.payload.meta.transferId, 'pinned');
});

// ── the generator CONTRACT, asserted over every registered generator ────────
//
// One test per clause of the contract documented on `BaselineGenerator`, each
// looping over `BASELINE_GENERATORS` rather than naming a generator (b8r). The
// failure b8r describes is a generator added LATER — e.g. one seeded from
// ../ems-data-simulator output, which would naturally carry a constant
// transferId and so reintroduce 5xi in full — and no test written against
// today's two generators can catch that. Registering the new generator is what
// enrolls it here.

/** Sample requests spanning two cases and two POST ordinals within each. */
const CONTRACT_REQUESTS = [
  { caseId: 'alpha', index: 0 },
  { caseId: 'alpha', index: 1 },
  { caseId: 'beta', index: 0 },
  { caseId: 'beta', index: 1 },
] as const;

/** Every registered generator as `[exportName, generator]`, for a loop body. */
const REGISTERED = Object.entries(BASELINE_GENERATORS);

test('every registered generator is a distinct function and the list is not empty', () => {
  assert.ok(REGISTERED.length > 0, 'BASELINE_GENERATORS carries at least one generator');
  const fns = REGISTERED.map(([, generate]) => generate);
  assert.equal(new Set(fns).size, fns.length, 'a generator is registered under two names');
  assert.ok(
    fns.includes(fixtureBaseline) && fns.includes(emsBaseline),
    'both shipped generators are registered — an unregistered one is an unchecked one',
  );
});

test('contract 1: every registered generator produces a schema-VALID payload', () => {
  // The real registry and the real Ajv build for the version the payload itself
  // names — the same mechanism ../cases.test.ts uses on the case table. A
  // baseline that does not validate makes every case built on it meaningless,
  // since a case is "the conformant payload, minus one thing".
  for (const [name, generate] of REGISTERED) {
    for (const request of CONTRACT_REQUESTS) {
      const payload: TransmissionPayload = generate(request);
      const version = payload.meta.schemaVersion;
      assert.equal(typeof version, 'string', `${name}: the payload must name a schemaVersion`);
      const lookup = registry.lookup(version as string);
      assert.ok(lookup.ok, `${name}: schemaVersion ${String(version)} is not registered`);
      const valid = lookup.entry.validate(payload);
      const errors = lookup.entry.validate.errors ?? [];
      assert.equal(
        valid,
        true,
        `${name}: baseline for ${request.caseId}#${request.index} is not schema-valid against ` +
          `${String(version)}: ` +
          errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`).join('; '),
      );
    }
  }
});

test('contract 2: every registered generator hands out a fresh, fully owned payload', () => {
  // Transforms mutate what they are given, so two POSTs must never share
  // structure — a shared record array would let one case's mutant leak into the
  // next case's payload.
  for (const [name, generate] of REGISTERED) {
    const request = CONTRACT_REQUESTS[0];
    const first = generate(request);
    first.meta.transferSrc = 'com.example.mutated';
    (first.data[0] as Record<string, unknown>).CID = 'ZZ';
    const second = generate(request);
    assert.notEqual(second.meta.transferSrc, 'com.example.mutated', `${name}: meta is shared`);
    assert.notEqual(
      (second.data[0] as Record<string, unknown>).CID,
      'ZZ',
      `${name}: data is shared`,
    );
  }
});

test('contract 3: every registered generator gives each (caseId, index) a distinct transferId', () => {
  // The obligation b8r asks for, stated on the type and enforced here. §1.8 is
  // session-scoped and the runner plays the whole table against ONE session, so
  // a generator that repeats an id makes unrelated cases — pass-direction ones
  // included — record a §1.8 fail from table ordering alone (5xi).
  for (const [name, generate] of REGISTERED) {
    const ids = CONTRACT_REQUESTS.map((request) => {
      const id = generate(request).meta.transferId;
      assert.equal(typeof id, 'string', `${name}: the payload must carry a string transferId`);
      return id as string;
    });
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${name}: distinct (caseId, index) requests produced a repeated transferId (${ids.join(', ')})`,
    );
  }
});

test('contract 3, across generators: two generators never claim the same transferId', () => {
  // The runner plays one session; if the table ever mixes generators, an id
  // collision BETWEEN them is the same §1.8 poisoning as a collision within one.
  // Case ids are unique table-wide (../cases.test.ts), so per-(caseId, index)
  // ids collide across generators only if a generator ignores the request.
  const seen = new Map<string, string>();
  for (const [name, generate] of REGISTERED) {
    for (const request of CONTRACT_REQUESTS) {
      const id = generate(request).meta.transferId as string;
      const key = `${id}@${request.caseId}#${request.index}`;
      // Same request, different generator: the id SHOULD match — that is the
      // shared scheme. The collision that matters is one id for two requests.
      const prior = seen.get(id);
      assert.ok(
        prior === undefined || prior === key,
        `${name}: transferId "${id}" is already claimed by ${String(prior)}`,
      );
      seen.set(id, key);
    }
  }
});

// ── the EMS baseline specifically ───────────────────────────────────────────

test('the EMS baseline takes the schema ems branch, not the rtmd one', () => {
  const payload = emsBaseline({ caseId: 'x', index: 0 });
  assert.equal(payload.meta.transferType, 'ems');
  const report = payload.data[0] as Record<string, unknown>;
  const records = report.records as Record<string, unknown>[];
  // Report-level LSV/EMSV, and NOT in the records: the ems-report `oneOf` offers
  // one placement XOR the other, so satisfying both would fail validation.
  assert.equal(typeof report.LSV, 'string');
  assert.equal(typeof report.EMSV, 'string');
  for (const record of records) {
    assert.equal(record.LSV, undefined, 'LSV is at report level only');
    assert.equal(record.EMSV, undefined, 'EMSV is at report level only');
    // Mains branch of the power `oneOf`, and the numeric branch of the TVC one.
    assert.equal(typeof record.SVA, 'number');
    assert.equal(record.DCSV, undefined, 'a mains record carries no solar objects');
    assert.equal(record.DCCD, undefined, 'a mains record carries no solar objects');
    assert.equal(typeof record.TVC, 'number');
  }
});

test('the EMS baseline is validated by ems-record, not waved through', () => {
  // A tripwire, not a case (the EMS case group is its own bite): prove the ems
  // branch is genuinely the one Ajv selected, by breaking a constraint that
  // exists ONLY there. Adding the solar objects to a record that already has SVA
  // matches both branches of the power `oneOf` — which a `oneOf` rejects — and
  // has no analogue in rtmd-record. If this ever passes validation, the payload
  // is being graded against something other than ems-record.
  const payload = emsBaseline({ caseId: 'x', index: 0 });
  const record = (payload.data[0] as { records: Record<string, unknown>[] }).records[0]!;
  record.DCSV = 19.2;
  record.DCCD = 3.8;
  const lookup = registry.lookup(payload.meta.schemaVersion as string);
  assert.ok(lookup.ok);
  assert.equal(
    lookup.entry.validate(payload),
    false,
    'SVA together with DCSV+DCCD matches both branches of the ems-record power oneOf',
  );
});

// ── materialization ─────────────────────────────────────────────────────────

test('an untransformed POST is the baseline, serialized, as a canonical POST', () => {
  const post = only(undefined);
  assert.equal(post.request.method, 'POST');
  assert.equal(post.request.headers['content-type'], JSON_UTF8);
  assert.deepEqual(JSON.parse(post.request.body.toString('utf8')), post.payload);
  assert.equal(post.schemaOutcome, 'valid');
  assert.deepEqual(post.appliedTransforms, []);
});

test('payload mutators run before transport wrappers whatever order a case lists them in', () => {
  const post = only([gzip(), setTransferId('ordered')]);
  assert.deepEqual(post.appliedTransforms, ['setTransferId(ordered)', 'gzip()']);
  // The gzip layer wraps the ALREADY mutated payload — proof of the ordering.
  const decoded = JSON.parse(gunzipSync(post.request.body).toString('utf8')) as {
    meta: { transferId: string };
  };
  assert.equal(decoded.meta.transferId, 'ordered');
});

test('materializing a case twice yields independent payloads', () => {
  const kase = caseWith([setTransferId('a')]);
  const first = materializePost(kase, 0);
  first.payload.meta.transferId = 'clobbered';
  const second = materializePost(kase, 0);
  assert.equal(second.payload.meta.transferId, 'a', 'the second materialization is unaffected');
});

test('the derived schema outcome combines the applied mutators', () => {
  assert.equal(only([setTransferId('x')]).schemaOutcome, 'valid');
  assert.equal(only([setUnsupportedSchemaVersion('0.7.0')]).schemaOutcome, 'unsupported-version');
  assert.equal(only([dropRequiredField('/data/0/AMID')]).schemaOutcome, 'invalid');
  // `invalid` dominates: Ajv rejects the body however the version resolved.
  assert.equal(
    only([setUnsupportedSchemaVersion('0.7.0'), dropRequiredField('/data/0/AMID')]).schemaOutcome,
    'invalid',
  );
});

test('materializePost rejects an index the case does not have', () => {
  assert.throws(() => materializePost(caseWith(undefined), 3), /no POST at index 3/);
});

// ── payload transforms ──────────────────────────────────────────────────────

test('setSchemaVersion names a version the registry really carries', () => {
  // The transform is declared benign, which is only true of a REGISTERED
  // version; assert that against the live registry rather than trusting it.
  const current = registry.currentVersion();
  assert.ok(current);
  const post = only([setSchemaVersion(current)]);
  assert.equal(post.schemaOutcome, 'valid');
  const lookup = registry.lookup(post.payload.meta.schemaVersion as string);
  assert.ok(lookup.ok, 'the declared version resolves');
  assert.equal(lookup.entry.validate(post.payload), true, 'and the payload still validates');
});

test('dropRequiredField throws on a field that is not there to drop', () => {
  assert.throws(() => only([dropRequiredField('/data/0/NOPE')]), /nothing to delete/);
});

test('addCustomDataObject + declareCustomDataSchema land where §3.1 looks for them', () => {
  const post = only([
    addCustomDataObject('ztpcm', 4.2),
    declareCustomDataSchema('https://example.invalid/schemas/ztpcm-1.0.0.json'),
  ]);
  const record = post.payload.data[0]?.records as Record<string, unknown>[];
  assert.equal(record[0]?.ztpcm, 4.2);
  assert.equal(
    post.payload.meta.customDataSchema,
    'https://example.invalid/schemas/ztpcm-1.0.0.json',
  );
});

test('regularCadence and irregularCadence restamp ABST from the first record', () => {
  const regular = only([regularCadence(4, 15)]);
  const stamps = (regular.payload.data[0]?.records as { ABST: string }[]).map((r) => r.ABST);
  assert.deepEqual(stamps, [
    '20200115T040554Z',
    '20200115T042054Z',
    '20200115T043554Z',
    '20200115T045054Z',
  ]);

  const irregular = only([irregularCadence([0, 5, 6, 120])]);
  const uneven = (irregular.payload.data[0]?.records as { ABST: string }[]).map((r) => r.ABST);
  assert.deepEqual(uneven, [
    '20200115T040554Z',
    '20200115T041054Z',
    '20200115T041154Z',
    '20200115T060554Z',
  ]);
  // Everything but the timestamp is cloned from the baseline record, so the
  // series stays schema-valid — §3.4 is a heuristic, not a schema violation.
  const first = (irregular.payload.data[0]?.records as { TVC: number }[])[0];
  assert.equal(first?.TVC, 3.2);
});

// ── transport transforms ────────────────────────────────────────────────────

test('method() swaps the verb and leaves the body alone', () => {
  const post = only([method('PUT')]);
  assert.equal(post.request.method, 'PUT');
  assert.deepEqual(JSON.parse(post.request.body.toString('utf8')), post.payload);
});

test('contentType() and customHeader() rewrite headers', () => {
  const post = only([contentType('text/plain'), customHeader('X-Supplier-Trace', 'abc123')]);
  assert.equal(post.request.headers['content-type'], 'text/plain');
  assert.equal(post.request.headers['x-supplier-trace'], 'abc123');
});

test('oversize() replaces the body with one byte past the 1MB cap', () => {
  const post = only([oversize()]);
  assert.equal(post.request.body.length, 1_048_577);
});

test('unparseableBody() replaces the body with bytes that never parse', () => {
  const post = only([unparseableBody()]);
  assert.throws(() => JSON.parse(post.request.body.toString('utf8')));
});

test('gzip() declares a single decodable layer; doubleGzip() nests two', () => {
  const single = only([gzip()]);
  assert.equal(single.request.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(single.request.body).toString('utf8')), single.payload);

  const nested = only([doubleGzip()]);
  assert.equal(nested.request.headers['content-encoding'], 'gzip');
  const once = gunzipSync(nested.request.body);
  assert.equal(once[0], 0x1f, 'the first layer decodes to another gzip member');
  assert.equal(once[1], 0x8b);
  assert.deepEqual(JSON.parse(gunzipSync(once).toString('utf8')), nested.payload);
});

test('unsupportedEncoding() declares an encoding we never decode', () => {
  const post = only([unsupportedEncoding('br')]);
  assert.equal(post.request.headers['content-encoding'], 'br');
});

test('the §1.3 credential wrappers set, clear and corrupt the Authorization header', () => {
  const authorized = materializePost(caseWith([bearerCredential()]), 0, {
    transport: { credential: 's3cret' },
  });
  assert.equal(authorized.request.headers.authorization, 'Bearer s3cret');

  const stripped = materializePost(caseWith([bearerCredential(), noAuth()]), 0, {
    transport: { credential: 's3cret' },
  });
  assert.equal(stripped.request.headers.authorization, undefined);

  const wrong = only([badAuth('wrong')]);
  assert.equal(wrong.request.headers.authorization, 'Bearer wrong');
});

test('bearerCredential() fails loudly when the runner supplied no credential', () => {
  assert.throws(() => only([bearerCredential()]), /no credential supplied/);
});

// ── pointer helpers ─────────────────────────────────────────────────────────

test('pointer writes address objects and array members', () => {
  const doc = { meta: { a: 1 }, data: [{ records: [{ TVC: 1 }] }] };
  setAtPointer(doc, '/data/0/records/0/TVC', 9);
  assert.equal(doc.data[0]?.records[0]?.TVC, 9);
  setAtPointer(doc, '/meta/b', 2);
  assert.deepEqual(doc.meta, { a: 1, b: 2 });
  deleteAtPointer(doc, '/meta/a');
  assert.deepEqual(doc.meta, { b: 2 });
});

test('pointer writes throw rather than silently miss', () => {
  const doc = { meta: {}, data: [{}] };
  assert.throws(() => setAtPointer(doc, 'meta/x', 1), /must be '' or start with/);
  assert.throws(() => setAtPointer(doc, '/data/7/x', 1), /past the end/);
  assert.throws(() => setAtPointer(doc, '/data/first/x', 1), /is not an array index/);
  assert.throws(() => deleteAtPointer(doc, '/meta/missing'), /nothing to delete/);
  assert.throws(() => setAtPointer(doc, '', 1), /not the whole document/);
});
