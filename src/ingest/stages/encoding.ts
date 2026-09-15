/**
 * Stage 5 — Content-Encoding (DESIGN.md §6 row 5, §1.6). If the body arrives
 * `Content-Encoding: gzip`, decompress it (under a zip-bomb guard) and hand the
 * decoded bytes to the parse stage via the {@link setDecodedBody} WeakMap. On a
 * decompression failure or illegal double-encoding (gzip-of-gzip, base64, …) →
 * §1.6 fail finding + **400**. No encoding header → clean continue.
 *
 * §1.6 legal encodings: §1.6 permits `gzip` via `Content-Encoding` and forbids
 * double base64 wrapping. We treat ONLY `gzip` (and the no-op `identity`) as
 * decodable; any other token, or bytes that don't gunzip, is undecodable → 400.
 *
 * Zip-bomb guard: `gunzipSync` is bounded with `maxOutputLength`, which THROWS
 * once the decompressed size would exceed the cap. The cap is the §1.4 wire cap
 * (1MB) — a gzipped payload whose JSON exceeds 1MB decompressed is rejected as
 * undecodable here rather than allowed to expand unbounded in memory (§Resource
 * limits: "guard gzip decompression against zip-bomb expansion ratios").
 *
 * Double-encoding detection: after a successful gunzip we check the FIRST bytes
 * of the decompressed output for a second gzip magic header (0x1f 0x8b) — a
 * gzip-of-gzip layering that §1.6 forbids — and reject it as a §1.6 finding +
 * 400. (Base64 / other illegal wrappers simply fail to gunzip and are caught by
 * the same 400 path.)
 *
 * The guarded decode itself lives in {@link decodeGzipBounded}, a pure function
 * this stage shares with `storedRawBody` in src/ingest/route.ts (0d4). A request
 * that fails §1.3 auth halts at stage 2, so this stage never runs for it, yet its
 * stored drill-down copy must still be readable text — and must reach it through
 * the SAME 1 MiB guard, so that an unauthenticated POST cannot become a
 * decompression-bomb vector. One function, two callers, no second copy to drift.
 */

import { gunzipSync } from 'node:zlib';

import {
  CONTINUE,
  halt,
  record,
  type PipelineContext,
  type Stage,
  type StageOutcome,
} from '../pipeline.js';
import { setDecodedBody } from './decoded-body.js';

/** §1.4 cap reused as the zip-bomb ceiling for decompressed output (1MB). */
const MAX_DECODED_BYTES = 1_048_576;

/** gzip magic number (RFC 1952): first two bytes of a gzip member. */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** True if `buf` starts with the gzip magic header. */
function looksGzipped(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

/**
 * The outcome of a bounded gzip decode. `undecodable` covers everything that
 * failed to gunzip — truncated members, base64 wrapping, and a zip bomb over the
 * cap alike — and carries zlib's message for the §1.6 finding detail.
 */
export type GzipDecodeResult =
  | { kind: 'decoded'; bytes: Buffer }
  | { kind: 'undecodable'; reason: string }
  | { kind: 'double-encoded' };

/**
 * Gunzip `bytes` under the 1 MiB zip-bomb guard, reporting the illegal
 * gzip-of-gzip layering separately. Pure: it emits no findings and never throws,
 * so the two callers (this stage, and the storage-side decode in route.ts) can
 * each map the outcome to their own concern — grading in one case, what text
 * gets stored in the other.
 */
export function decodeGzipBounded(bytes: Buffer): GzipDecodeResult {
  let decoded: Buffer;
  try {
    decoded = gunzipSync(bytes, { maxOutputLength: MAX_DECODED_BYTES });
  } catch (err) {
    // Not valid gzip (e.g. base64-of-gzip, truncated, or zip-bomb over cap).
    return {
      kind: 'undecodable',
      reason: err instanceof Error ? err.message : 'decompression failed',
    };
  }

  // Illegal double-encoding: a gzip member that decompresses to ANOTHER gzip
  // member is the forbidden double-wrapping (§1.6).
  if (looksGzipped(decoded)) {
    return { kind: 'double-encoded' };
  }

  return { kind: 'decoded', bytes: decoded };
}

export function encodingStage(): Stage {
  return {
    name: 'encoding',
    run(ctx: PipelineContext): StageOutcome {
      const enc: string | null = ctx.contentEncoding;

      // No Content-Encoding (or the no-op `identity`): nothing to decode. Stage 6
      // falls back to ctx.rawBody. §1.6 is not exercised → continue clean.
      if (enc === null || enc.trim().toLowerCase() === 'identity') {
        return CONTINUE;
      }

      const token = enc.trim().toLowerCase();

      // Only gzip is a decodable encoding for us; anything else is undecodable.
      if (token !== 'gzip') {
        ctx.findings.push({
          requirement: '1.6',
          severity: 'fail',
          detail: `Content-Encoding "${enc}" is unsupported; only gzip is permitted (§1.6)`,
          code: 'tx.unsupported_encoding',
        });
        return halt(400);
      }

      const result = decodeGzipBounded(ctx.rawBody);

      if (result.kind === 'undecodable') {
        ctx.findings.push({
          requirement: '1.6',
          severity: 'fail',
          detail: `gzip body could not be decompressed: ${result.reason} (§1.6)`,
          code: 'tx.undecodable_body',
        });
        return halt(400);
      }

      if (result.kind === 'double-encoded') {
        ctx.findings.push({
          requirement: '1.6',
          severity: 'fail',
          detail: 'gzip body decompresses to another gzip member — illegal double-encoding (§1.6)',
          code: 'tx.double_encoded',
        });
        return halt(400);
      }

      // Good single-layer gzip: hand the decoded bytes to stage 6, record a pass.
      setDecodedBody(ctx, result.bytes);
      return record(ctx, {
        requirement: '1.6',
        severity: 'pass',
        detail: 'Content-Encoding gzip decoded cleanly to a single non-gzip layer (§1.6)',
      });
    },
  };
}
