/**
 * REPRESENTATIVE exercise cases (8qa.1).
 *
 * This is NOT the full per-requirement case table — that is the work of 8qa.3
 * (transport: 1.1, 1.2, 1.3, 1.4, 1.6), 8qa.4 (payload: 3.1, 3.2) and 8qa.5
 * (sequence heuristics: 1.8, 2.1, 3.4). What lives here is a small set chosen to
 * exercise every part of the MODEL — both directions, both transform families,
 * a multi-POST sequence case, a case graded by status alone, and each of the
 * three schema outcomes — so the model and its CI tests are proven before the
 * tables are written against them.
 *
 * Deliberately absent, because they need runner-side setup that does not exist
 * yet (8qa.2): §1.3 auth cases (the session must first opt in and hand the
 * runner a credential) and §2.1 concurrency (two POSTs must genuinely overlap,
 * which an ordered list cannot express). The transform vocabulary for both is
 * already in place — see `bearerCredential`/`noAuth`/`badAuth`.
 */

import type { ExerciseCase } from './case.js';
import {
  addCustomDataObject,
  declareCustomDataSchema,
  dropRequiredField,
  irregularCadence,
  regularCadence,
  setInvalidValue,
  setTransferId,
  setUnsupportedSchemaVersion,
} from './transforms/payload.js';
import {
  contentType,
  doubleGzip,
  gzip,
  method,
  oversize,
  unparseableBody,
} from './transforms/transport.js';

export const EXERCISE_CASES: readonly ExerciseCase[] = [
  // ── §3.2 schema validation ────────────────────────────────────────────────
  {
    id: '3.2-pass-baseline',
    title: 'The untouched baseline validates against the current schema',
    requirements: ['3.2'],
    direction: 'pass',
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.2', severity: 'pass' }],
  },
  {
    id: '3.2-fail-missing-required-field',
    title: 'A data report missing the required AMID is rejected 422',
    requirements: ['3.2'],
    direction: 'fail',
    fault: { layer: 'payload', note: 'AMID removed from the lone data report' },
    posts: [{ transforms: [dropRequiredField('/data/0/AMID')], expectedStatus: 422 }],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },
  {
    id: '3.2-fail-out-of-enum-transfer-type',
    title: 'A transferType outside the schema enum is rejected 422',
    requirements: ['3.2'],
    direction: 'fail',
    fault: { layer: 'payload', note: 'meta.transferType set to a value outside the rtm/ems enum' },
    posts: [
      { transforms: [setInvalidValue('/meta/transferType', 'thermometer')], expectedStatus: 422 },
    ],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },
  {
    id: '3.2-fail-unsupported-schema-version',
    title: 'A schemaVersion the registry does not carry is rejected 422 before Ajv runs',
    requirements: ['3.2'],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note: 'meta.schemaVersion names 0.7.0, which the registry does not carry',
    },
    posts: [{ transforms: [setUnsupportedSchemaVersion('0.7.0')], expectedStatus: 422 }],
    expectedFindings: [{ requirement: '3.2', severity: 'fail' }],
  },

  // ── §3.1 manufacturer-specific data objects ───────────────────────────────
  {
    id: '3.1-pass-declared-custom-object',
    title: 'A custom data object declared via meta.customDataSchema passes §3.1',
    requirements: ['3.1'],
    direction: 'pass',
    posts: [
      {
        transforms: [
          addCustomDataObject('ztpcm', 4.2),
          declareCustomDataSchema('https://example.invalid/schemas/ztpcm-1.0.0.json'),
        ],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [{ requirement: '3.1', severity: 'pass' }],
  },
  {
    id: '3.1-fail-undeclared-custom-object',
    title: 'A custom data object with no meta.customDataSchema fails §3.1 (still 200)',
    requirements: ['3.1'],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note: 'zTPCM added to a record with no meta.customDataSchema declaration',
    },
    posts: [{ transforms: [addCustomDataObject('zTPCM', 4.2)], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.1', severity: 'fail' }],
  },

  // ── §3.4 reading cadence ──────────────────────────────────────────────────
  {
    id: '3.4-pass-regular-cadence',
    title: 'An evenly spaced reading series passes the §3.4 regularity heuristic',
    requirements: ['3.4'],
    direction: 'pass',
    posts: [{ transforms: [regularCadence(4, 15)], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.4', severity: 'pass' }],
  },
  {
    id: '3.4-fail-irregular-cadence',
    title: 'A wildly uneven reading series fails the §3.4 regularity heuristic (still 200)',
    requirements: ['3.4'],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note: 'readings at 0/5/6/120 minutes — an interval CV far past the 25% tolerance',
    },
    posts: [{ transforms: [irregularCadence([0, 5, 6, 120])], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.4', severity: 'fail' }],
  },

  // ── §1.8 duplicate detection (the multi-POST shape) ───────────────────────
  {
    id: '1.8-fail-repeated-transfer-id',
    title: 'A second POST re-using the first POST’s transferId is observed as a §1.8 duplicate',
    requirements: ['1.8'],
    direction: 'fail',
    fault: {
      layer: 'sequence',
      note: 'the second POST re-uses the first POST’s transferId within the same session',
    },
    posts: [
      {
        label: 'novel',
        transforms: [setTransferId('exercise-1.8-replay')],
        expectedStatus: 200,
      },
      {
        label: 'replay',
        transforms: [setTransferId('exercise-1.8-replay')],
        expectedStatus: 200,
      },
    ],
    // The session shows BOTH: the first POST is novel, the second is the repeat.
    expectedFindings: [
      { requirement: '1.8', severity: 'pass' },
      { requirement: '1.8', severity: 'fail' },
    ],
  },

  // ── transport-level cases ─────────────────────────────────────────────────
  {
    id: '1.1-fail-wrong-method',
    title: 'A PUT to the ingest path is refused 405 with no transmission recorded',
    requirements: ['1.1'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'PUT instead of POST' },
    posts: [{ transforms: [method('PUT')], expectedStatus: 405 }],
    // Graded by STATUS alone: a 405 halts before persistence, so no finding is
    // written. A case may legitimately expect no findings at all.
    expectedFindings: [],
  },
  {
    id: '1.1-fail-unparseable-body',
    title: 'A body that is not JSON is rejected 400 with a §1.1 fail',
    requirements: ['1.1'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'body bytes truncated to malformed JSON' },
    posts: [{ transforms: [unparseableBody()], expectedStatus: 400 }],
    expectedFindings: [{ requirement: '1.1', severity: 'fail' }],
  },
  {
    id: '1.2-fail-content-type',
    title: 'text/plain earns a §1.2 fail without short-circuiting the pipeline',
    requirements: ['1.2'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'Content-Type: text/plain instead of application/json' },
    // 415 is optional per §6, so the run continues and still reaches 200.
    posts: [{ transforms: [contentType('text/plain')], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: '1.2', severity: 'fail' },
      { requirement: '3.2', severity: 'pass' },
    ],
  },
  {
    id: '1.4-fail-oversize-body',
    title: 'A body one byte over the 1MB cap is rejected 413',
    requirements: ['1.4'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'body padded to 1MB + 1 byte' },
    posts: [{ transforms: [oversize()], expectedStatus: 413 }],
    expectedFindings: [{ requirement: '1.4', severity: 'fail' }],
  },
  {
    id: '1.6-pass-gzip',
    title: 'A single gzip layer declared via Content-Encoding decodes cleanly',
    requirements: ['1.6'],
    direction: 'pass',
    posts: [{ transforms: [gzip()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '1.6', severity: 'pass' }],
  },
  {
    id: '1.6-fail-double-gzip',
    title: 'A gzip member that decompresses to another gzip member is rejected 400',
    requirements: ['1.6'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'gzip-of-gzip under a single Content-Encoding: gzip' },
    posts: [{ transforms: [doubleGzip()], expectedStatus: 400 }],
    expectedFindings: [{ requirement: '1.6', severity: 'fail' }],
  },
];
