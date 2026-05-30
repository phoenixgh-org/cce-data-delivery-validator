/**
 * Ingest pipeline framework (DESIGN.md §6).
 *
 * Each `POST /i/{uuid}` runs an ordered list of {@link Stage}s. A stage either
 * **continues** (optionally pushing one or more findings onto `ctx.findings`) or
 * **halts** with an HTTP status (the §6 short-circuit codes). The runner stops
 * at the first halt and reports the final status + accumulated findings.
 *
 * THE SHARED CONTRACT. Subagents B and C fill the per-stage stub bodies under
 * `src/ingest/stages/*.ts` WITHOUT editing this file. {@link PipelineContext} is
 * deliberately over-provisioned so every stage has a slot to read/write and no
 * one needs to widen the type. Treat the shapes below as frozen.
 */

import type { FastifyRequest } from 'fastify';

import type { InsertFindingInput, Severity } from '../db/repository.js';
import type { SchemaRegistry } from '../schema-registry.js';

/**
 * One finding accumulated as the pipeline runs. Shape matches
 * {@link InsertFindingInput} verbatim so persistence (3bn.7) hands the array
 * straight to `insertFindings` with no remapping.
 */
export type Finding = InsertFindingInput;

export type { Severity };

/**
 * Transmission `meta.*` fields lifted from the parsed body (DESIGN.md §3.1, §8).
 * Populated by the schema/semantic stages once the body parses; every field is
 * nullable because earlier stages (and parse failures) leave them unset.
 */
export interface IngestMeta {
  transferId?: string | null;
  transferSrc?: string | null;
  transferType?: string | null;
  /** Raw `meta.schemaVersion` as sent (pre-normalization). */
  schemaVersion?: string | null;
}

/**
 * Mutable context threaded through every stage. Over-provisioned on purpose:
 * stages read what they need and write their slot; nobody widens this type.
 */
export interface PipelineContext {
  /** The Fastify request (headers, params, protocol, raw body). */
  readonly request: FastifyRequest;
  /** Session UUID from the `/i/:uuid` path param. */
  readonly sessionUuid: string;
  /** Exact wire bytes as sent (DESIGN.md §4.1). Empty Buffer if no body. */
  readonly rawBody: Buffer;
  /** The compiled, content-pinned schema registry (from `app.schemaRegistry`). */
  readonly registry: SchemaRegistry;

  /** Findings accumulate here; the runner never clears them. */
  readonly findings: Finding[];

  /** Parsed JSON payload; set by the parse stage (stage 6). null until then. */
  parsedBody: unknown;
  /** Transmission `meta.*`, filled by the schema/semantic stages. */
  meta: IngestMeta;
  /** Normalized MAJOR.MINOR.PATCH schema version; null until resolved. */
  normalizedSchemaVersion: string | null;

  /** `Content-Type` request header (as sent), or null if absent. */
  contentType: string | null;
  /** `Content-Encoding` request header (as sent), or null if absent. */
  contentEncoding: string | null;

  /** True once the body parsed as JSON (stage 6). null until parse runs. */
  parseOk: boolean | null;
  /** True once the body validated against its schema (stage 7). null until then. */
  schemaOk: boolean | null;
}

/**
 * The result of running one stage.
 *   - `continue` — proceed to the next stage (findings, if any, already pushed).
 *   - `halt`     — short-circuit the pipeline with `status` as the HTTP code.
 */
export type StageOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'halt'; readonly status: number };

/** A pipeline stage: inspects/mutates `ctx`, returns its outcome. */
export interface Stage {
  /** Stable name for logging/ordering (e.g. 'session', 'method', 'parse'). */
  readonly name: string;
  run(ctx: PipelineContext): Promise<StageOutcome> | StageOutcome;
}

/** Convenience: a stage that continues. */
export const CONTINUE: StageOutcome = { kind: 'continue' };

/** Convenience: build a halt outcome with the given HTTP status. */
export function halt(status: number): StageOutcome {
  return { kind: 'halt', status };
}

/**
 * Push a finding onto the context and continue. Sugar for the common
 * "record a finding, keep going" case so stage bodies stay terse.
 */
export function record(ctx: PipelineContext, finding: Finding): StageOutcome {
  ctx.findings.push(finding);
  return CONTINUE;
}

/** Default success status when no stage halts (DESIGN.md §6: 200/202). */
export const DEFAULT_SUCCESS_STATUS = 200;

/** The outcome of a full pipeline run. */
export interface PipelineResult {
  /** Final HTTP status: the first halt's status, else {@link DEFAULT_SUCCESS_STATUS}. */
  readonly status: number;
  /** All findings accumulated across the stages that ran. */
  readonly findings: readonly Finding[];
  /** Name of the stage that halted, or null if every stage continued. */
  readonly haltedAt: string | null;
}

/**
 * Run `stages` in order against `ctx`, stopping at the first halt. Findings
 * accumulate on `ctx.findings` throughout (even from the halting stage, which
 * may push a teaching finding before short-circuiting). The §6 status-code
 * mapping lives in the stages themselves — they return the code; the runner
 * just surfaces the first one.
 */
export async function runPipeline(
  ctx: PipelineContext,
  stages: readonly Stage[],
): Promise<PipelineResult> {
  for (const stage of stages) {
    const outcome = await stage.run(ctx);
    if (outcome.kind === 'halt') {
      return { status: outcome.status, findings: ctx.findings, haltedAt: stage.name };
    }
  }
  return { status: DEFAULT_SUCCESS_STATUS, findings: ctx.findings, haltedAt: null };
}

/** The small JSON body returned on success/short-circuit (DESIGN.md §6). */
export interface IngestResponseBody {
  /** Persisted transmission id, or null when no row was written (404/405). */
  transmissionId: string | null;
  status: number;
  /** Count of findings recorded — a teaching surface (§6). */
  findings: number;
}

/** Build the small summary body returned to the supplier. */
export function buildResponseBody(
  status: number,
  findings: readonly Finding[],
  transmissionId: string | null,
): IngestResponseBody {
  return { transmissionId, status, findings: findings.length };
}
