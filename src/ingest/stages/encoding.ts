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

      let decoded: Buffer;
      try {
        decoded = gunzipSync(ctx.rawBody, { maxOutputLength: MAX_DECODED_BYTES });
      } catch (err) {
        // Not valid gzip (e.g. base64-of-gzip, truncated, or zip-bomb over cap).
        const reason = err instanceof Error ? err.message : 'decompression failed';
        ctx.findings.push({
          requirement: '1.6',
          severity: 'fail',
          detail: `gzip body could not be decompressed: ${reason} (§1.6)`,
          code: 'tx.undecodable_body',
        });
        return halt(400);
      }

      // Illegal double-encoding: a gzip member that decompresses to ANOTHER gzip
      // member is the forbidden double-wrapping (§1.6).
      if (looksGzipped(decoded)) {
        ctx.findings.push({
          requirement: '1.6',
          severity: 'fail',
          detail: 'gzip body decompresses to another gzip member — illegal double-encoding (§1.6)',
          code: 'tx.double_encoded',
        });
        return halt(400);
      }

      // Good single-layer gzip: hand the decoded bytes to stage 6, record a pass.
      setDecodedBody(ctx, decoded);
      return record(ctx, {
        requirement: '1.6',
        severity: 'pass',
        detail: 'Content-Encoding gzip decoded cleanly to a single non-gzip layer (§1.6)',
      });
    },
  };
}
