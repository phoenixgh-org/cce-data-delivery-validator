/**
 * Stage 7 — schema validate (DESIGN.md §6 row 7, §3.1/§3.2; registry §9).
 *
 * Runs ONLY when the parse stage (6) succeeded: the parsed JSON body is
 * validated against the vendored schema named by `meta.schemaVersion`. The
 * stage:
 *
 *   1. Lifts `meta.{transferId,transferSrc,transferType,schemaVersion}` onto
 *      `ctx.meta` so the persist step records what the supplier SENT — even when
 *      validation then fails. (Stage 6 owns only `parsedBody`/`parseOk`; this
 *      stage owns `ctx.meta.*`, `ctx.normalizedSchemaVersion`, and `ctx.schemaOk`.)
 *   2. Resolves the version via `ctx.registry.lookup(raw)` (normalize → exact
 *      match, no fuzzy fallback). A missing/non-string `schemaVersion`, or an
 *      unsupported version, is a §3.2 fail that lists the supported versions and
 *      halts **422**.
 *   3. On a known version, runs the compiled Ajv validator. Each Ajv error
 *      becomes ONE §3.2 fail finding carrying the error's JSON Pointer; the stage
 *      sets `ctx.schemaOk = false` and halts **422**.
 *   4. A clean validation sets `ctx.schemaOk = true`, records a §3.2 pass finding
 *      (citing the content-pinned sha256 for the §9 provenance surface), and
 *      continues to the semantic stage / persist.
 *
 * Pointer mapping: Ajv `instancePath` is already an RFC-6901 JSON Pointer, which
 * we surface verbatim as the finding `pointer`. Ajv emits '' (empty) for a
 * root-level failure (e.g. a missing top-level `meta`/`data`); we keep the
 * pointer as null in that case (a JSON Pointer of '' addresses the whole
 * document and reads as "no pointer" in the dashboard) and still spell out
 * "(root)" in the human-readable `detail`.
 *
 * Defensive precondition: if `parseOk !== true` or there is no `parsedBody`, the
 * parse stage already halted 400 — but should this stage somehow run without a
 * parsed body, there is nothing to validate, so it continues without touching
 * `ctx.schemaOk`.
 */

import type { ErrorObject } from 'ajv';

import {
  CONTINUE,
  halt,
  type PipelineContext,
  type Stage,
  type StageOutcome,
} from '../pipeline.js';

/** Normalize an Ajv `instancePath` ('' at root) to a finding pointer. */
function toPointer(instancePath: string): string | null {
  return instancePath === '' ? null : instancePath;
}

/** Build a readable detail string for one Ajv error. */
function describeError(err: ErrorObject): string {
  const where = err.instancePath === '' ? '(root)' : err.instancePath;
  const message = err.message ?? 'is invalid';
  return `schema violation at ${where}: ${message} (§3.2)`;
}

export function schemaStage(): Stage {
  return {
    name: 'schema',
    run(ctx: PipelineContext): StageOutcome {
      // Precondition: only validate a body the parse stage actually produced.
      if (ctx.parseOk !== true || ctx.parsedBody == null) {
        return CONTINUE;
      }

      const body = ctx.parsedBody as { meta?: Record<string, unknown> };
      const meta = (body?.meta ?? {}) as Record<string, unknown>;

      // Record what the supplier SENT regardless of whether validation passes, so
      // the persisted row carries the transfer identifiers + raw schema version.
      ctx.meta.transferId = typeof meta.transferId === 'string' ? meta.transferId : null;
      ctx.meta.transferSrc = typeof meta.transferSrc === 'string' ? meta.transferSrc : null;
      ctx.meta.transferType = typeof meta.transferType === 'string' ? meta.transferType : null;
      ctx.meta.schemaVersion = typeof meta.schemaVersion === 'string' ? meta.schemaVersion : null;

      const raw = meta.schemaVersion;

      // Missing / non-string schemaVersion: a §3.2 schema-version failure. We
      // can't resolve a validator, so list what we DO support and halt 422.
      if (typeof raw !== 'string') {
        ctx.normalizedSchemaVersion = null;
        ctx.schemaOk = false;
        ctx.findings.push({
          requirement: '3.2',
          severity: 'fail',
          detail: `meta.schemaVersion is absent or not a string; supported: ${ctx.registry
            .supportedVersions()
            .join(', ')} (§3.2)`,
          pointer: '/meta/schemaVersion',
        });
        return halt(422);
      }

      const res = ctx.registry.lookup(raw);

      // Unknown version: ONE §3.2 fail listing the supported versions, then 422.
      if (!res.ok) {
        ctx.normalizedSchemaVersion = res.requested || null;
        ctx.schemaOk = false;
        ctx.findings.push({
          requirement: '3.2',
          severity: 'fail',
          detail: `unsupported schemaVersion "${raw}"; supported: ${res.supported.join(', ')} (§3.2)`,
          pointer: '/meta/schemaVersion',
        });
        return halt(422);
      }

      ctx.normalizedSchemaVersion = res.entry.version;

      const ok = res.entry.validate(ctx.parsedBody);
      // Ajv `.errors` is only valid immediately after the call — capture it now.
      const errors = res.entry.validate.errors ?? [];

      if (!ok) {
        ctx.schemaOk = false;
        // ONE finding per Ajv error, each carrying its JSON Pointer.
        for (const err of errors) {
          ctx.findings.push({
            requirement: '3.2',
            severity: 'fail',
            detail: describeError(err),
            pointer: toPointer(err.instancePath),
          });
        }
        // Guard: Ajv should always populate errors on failure, but never let a
        // 422 go out with zero findings.
        if (errors.length === 0) {
          ctx.findings.push({
            requirement: '3.2',
            severity: 'fail',
            detail: `body failed validation against schema ${res.entry.version} (§3.2)`,
          });
        }
        return halt(422);
      }

      ctx.schemaOk = true;
      ctx.findings.push({
        requirement: '3.2',
        severity: 'pass',
        detail: `validated against official ${res.entry.version} (sha256 ${res.entry.sha256}) (§3.2)`,
      });
      return CONTINUE;
    },
  };
}
