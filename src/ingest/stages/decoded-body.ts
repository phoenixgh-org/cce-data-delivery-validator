/**
 * Decoded-body handoff between stage 5 (encoding) and stage 6 (parse).
 *
 * The frozen {@link PipelineContext} (src/ingest/pipeline.ts) is owned by
 * Subagent A and must NOT be widened. Its `rawBody` is the readonly EXACT wire
 * bytes (DESIGN.md §4.1) — when a body arrives `Content-Encoding: gzip`, stage 5
 * decompresses it, and stage 6 needs those decompressed bytes to parse. Rather
 * than mutate the readonly `rawBody` or add a field to the shared type, stage 5
 * stashes the decoded buffer here and stage 6 reads it back.
 *
 * The store is a `WeakMap` keyed by the per-request context object, so each
 * request's decoded body is isolated and is garbage-collected with the context.
 * Both stages 5 and 6 are owned by Subagent B; this file is the only shared
 * surface between them and is intentionally tiny.
 */

/** Per-request decoded body, keyed by the (object-identity) pipeline context. */
const decodedBodies = new WeakMap<object, Buffer>();

/** Stage 5 records the decompressed bytes for stage 6 to consume. */
export function setDecodedBody(ctx: object, decoded: Buffer): void {
  decodedBodies.set(ctx, decoded);
}

/**
 * The bytes stage 6 should parse: the decoded buffer if stage 5 stashed one
 * (gzip path), otherwise `undefined` so the caller falls back to `ctx.rawBody`.
 */
export function getDecodedBody(ctx: object): Buffer | undefined {
  return decodedBodies.get(ctx);
}
