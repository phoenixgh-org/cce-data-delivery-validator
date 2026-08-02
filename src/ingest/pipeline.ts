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

/**
 * Default success status when no stage halts. DESIGN.md §6 makes `200` the
 * SINGLE success status — `202` is not used.
 */
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

/**
 * One finding as echoed in the HTTP response body — the human-readable subset of
 * a {@link Finding} (`requirement`, `severity`, `detail`). The internal `pointer`
 * is omitted; suppliers read the per-error location from `detail`, and the full
 * finding (with pointer) is persisted for the dashboard.
 */
export interface ResponseFinding {
  requirement: string;
  severity: Severity;
  /** Human-readable explanation; absent only if a finding carried no detail. */
  detail?: string | null;
}

/**
 * The small JSON body returned on success/short-circuit (DESIGN.md §6).
 *
 * This body is a TEACHING SURFACE: a supplier should understand the outcome from
 * the HTTP response alone, without opening the dashboard (§6). So beyond the
 * persisted `transmissionId` and HTTP `status`, it carries:
 *   - `message` — a one-line human summary ("Accepted: …" / "Rejected (NNN): …")
 *     including a fail/info breakdown so the headline result is self-explanatory.
 *   - `findings` — the COUNT of findings recorded (kept from the original shape).
 *   - `findingDetails` — the per-finding `{requirement, severity, detail}` echo,
 *     so every recorded observation is readable straight from the response.
 *   - `notice` — the standing synthetic-data-only warning (§2/§12).
 */
export interface IngestResponseBody {
  /** Persisted transmission id, or null when no row was written (404/405). */
  transmissionId: string | null;
  status: number;
  /** One-line human summary of the outcome (teaching surface, §6). */
  message: string;
  /** Count of findings recorded — a teaching surface (§6). */
  findings: number;
  /** Per-finding human-readable echo so results are visible from the response. */
  findingDetails: ResponseFinding[];
  /**
   * Standing sandbox warning (dkz.1). Receiving real production data is an
   * explicit non-goal (DESIGN §2) and the capability-URL design is only safe
   * under that constraint (DESIGN §12) — so the teaching surface says so on
   * every response, not just in the UI the integrator may never open.
   */
  notice: string;
}

/**
 * The synthetic-data-only warning echoed on every ingest response. Wording is
 * kept in step with the web UI notice (`src/web/components/ui/SyntheticDataNotice.tsx`).
 */
export const SYNTHETIC_DATA_NOTICE =
  'Synthetic test data only: this is a sandbox endpoint. Never send real CCE data or PII — ' +
  'the endpoint URL is a bearer capability that anyone holding it can read.';

/** True for the HTTP 2xx status range (success — the data was accepted). */
function isAccepted(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Compose the one-line teaching summary. Accepted runs lead with "Accepted",
 * short-circuits with "Rejected (NNN)"; both append the finding tally (with a
 * fail/info breakdown when present) so the headline conveys the result alone.
 */
function summarize(status: number, findings: readonly Finding[]): string {
  const total = findings.length;
  const fails = findings.filter((f) => f.severity === 'fail').length;
  const infos = findings.filter((f) => f.severity === 'info').length;

  const plural = (n: number) => (n === 1 ? 'finding' : 'findings');
  let tally = `${total} ${plural(total)}`;
  const parts: string[] = [];
  if (fails > 0) parts.push(`${fails} fail`);
  if (infos > 0) parts.push(`${infos} info`);
  if (parts.length > 0) tally += ` (${parts.join(', ')})`;

  return isAccepted(status)
    ? `Accepted (${status}): data recorded; ${tally}.`
    : `Rejected (${status}): ${tally}.`;
}

/**
 * Build the small summary body returned to the supplier (DESIGN.md §6 teaching
 * surface). See {@link IngestResponseBody} for the field contract.
 */
export function buildResponseBody(
  status: number,
  findings: readonly Finding[],
  transmissionId: string | null,
): IngestResponseBody {
  return {
    transmissionId,
    status,
    message: summarize(status, findings),
    findings: findings.length,
    findingDetails: findings.map((f) => ({
      requirement: f.requirement,
      severity: f.severity,
      detail: f.detail,
    })),
    notice: SYNTHETIC_DATA_NOTICE,
  };
}
