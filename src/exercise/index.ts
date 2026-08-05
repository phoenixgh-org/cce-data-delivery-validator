/**
 * The conformance exercise suite's pure core (epic 8qa, bite 8qa.1).
 *
 * Case model + transform vocabulary + pluggable baseline, with NO network code:
 * everything here is a pure function over data, so the same definitions can be
 * unit-tested in CI (../exercise/case.test.ts, ../exercise/cases.test.ts) and
 * replayed against a live instance by the runner (8qa.2) without either half
 * being able to drift from the other.
 */

export {
  BASELINE_GENERATORS,
  DEFAULT_BASELINE,
  emsBaseline,
  fixtureBaseline,
  type BaselineGenerator,
  type BaselineRequest,
  type TransmissionPayload,
} from './baseline.js';
export {
  caseRequirements,
  isAcceptedStatus,
  materializeCase,
  materializePost,
  payloadTypeOf,
  requiresAuthEnabled,
  resolveBaseline,
  type CaseSetup,
  type Direction,
  type ExerciseCase,
  type ExercisePost,
  type ExerciseTransform,
  type ExpectedFinding,
  type Fault,
  type FaultLayer,
  type MaterializedPost,
  type MaterializeOptions,
} from './case.js';
export { EXERCISE_CASES, PAYLOAD_CASES, SEQUENCE_CASES, TRANSPORT_CASES } from './cases.js';
export * from './transforms/payload.js';
export * from './transforms/transport.js';
