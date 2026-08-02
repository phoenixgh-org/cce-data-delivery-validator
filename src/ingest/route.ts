/**
 * Ingest route — `POST /i/:uuid` (DESIGN.md §6).
 *
 * Registers the ingest endpoint for ALL methods so a non-POST gets our 405 (not
 * Fastify's default 404), builds the {@link PipelineContext}, runs the ordered
 * stage registry, and then — for any request that reached the body stages with
 * a valid session — persists exactly one transmission row plus its findings in a
 * single transaction (3bn.7).
 *
 * Persistence boundary (DESIGN.md §6/§8):
 *   - 404 (unknown session) and 405 (non-POST) persist NO row — these halt in
 *     stages 0/1 before the body stages and are not graded checks of the supplier.
 *   - An enabled-auth 401 (stage 2) DOES persist a row — it is a graded §1.3
 *     failure carrying a 1.3 FAIL finding, so we keep it (don't drop the call).
 *   - EVERYTHING from stage 3 onward (size/content-type/encoding/parse/schema/
 *     semantic) persists a row even when it short-circuits (413/400/422/…): the
 *     request reached the body stages with a valid session, so we record it.
 */

import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getPool } from '../db/pool.js';
import {
  findPriorTransmissions,
  insertFindings,
  insertTransmission,
  type Queryable,
} from '../db/repository.js';
import { normalizeVersion, type SchemaRegistry } from '../schema-registry.js';
import { enterSession, leaveSession } from './concurrency-tracker.js';
import {
  buildResponseBody,
  runPipeline,
  type Finding,
  type PipelineContext,
  type Stage,
} from './pipeline.js';
import { authStage } from './stages/auth.js';
import { contentTypeStage } from './stages/content-type.js';
import { getDecodedBody } from './stages/decoded-body.js';
import { encodingStage } from './stages/encoding.js';
import { methodStage } from './stages/method.js';
import { parseStage } from './stages/parse.js';
import { schemaStage } from './stages/schema.js';
import { semanticStage, type SemanticDeps } from './stages/semantic.js';
import { sessionStage } from './stages/session.js';
import { sizeStage } from './stages/size.js';

/**
 * Stages that run BEFORE the persistence boundary — a halt here writes no row,
 * with ONE exception: an enabled-auth 401 (stage 2), which the handler persists
 * because it is a graded §1.3 failure. See the module header.
 *
 * Ordering note: the §6 table numbers session as stage 0 and method as stage 1,
 * but we run METHOD FIRST so a non-POST short-circuits 405 without a (pointless)
 * DB lookup — and a non-POST to an unknown uuid still gets 405, not 404. Both
 * are pre-body 4xx short-circuits that persist no row, so the relative order has
 * no observable effect beyond avoiding that DB hit.
 */
function preBodyStages(db?: Queryable): Stage[] {
  return [
    // Stage 1 — method (405, no row). First, so non-POST never touches the DB.
    methodStage(),
    // Stage 0 — session lookup (404, no row).
    sessionStage(db),
    // Stage 2 — Auth (opt-in, §1.3, M6/ct4.2). The zero-friction default (auth
    //   disabled) is a no-op. When the session has opted in, a missing/incorrect
    //   credential short-circuits 401 — but UNLIKE the 404/405 halts above, that
    //   401 DOES persist a transmission row: it is a graded §1.3 failure carrying
    //   a 1.3 FAIL finding, so the handler special-cases `haltedAt === 'auth'`
    //   (see the module header and the handler comment below).
    authStage(db),
  ];
}

/**
 * Stages that run AFTER the persistence boundary — a halt here STILL writes a row.
 *
 * Takes the semantic stage's {@link SemanticDeps} (concurrency snapshot +
 * prior-transmission lookup) and threads them into `semanticStage(deps)` at the
 * stage-8 insertion point. The deps ride in the stage closure so the frozen
 * `PipelineContext` type is never widened.
 */
function bodyStages(semanticDeps: SemanticDeps): Stage[] {
  return [
    // Stage 3 — size (413 + finding).
    sizeStage(),
    // Stage 4 — Content-Type (finding; 415 optional).
    contentTypeStage(),
    // Stage 5 — Content-Encoding (finding; 400 if undecodable).
    encodingStage(),
    // Stage 6 — JSON parse (400).
    parseStage(),
    // Stage 7 — schema validate (422 + per-error findings).
    schemaStage(),
    // INSERTION POINT — Stage 8: Semantic checks (§1.8/§2.1/§3.x, M5). Emits
    // findings and accepts the data (2xx), so it belongs on the body side and
    // never halts.
    semanticStage(semanticDeps),
  ];
}

/** Build a fresh PipelineContext for one request. */
function buildContext(
  request: FastifyRequest,
  sessionUuid: string,
  registry: SchemaRegistry,
): PipelineContext {
  const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.alloc(0);
  const headers = request.headers;
  return {
    request,
    sessionUuid,
    rawBody,
    registry,
    findings: [],
    parsedBody: null,
    meta: {},
    normalizedSchemaVersion: null,
    contentType: typeof headers['content-type'] === 'string' ? headers['content-type'] : null,
    contentEncoding:
      typeof headers['content-encoding'] === 'string' ? headers['content-encoding'] : null,
    parseOk: null,
    schemaOk: null,
  };
}

/**
 * Build the NUL-safe text stored in `transmission.raw_body` (a `text` column).
 *
 * Two adjustments to the exact wire bytes, both for drill-down usefulness/safety
 * (DESIGN.md §8 — raw_body is a drill-down COPY, not the authoritative artifact;
 * `content_hash` + `wire_bytes` + `content_encoding` preserve the wire facts for
 * §1.4/§1.8):
 *
 *   - When stage 5 decoded a `Content-Encoding` (gzip), store the DECODED text —
 *     the readable payload a human drills into — instead of the binary gzip
 *     bytes. Falls back to the raw wire bytes when nothing was decoded.
 *   - Strip NUL (0x00): Postgres `text` rejects 0x00 ("invalid byte sequence for
 *     encoding UTF8: 0x00"), so a binary/gzip body would otherwise throw and turn
 *     the whole insert — hence the ingest response — into a 500 (bug do5).
 *
 * NOT a third adjustment: length. No write-side cap is applied here or in
 * `insertTransmission` (decided 2026-08-02, beads 1z9) — the text is stored
 * whole into an unbounded `text` column. The only ceilings sit upstream, in the
 * transport: Fastify's 2 MiB `bodyLimit` (nothing recorded past it) and gzip's
 * 1 MiB `maxOutputLength` (stage 5 halts 400, and the row keeps the still-
 * compressed wire bytes). U+FFFD substitution can make the stored copy LONGER
 * than the wire, which is why the dashboard's truncation disclosure compares
 * against `wire_bytes` rather than quoting a cap.
 */
function storedRawBody(ctx: PipelineContext): string {
  const bytes = getDecodedBody(ctx) ?? ctx.rawBody;
  // toString('utf8') maps invalid byte sequences to U+FFFD; NUL is valid UTF-8
  // but illegal in a Postgres text column, so strip it explicitly.
  return bytes.toString('utf8').replaceAll(String.fromCharCode(0), '');
}

/**
 * Persist one transmission + its findings in a single transaction. Returns the
 * new transmission id. Maps `ctx` → columns per `InsertTransmissionInput`,
 * reading whatever the (stub-or-real) stages set so B/C light up automatically.
 */
async function persistTransmission(
  ctx: PipelineContext,
  httpStatus: number,
  findings: readonly Finding[],
): Promise<string> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const contentHash = createHash('sha256').update(ctx.rawBody).digest();
    const normalizedSchemaVersion =
      ctx.normalizedSchemaVersion ??
      (ctx.meta.schemaVersion ? normalizeVersion(ctx.meta.schemaVersion) : null);

    const tx = await insertTransmission(
      {
        sessionUuid: ctx.sessionUuid,
        contentHash,
        wireBytes: ctx.rawBody.length,
        contentType: ctx.contentType,
        contentEncoding: ctx.contentEncoding,
        httpStatus,
        transferId: ctx.meta.transferId ?? null,
        transferSrc: ctx.meta.transferSrc ?? null,
        transferType: ctx.meta.transferType ?? null,
        schemaVersion: normalizedSchemaVersion,
        // Parsed payload (null until the parse stage sets it).
        body: ctx.parsedBody ?? null,
        // Drill-down text, kept ESPECIALLY when parse fails (DESIGN.md §8).
        // Decoded (gzip) text when an encoding was applied, NUL-stripped so the
        // `text` column never rejects a binary body — see storedRawBody / do5.
        rawBody: storedRawBody(ctx),
        parseOk: ctx.parseOk,
        schemaOk: ctx.schemaOk,
      },
      client,
    );

    await insertFindings(tx.id, findings, client);

    await client.query('COMMIT');
    return tx.id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Register the ingest route on `app`. The schema registry is read off
 * `app.schemaRegistry` (decorated in `buildApp`).
 */
export function registerIngestRoute(app: FastifyInstance): void {
  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/i/:uuid',
    async handler(request: FastifyRequest, reply: FastifyReply) {
      const { uuid } = request.params as { uuid: string };
      const ctx = buildContext(request, uuid, app.schemaRegistry);

      // Pre-body stages (0, 1[, 2]): a halt here persists NO transmission row —
      // EXCEPT an enabled-auth 401. The 404 (session) and 405 (method) rejects are
      // not graded checks of the supplier and carry no findings, so they stay
      // row-less. An enabled-auth 401 IS a graded §1.3 failure (the auth stage
      // recorded a 1.3 FAIL finding before halting), so we persist the row + that
      // finding — we call balls and strikes as we see them, and don't drop the
      // call. `haltedAt === 'auth'` is the precise signal: the auth stage only
      // halts when auth is enabled and the credential failed.
      const pre = await runPipeline(ctx, preBodyStages());
      if (pre.haltedAt !== null) {
        if (pre.haltedAt === 'auth') {
          const transmissionId = await persistTransmission(ctx, pre.status, ctx.findings);
          return reply
            .code(pre.status)
            .send(buildResponseBody(pre.status, ctx.findings, transmissionId));
        }
        return reply.code(pre.status).send(buildResponseBody(pre.status, pre.findings, null));
      }

      // The request reached the body stages with a valid session + POST. Mark it
      // in flight and capture the §2.1 concurrency snapshot (includes self), then
      // release it in a `finally` so the count is freed even if persistence throws.
      const concurrentAtEntry = enterSession(uuid);
      try {
        const semanticDeps: SemanticDeps = { concurrentAtEntry, findPriorTransmissions };

        // Body stages (3–7[, 8]): reached with a valid session + POST, so a row is
        // persisted regardless of whether a body stage short-circuits.
        const post = await runPipeline(ctx, bodyStages(semanticDeps));
        const status = post.status;

        const transmissionId = await persistTransmission(ctx, status, ctx.findings);

        return reply.code(status).send(buildResponseBody(status, ctx.findings, transmissionId));
      } finally {
        leaveSession(uuid);
      }
    },
  });
}
