/**
 * PAYLOAD-domain exercise cases — the §3.x requirements graded from WHAT is in
 * the transmission body: schema conformance (§3.2) and manufacturer-specific data
 * objects (§3.1).
 *
 * OWNERSHIP: this file is the payload table (8qa.4). Transport cases live in
 * ./transport.ts and the sequence heuristics in ./sequence.ts; ../cases.ts is the
 * index that concatenates the three into `EXERCISE_CASES`.
 *
 * Grouping here is by REQUIREMENT DOMAIN, not by `fault.layer`: §3.4's cadence
 * cases also carry a payload-layer fault but belong to the sequence heuristics
 * (§1.8/§2.1/§3.4) and so live in ./sequence.ts.
 */

import type { ExerciseCase } from '../case.js';
import {
  addCustomDataObject,
  declareCustomDataSchema,
  dropRequiredField,
  setInvalidValue,
  setUnsupportedSchemaVersion,
} from '../transforms/payload.js';

export const PAYLOAD_CASES: readonly ExerciseCase[] = [
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
];
