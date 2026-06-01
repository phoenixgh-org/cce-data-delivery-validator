/**
 * Stage-8 inventory check (§3.3 present-object inventory) unit tests (8ji.4).
 *
 * STAGE-UNIT only (node:test, no DB): drive `inventoryCheck` against a
 * hand-rolled {@link PipelineContext}, mirroring schema-stage.test.ts's harness.
 *
 * §3.3 is INFORMATIONAL: the check must emit exactly one `info` finding that
 * inventories the present DS01 object codes with counts, and must NEVER grade
 * (no pass/fail). Empty/missing data yields no finding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PipelineContext } from '../../pipeline.js';
import { inventoryCheck } from './inventory.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** Minimal SemanticDeps; inventoryCheck never reads them. */
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
    normalizedSchemaVersion: '0.8.0',
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: true,
    schemaOk: true,
  };
}

test('inventory: several object types across report + records → one 3.3 info finding listing counts', async () => {
  const payload = {
    meta: { schemaVersion: '0.8.0', transferType: 'rtm' },
    data: [
      {
        AMID: 'appliance-1',
        CID: 'US',
        EMFR: 'EMD_Name',
        records: [
          { ABST: '20200115T040554Z', ALRM: 'HEAT', TVC: 3.2, CMPR2: 1 },
          { ABST: '20200115T050554Z', BEMD: 14.3, TVC: 3.4 },
        ],
      },
      {
        AMID: 'appliance-2',
        CID: 'US',
        records: [{ ABST: '20200115T060554Z', EERR: 'none' }],
      },
    ],
  };

  const findings = await inventoryCheck(makeCtx(payload), deps);

  assert.equal(findings.length, 1, 'exactly one finding');
  const f = findings[0];
  assert.equal(f?.requirement, '3.3');
  assert.equal(f?.severity, 'info', 'always info, never grades');

  const detail = f?.detail ?? '';
  // Report-level codes counted per containing report.
  assert.match(detail, /AMID×2/, 'AMID present in both reports');
  assert.match(detail, /CID×2/);
  assert.match(detail, /EMFR×1/);
  // Record-level codes counted per containing record.
  assert.match(detail, /ABST×3/, 'ABST in all three records');
  assert.match(detail, /TVC×2/);
  assert.match(detail, /ALRM×1/);
  assert.match(detail, /BEMD×1/);
  assert.match(detail, /EERR×1/);
  assert.match(detail, /CMPR2×1/, 'digit-suffixed DS01 code recognized');
  // Structural `records` key excluded.
  assert.doesNotMatch(detail, /records×/, 'records is not a DS01 object type');
  // Honesty framing present.
  assert.match(detail, /self-attestation/i);
  assert.match(detail, /omitted/i);
});

test('inventory: detail is deterministic (alphabetical by code)', async () => {
  const payload = {
    data: [{ EMFR: 'x', AMID: 'a', CID: 'US', records: [{ TVC: 1, ABST: 't' }] }],
  };
  const findings = await inventoryCheck(makeCtx(payload), deps);
  const detail = findings[0]?.detail ?? '';
  const codes = detail
    .replace(/^present DS01 objects: /, '')
    .split('.')[0]!
    .split(', ')
    .map((s) => s.split('×')[0]!);
  const sorted = [...codes].sort();
  assert.deepEqual(codes, sorted, 'codes listed alphabetically');
});

test('inventory: finding is NEVER pass or fail', async () => {
  const payload = { data: [{ AMID: 'a', records: [{ ABST: 't' }] }] };
  const findings = await inventoryCheck(makeCtx(payload), deps);
  for (const f of findings) {
    assert.notEqual(f.severity, 'pass');
    assert.notEqual(f.severity, 'fail');
    assert.equal(f.severity, 'info');
  }
});

test('inventory: empty data array → no finding', async () => {
  const findings = await inventoryCheck(makeCtx({ meta: {}, data: [] }), deps);
  assert.equal(findings.length, 0);
});

test('inventory: missing data → no finding (graceful guard)', async () => {
  const findings = await inventoryCheck(makeCtx({ meta: {} }), deps);
  assert.equal(findings.length, 0);
});

test('inventory: data present but no DS01 codes → no finding', async () => {
  const findings = await inventoryCheck(makeCtx({ data: [{ records: [] }] }), deps);
  assert.equal(findings.length, 0);
});
