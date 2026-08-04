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
 *   - the expected findings (requirement + severity) the session must show —
 *     PRESENCE-based, pooled across the case's POSTs; see `expectedFindings`.
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

/**
 * One finding the exercised session must show. Matched on `(requirement,
 * severity)` ONLY: a finding's `detail` is prose the graders are free to reword,
 * so it is deliberately not part of the contract. See
 * {@link ExerciseCase.expectedFindings} for the matching rule.
 */
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

/**
 * SESSION STATE a case needs the runner to arrange before its POSTs go out —
 * declarative, so a case stays DATA (no callbacks, nothing a CI test cannot read).
 *
 * `auth-enabled` (the only value today, ke6): the session must have opted into
 * §1.3 auth, and the runner must thread the show-once credential into the
 * {@link MaterializeOptions.transport} context so `bearerCredential()` can present
 * it. Every §1.3 case needs it — including the FAIL ones: `noAuth()`/`badAuth()`
 * only provoke a 401 on a session where auth is actually enabled.
 *
 * ── enabling auth is STICKY, and session-global ──────────────────────────────
 * Measured from the code, not assumed: `POST /api/sessions/{uuid}/auth`
 * (src/api/sessions.ts) flips `auth_enabled` on the SESSION ROW, and the ingest
 * pipeline's stage 2 (src/ingest/stages/auth.ts) then runs on EVERY subsequent
 * POST to that session — a request with no/invalid credential records a §1.3 FAIL
 * and halts 401, before the body, schema and semantic stages ever run. So any
 * ordinary case played after auth is enabled would collapse to a 401 and lose the
 * findings it expects. (`DELETE /api/sessions/{uuid}/auth` clears it, and while
 * auth is off every transmission simply earns a §1.3 `info` note, which never
 * grades.)
 *
 * The runner's answer is ORDER, not toggling: it plays every case without a setup
 * first, enables auth once, then plays the `auth-enabled` cases last, leaving auth
 * on at the end of the run. See ./runner/run.ts, which owns that decision — a case
 * never has to care where it sits in the table.
 */
export type CaseSetup = 'auth-enabled';

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
  /**
   * Session state the runner must arrange before playing this case. Absent for
   * the ordinary case, which needs nothing but a minted session. See
   * {@link CaseSetup} for what each value costs the rest of the run.
   */
  readonly setup?: CaseSetup;
  /** One or more POSTs, played in order against the same session. */
  readonly posts: readonly ExercisePost[];
  /**
   * Findings the session must show once every POST of this case has been played.
   *
   * PRESENCE-BASED, NOT EXHAUSTIVE (decided 2026-08-04; bd 27m). The runner
   * pools the findings attributable to this case's POSTs and requires each entry
   * here to appear at least once in that pool, matched on `(requirement,
   * severity)`. Findings in the pool that this list does not name do NOT fail
   * the case.
   *
   * Exhaustive matching was considered and rejected: an accepted POST
   * legitimately accumulates findings the case has no interest in — the §1.2,
   * §1.6 and §1.8 passes every 200 earns, or the extra §3.1 `info` naming
   * finding a custom object like `zTPCM` draws for breaking clause 4.5's
   * lower-case rule — so exhaustiveness would make every case brittle against
   * grader evolution rather than against the defect it targets. The accepted
   * cost is that a case cannot prove a defect did not LEAK; freedom from stray
   * fail findings is a property of the whole session, not of one case, and
   * belongs to the runner's summary if we ever want it.
   *
   * ATTRIBUTION IS PER CASE, NOT PER POST. A multi-POST case pools its POSTs, so
   * `1.8-fail-repeated-transfer-id` listing both a §1.8 pass and a §1.8 fail
   * asserts "the session shows both across my two POSTs", not which POST carried
   * which. How the runner attributes a finding to a POST in the first place is
   * its own business — querying findings by the transmission id the POST
   * returned is the obvious mechanism. If a case ever needs to pin an expectation
   * to one POST, add a post-label field to {@link ExpectedFinding}; do not
   * quietly re-read the pooled entries as per-POST ones.
   *
   * MAY BE EMPTY: a POST the §6 pipeline halts before persistence (405) is
   * graded by status alone and writes no finding to pool.
   */
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

/**
 * True when a case needs §1.3 auth enabled on the session before it is played.
 * The one reader of {@link ExerciseCase.setup} today — kept here so the runner
 * and the table invariants ask the same question of a case.
 */
export function requiresAuthEnabled(kase: ExerciseCase): boolean {
  return kase.setup === 'auth-enabled';
}

/** True for the HTTP 2xx range — the statuses that mean the data was accepted. */
export function isAcceptedStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
