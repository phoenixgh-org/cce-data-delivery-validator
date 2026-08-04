/**
 * The exercise CASE model (8qa.1; epic 8qa design notes).
 *
 * A case is DATA, not code. It declares what it targets and what should happen;
 * it never contains the logic that makes it happen. That is what lets the same
 * definitions serve two consumers that must never drift apart: the live-instance
 * runner (8qa.2), which POSTs the case to a deployed validator, and the
 * colocated unit tests, which run its payloads through the vendored schema in CI
 * where no server exists.
 *
 * Each case declares:
 *   - the requirement id(s) it targets, matching COMPLIANCE_MATRIX ids so
 *     coverage is a mechanical join rather than a stale annotation;
 *   - a direction, `pass` or `fail`;
 *   - an ORDERED list of one or more POSTs, each built by applying named
 *     transforms to the pluggable baseline;
 *   - the expected HTTP status per POST;
 *   - the expected findings (requirement + severity) the session should show.
 *
 * A multi-POST case is how the sequence-dependent heuristics (§1.8 duplicates,
 * §2.1 serial delivery, §3.4 cadence across transmissions) get exercised without
 * a second mechanism — a single-POST case is just a list of one.
 */

import type { Severity } from '../db/repository.js';
import { toBytes } from '../ingest/fixtures/transmissions.js';
import { DEFAULT_BASELINE, type BaselineGenerator, type TransmissionPayload } from './baseline.js';
import type { PayloadTransform, SchemaOutcome } from './transforms/payload.js';
import {
  baseRequest,
  type TransportContext,
  type TransportTransform,
  type WireRequest,
} from './transforms/transport.js';

/** Either transform family. Cases list them together; materialization sorts them. */
export type ExerciseTransform = PayloadTransform | TransportTransform;

/**
 * Which way a case is pointed: `pass` means a conformant supplier's traffic —
 * the validator should accept it and grade the targeted requirement green;
 * `fail` means deliberately defective traffic the validator must catch.
 */
export type Direction = 'pass' | 'fail';

/** One finding the exercised session should show. */
export interface ExpectedFinding {
  /** COMPLIANCE_MATRIX requirement id, e.g. '3.2'. */
  readonly requirement: string;
  readonly severity: Severity;
}

/**
 * Where a fail-direction case's defect is injected. Declared rather than
 * derived: a transform is not intrinsically a defect (adding a custom data
 * object is a §3.1 FAIL undeclared and a §3.1 PASS declared), and a sequence
 * defect belongs to no single transform at all.
 */
export type FaultLayer = 'payload' | 'transport' | 'sequence';

/** The defect a fail-direction case injects, and where. */
export interface Fault {
  readonly layer: FaultLayer;
  /** One line naming the defect, e.g. 'AMID removed from the lone data report'. */
  readonly note: string;
}

/** One POST within a case. */
export interface ExercisePost {
  /** Short label distinguishing this POST within a multi-POST case. */
  readonly label?: string;
  /** Transforms applied to the baseline, in order, within each family. */
  readonly transforms?: readonly ExerciseTransform[];
  /** The HTTP status this POST should come back with (DESIGN §6). */
  readonly expectedStatus: number;
}

/** One exercise case. */
export interface ExerciseCase {
  /** Stable slug, e.g. '3.2-fail-missing-required-field'. Unique across the table. */
  readonly id: string;
  /** One-line human description, printed by the runner's summary. */
  readonly title: string;
  /** COMPLIANCE_MATRIX requirement ids this case exercises. */
  readonly requirements: readonly string[];
  readonly direction: Direction;
  /** REQUIRED when direction is `fail`; must be absent when it is `pass`. */
  readonly fault?: Fault;
  /** One or more POSTs, played in order against the same session. */
  readonly posts: readonly ExercisePost[];
  /** Findings the session should show once every POST has been played. */
  readonly expectedFindings: readonly ExpectedFinding[];
}

/** A POST resolved into the exact payload + wire request to send. */
export interface MaterializedPost {
  /** 0-based ordinal within the case. */
  readonly index: number;
  /** `label` if the case gave one, else `#<index>`. */
  readonly label: string;
  /** The payload after every payload mutator ran, before serialization. */
  readonly payload: TransmissionPayload;
  /**
   * The request after every transport wrapper ran — what the runner sends. Note
   * `request.body` is NOT always the serialization of `payload`: wrappers such
   * as `oversize()` and `unparseableBody()` replace the body outright, which is
   * how the §6 halts that never reach the parse/schema stages are exercised.
   */
  readonly request: WireRequest;
  readonly expectedStatus: number;
  /**
   * What the payload should do at the §6 schema stage, derived from the applied
   * payload mutators: `invalid` if any breaks validation, else
   * `unsupported-version` if any names an unregistered version, else `valid`.
   * This is the property the CI tests check against real Ajv.
   */
  readonly schemaOutcome: SchemaOutcome;
  /** Names of every transform applied, in application order. */
  readonly appliedTransforms: readonly string[];
}

/** Options for {@link materializeCase}. */
export interface MaterializeOptions {
  /** Baseline generator; defaults to the fixture-seeded one (../baseline.ts). */
  readonly baseline?: BaselineGenerator;
  /** Runtime facts transport wrappers may need (today: the §1.3 credential). */
  readonly transport?: TransportContext;
}

function isPayloadTransform(t: ExerciseTransform): t is PayloadTransform {
  return t.kind === 'payload';
}

/**
 * Combine the applied mutators' declared schema outcomes. `invalid` dominates
 * (Ajv rejects the body however the version resolved); `unsupported-version`
 * beats `valid` (stage 7 halts before validating).
 */
function combineSchemaOutcomes(transforms: readonly PayloadTransform[]): SchemaOutcome {
  if (transforms.some((t) => t.schemaOutcome === 'invalid')) return 'invalid';
  if (transforms.some((t) => t.schemaOutcome === 'unsupported-version')) {
    return 'unsupported-version';
  }
  return 'valid';
}

/**
 * Resolve one POST: generate a fresh baseline, apply the payload mutators in
 * order, serialize, then apply the transport wrappers in order.
 *
 * Payload mutators always run before transport wrappers regardless of the order
 * a case lists them in — a wrapper operates on the serialized bytes, so the
 * families are inherently staged. Within a family, declaration order is honored.
 */
export function materializePost(
  kase: ExerciseCase,
  index: number,
  options: MaterializeOptions = {},
): MaterializedPost {
  const post = kase.posts[index];
  if (post === undefined) {
    throw new Error(`case ${kase.id}: no POST at index ${index}`);
  }

  const generate = options.baseline ?? DEFAULT_BASELINE;
  const transportContext = options.transport ?? {};
  const transforms = post.transforms ?? [];
  const payloadTransforms = transforms.filter(isPayloadTransform);
  const transportTransforms = transforms.filter(
    (t): t is TransportTransform => t.kind === 'transport',
  );

  let payload = generate({ caseId: kase.id, index });
  for (const transform of payloadTransforms) {
    payload = transform.apply(payload);
  }

  let request = baseRequest(toBytes(payload));
  for (const transform of transportTransforms) {
    request = transform.apply(request, transportContext);
  }

  return {
    index,
    label: post.label ?? `#${index}`,
    payload,
    request,
    expectedStatus: post.expectedStatus,
    schemaOutcome: combineSchemaOutcomes(payloadTransforms),
    appliedTransforms: [...payloadTransforms, ...transportTransforms].map((t) => t.name),
  };
}

/** Resolve every POST of a case, in order. */
export function materializeCase(
  kase: ExerciseCase,
  options: MaterializeOptions = {},
): MaterializedPost[] {
  return kase.posts.map((_post, index) => materializePost(kase, index, options));
}

/** Every requirement id a case mentions, from its targets and expected findings. */
export function caseRequirements(kase: ExerciseCase): string[] {
  const ids = new Set<string>(kase.requirements);
  for (const finding of kase.expectedFindings) ids.add(finding.requirement);
  return [...ids].sort();
}

/** True for the HTTP 2xx range — the statuses that mean the data was accepted. */
export function isAcceptedStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
