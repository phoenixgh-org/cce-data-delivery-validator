/**
 * Stage-8 §3.1 conditional custom-data-schema check unit tests (5bs.1).
 *
 * STAGE-UNIT only (node:test, no DB): drive `customDataSchemaCheck` against a
 * hand-rolled {@link PipelineContext}, mirroring inventory.test.ts's harness.
 *
 * The matrix under test: custom objects present/absent × meta.customDataSchema
 * present/absent, over both payload shapes (RTMD report+records, EMS
 * report+records — custom objects may sit at either level), plus the
 * informational clause-4.5 naming signal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PipelineContext } from '../../pipeline.js';
import { customDataSchemaCheck, hasCustomDataSchema, scanDataObjects } from './custom-schema.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** Minimal SemanticDeps; this check never reads them. */
const deps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

/** A PipelineContext whose parse+schema stages already ran on `parsedBody`. */
function makeCtx(parsedBody: unknown): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'test-session',
    rawBody: Buffer.from(JSON.stringify(parsedBody)),
    registry: {} as PipelineContext['registry'],
    findings: [],
    parsedBody,
    meta: {},
    normalizedSchemaVersion: '0.8.1',
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: true,
    schemaOk: true,
  };
}

/**
 * An RTM payload in the ems-data-simulator shape (mirrors
 * `src/ingest/fixtures/transmissions.ts`). `meta` and the first report/record
 * are overlaid so a case can plant custom objects at either level.
 */
function rtmPayload(
  meta: Record<string, unknown> = {},
  report: Record<string, unknown> = {},
  record: Record<string, unknown> = {},
): unknown {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-1',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
      ...meta,
    },
    data: [
      {
        AMID: 'appliance-1',
        CID: 'US',
        EDOP: '2021-06-01',
        EMFR: 'EMD_Name',
        EMOD: 'EMD-ModelNo',
        EPQS: 'E006/999',
        ESER: 'EMD-SerialNum',
        DLST: { TVC: { SID: 'sensor-1' } },
        ...report,
        records: [
          { ABST: '20200115T040554Z', ALRM: 'HEAT', BEMD: 14.3, EERR: 'none', TVC: 3.2, ...record },
        ],
      },
    ],
  };
}

/** An EMS payload: report-level identity objects + EMS record objects. */
function emsPayload(
  meta: Record<string, unknown> = {},
  report: Record<string, unknown> = {},
  record: Record<string, unknown> = {},
): unknown {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-2',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
      ...meta,
    },
    data: [
      {
        CID: 'US',
        ADOP: '2021-06-01',
        AMFR: 'Appliance_Mfr',
        AMOD: 'Appliance-ModelNo',
        APQS: 'E003/999',
        ASER: 'Appliance-SerialNum',
        LDOP: '2021-06-01',
        LMFR: 'Logger_Mfr',
        LMOD: 'Logger-ModelNo',
        LPQS: 'E006/998',
        LSER: 'Logger-SerialNum',
        EDOP: '2021-06-01',
        EMFR: 'EMD_Name',
        EMOD: 'EMD-ModelNo',
        EPQS: 'E006/999',
        ESER: 'EMD-SerialNum',
        ...report,
        records: [
          {
            ABST: '20200115T040554Z',
            ALRM: 'HEAT',
            BEMD: 14.3,
            BLOG: 90,
            CMPR: 1,
            DORV: 0,
            EERR: 'none',
            LERR: 'none',
            TAMB: 22.1,
            TVC: 3.2,
            ...record,
          },
        ],
      },
    ],
  };
}

/** The single graded (pass/fail) §3.1 finding from a run. */
function grade(findings: readonly { requirement: string; severity: string }[]) {
  const graded = findings.filter((f) => f.severity === 'pass' || f.severity === 'fail');
  assert.equal(graded.length, 1, 'exactly one graded §3.1 finding');
  assert.equal(graded[0]?.requirement, '3.1');
  return graded[0]!;
}

// ── no custom objects ────────────────────────────────────────────────────────

test('3.1: clean RTM payload, no custom objects → pass, conditional did not apply', async () => {
  const findings = await customDataSchemaCheck(makeCtx(rtmPayload()), deps);
  assert.equal(findings.length, 1, 'no naming finding on a clean payload');
  const g = grade(findings);
  assert.equal(g.severity, 'pass');
  assert.match(findings[0]?.detail ?? '', /did not apply/i);
  assert.match(findings[0]?.detail ?? '', /§3\.2/, 'names the §3.2 division of labour');
});

test('3.1: clean EMS payload, no custom objects → pass', async () => {
  const findings = await customDataSchemaCheck(makeCtx(emsPayload()), deps);
  assert.equal(findings.length, 1);
  assert.equal(grade(findings).severity, 'pass');
});

test('3.1: no custom objects but customDataSchema declared anyway → still pass', async () => {
  const payload = rtmPayload({ customDataSchema: 'https://example.org/s.json' });
  const findings = await customDataSchemaCheck(makeCtx(payload), deps);
  assert.equal(grade(findings).severity, 'pass');
});

// ── custom objects present × customDataSchema absent → FAIL ──────────────────

test('3.1: record-level z-object without customDataSchema → fail', async () => {
  const payload = rtmPayload({}, {}, { ztpcm: 2.7 });
  const findings = await customDataSchemaCheck(makeCtx(payload), deps);
  const g = grade(findings);
  assert.equal(g.severity, 'fail');
  const f = findings.find((x) => x.severity === 'fail')!;
  assert.match(f.detail ?? '', /ztpcm/, 'names the offending object');
  assert.match(f.detail ?? '', /meta\.customDataSchema is missing/);
  assert.equal(f.pointer, '/meta/customDataSchema');
  assert.equal(f.code, 'tx.missing_custom_schema', 'carries the stable signature code');
});

test('3.1: report-level z-object without customDataSchema → fail (EMS shape)', async () => {
  const payload = emsPayload({}, { zplug: 'Type C' }, {});
  const findings = await customDataSchemaCheck(makeCtx(payload), deps);
  assert.equal(grade(findings).severity, 'fail');
  const f = findings.find((x) => x.severity === 'fail')!;
  assert.match(f.detail ?? '', /zplug/);
});

test('3.1: null / empty-string / empty-array customDataSchema counts as absent → fail', async () => {
  for (const value of [null, '', '   ', []]) {
    const payload = rtmPayload({ customDataSchema: value }, {}, { ztpcm: 2.7 });
    const findings = await customDataSchemaCheck(makeCtx(payload), deps);
    assert.equal(grade(findings).severity, 'fail', `value ${JSON.stringify(value)} ⇒ absent`);
  }
});

// ── custom objects present × customDataSchema present → PASS ─────────────────

test('3.1: z-object + by-reference customDataSchema URL → pass, no fetch claimed', async () => {
  const payload = rtmPayload(
    { customDataSchema: 'https://example.org/schema/rtm-custom-v01.json' },
    {},
    { ztpcm: 2.7 },
  );
  const findings = await customDataSchemaCheck(makeCtx(payload), deps);
  const g = grade(findings);
  assert.equal(g.severity, 'pass');
  const detail = findings.find((x) => x.severity === 'pass')!.detail ?? '';
  assert.match(detail, /ztpcm/);
  assert.match(detail, /never fetched/, 'says we do not fetch the referenced schema');
  assert.match(detail, /never validated against it/, 'says we do not validate against it');
});

test('3.1: z-object + inline customDataSchema object → pass', async () => {
  const payload = emsPayload(
    {
      customDataSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'urn:example-org:schemas:ems-custom:v01',
        $defs: { ztpcm: { type: 'number' } },
      },
    },
    {},
    { ztpcm: 2.7 },
  );
  assert.equal(grade(await customDataSchemaCheck(makeCtx(payload), deps)).severity, 'pass');
});

test('3.1: z-object + array of customDataSchema entries → pass', async () => {
  const payload = rtmPayload(
    { customDataSchema: ['https://a.example/one.json', 'https://b.example/two.json'] },
    {},
    { ztpcm: 2.7 },
  );
  assert.equal(grade(await customDataSchemaCheck(makeCtx(payload), deps)).severity, 'pass');
});

// ── clause-4.5 naming signal (informational) ─────────────────────────────────

test('3.1: badly-named custom object → counted as custom AND flagged informationally', async () => {
  const payload = rtmPayload({}, {}, { zTPCM: 2.7 });
  const findings = await customDataSchemaCheck(makeCtx(payload), deps);
  assert.equal(grade(findings).severity, 'fail', 'still drives the conditional');

  const info = findings.filter((f) => f.severity === 'info');
  assert.equal(info.length, 1, 'exactly one naming finding');
  assert.equal(info[0]?.requirement, '3.1');
  assert.match(info[0]?.detail ?? '', /zTPCM/);
  assert.match(info[0]?.detail ?? '', /clause 4\.5/);
  assert.equal(info[0]?.pointer, '/data/0/records/0/zTPCM', 'points at the first sighting');
});

test('3.1: naming flag never hardens into a fail on its own', async () => {
  // Mis-cased known code + unrecognized uppercase code: informational only.
  const payload = rtmPayload({}, {}, { tvc: 3.2, ZZZ9: 1 });
  const findings = await customDataSchemaCheck(makeCtx(payload), deps);
  assert.equal(grade(findings).severity, 'pass', 'neither signal is a custom object');
  const info = findings.filter((f) => f.severity === 'info');
  assert.equal(info.length, 1);
  assert.match(info[0]?.detail ?? '', /tvc/);
  assert.match(info[0]?.detail ?? '', /upper-case/);
  assert.match(info[0]?.detail ?? '', /ZZZ9/);
  assert.match(info[0]?.detail ?? '', /newer than our/);
});

test('3.1: conformant z-prefixed names raise no naming finding', async () => {
  const payload = rtmPayload(
    { customDataSchema: 'https://example.org/s.json' },
    { zplug: 'Type C' },
    { ztpcm: 2.7, z9: 1 },
  );
  const findings = await customDataSchemaCheck(makeCtx(payload), deps);
  assert.equal(findings.length, 1, 'only the graded finding');
  assert.equal(findings[0]?.severity, 'pass');
});

// ── detection-rule units ─────────────────────────────────────────────────────

test('scanDataObjects: classifies report- and record-level keys, skips `records`', () => {
  const scan = scanDataObjects({
    data: [
      { AMID: 'a', zplug: 'Type C', records: [{ ABST: 't', ztpcm: 1, customTemp: 2, Tamb: 3 }] },
    ],
  });
  assert.deepEqual(
    scan.custom.map((s) => s.key).sort(),
    ['zplug', 'ztpcm'],
    'z-prefixed at both levels',
  );
  assert.deepEqual(
    scan.misnamed.map((s) => s.key),
    ['customTemp'],
  );
  assert.deepEqual(
    scan.miscased.map((s) => s.key),
    ['Tamb'],
  );
  assert.deepEqual(scan.unknownCode, [], 'AMID and ABST are known DS01 codes');
  assert.equal(scan.custom[0]?.pointer, '/data/0/zplug');
  assert.equal(scan.custom[1]?.pointer, '/data/0/records/0/ztpcm');
});

test('scanDataObjects: tolerates a missing/!array data, non-object entries', () => {
  for (const body of [undefined, null, {}, { data: null }, { data: 'x' }, { data: [1, 'a'] }]) {
    const scan = scanDataObjects(body);
    assert.deepEqual(scan.custom, []);
    assert.deepEqual(scan.misnamed, []);
  }
  const scan = scanDataObjects({ data: [{ records: 'not-an-array', zx: 1 }] });
  assert.deepEqual(
    scan.custom.map((s) => s.key),
    ['zx'],
  );
});

test('scanDataObjects: a repeated custom key is reported once, at its first sighting', () => {
  const scan = scanDataObjects({
    data: [{ records: [{ ztpcm: 1 }, { ztpcm: 2 }] }, { records: [{ ztpcm: 3 }] }],
  });
  assert.equal(scan.custom.length, 1);
  assert.equal(scan.custom[0]?.pointer, '/data/0/records/0/ztpcm');
});

test('hasCustomDataSchema: string / object / array forms vs the empty forms', () => {
  assert.equal(hasCustomDataSchema({ meta: { customDataSchema: 'https://x/y.json' } }), true);
  assert.equal(hasCustomDataSchema({ meta: { customDataSchema: { $id: 'urn:x' } } }), true);
  assert.equal(hasCustomDataSchema({ meta: { customDataSchema: ['https://x/y.json'] } }), true);
  assert.equal(
    hasCustomDataSchema({ meta: { customDataSchema: { $defs: { ztpcm: {} } } } }),
    true,
    'an inline schema without $id still declares something (0.8.1 never carried the field)',
  );
  assert.equal(
    hasCustomDataSchema({ meta: { customDataSchema: [{}, { $id: 'urn:x' }] } }),
    true,
    'one good array entry is enough',
  );
  assert.equal(hasCustomDataSchema({ meta: { customDataSchema: '' } }), false);
  assert.equal(hasCustomDataSchema({ meta: { customDataSchema: [] } }), false);
  assert.equal(hasCustomDataSchema({ meta: { customDataSchema: null } }), false);
  assert.equal(hasCustomDataSchema({ meta: {} }), false);
  assert.equal(hasCustomDataSchema({}), false);
  assert.equal(hasCustomDataSchema(null), false);
});

test('hasCustomDataSchema: values that name no schema are ABSENT, not present (squ)', () => {
  // Each of these once returned true — {} because isPlainObject({}) is, and the
  // array forms because only length was checked, never the items. A payload
  // carrying undeclared custom objects then got a §3.1 PASS: a false pass in a
  // conformance grader.
  for (const value of [{}, [''], ['   '], [{}], [null], { $id: '' }, [{ $id: '' }], 0, false]) {
    assert.equal(
      hasCustomDataSchema({ meta: { customDataSchema: value } }),
      false,
      `${JSON.stringify(value)} names no schema`,
    );
  }
});

test('3.1: custom objects present with an empty declaration ({}) still FAILs (squ)', async () => {
  const payload = rtmPayload({ customDataSchema: {} }, {}, { ztpcm: 2.7 });
  const findings = await customDataSchemaCheck(makeCtx(payload), deps);
  assert.equal(grade(findings).severity, 'fail');
  const f = findings.find((x) => x.severity === 'fail')!;
  assert.equal(f.code, 'tx.missing_custom_schema');
  assert.match(f.detail ?? '', /names no schema/);
});

// ── orchestration ────────────────────────────────────────────────────────────

test('3.1: the graded finding is emitted on every parse+schema-valid body', async () => {
  // Even a degenerate (empty data) body gets a §3.1 grade, so the §7 matrix row
  // reports from real traffic instead of sitting at `untested` forever.
  const findings = await customDataSchemaCheck(makeCtx({ meta: {}, data: [] }), deps);
  assert.equal(grade(findings).severity, 'pass');
});
