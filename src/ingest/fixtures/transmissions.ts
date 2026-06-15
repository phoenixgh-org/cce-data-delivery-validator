/**
 * Fixture transmissions for the conditional-failure cases (bat.1; DESIGN.md §14.8).
 *
 * One VALID baseline (§6 happy path → 200) plus one fixture per conditional
 * failure, each mapped to the stage that grades it and the §6 response code it
 * should yield:
 *
 *   | fixture          | stage (§6)         | expected status |
 *   |------------------|--------------------|-----------------|
 *   | valid            | all continue       | 200             |
 *   | oversize         | 3. size            | 413             |
 *   | badContentType   | 4. content-type    | 200 (finding; never halts) |
 *   | doubleEncoded    | 5. encoding        | 400             |
 *   | unparseable      | 6. parse           | 400             |
 *   | schemaInvalid    | 7. schema          | 422             |
 *   | duplicate        | 8. semantic        | 2xx + 1.8 fail (needs a prior row) |
 *
 * The VALID payload is the single source of truth: the schema-invalid and
 * duplicate variants are DERIVED from it so they stay schema-shaped except for
 * the one mutation each case exercises.
 */

import { gzipSync } from 'node:zlib';

/** The canonical content-type the §1.2 check wants (used by the valid cases). */
export const JSON_UTF8 = 'application/json; charset=utf-8';

/**
 * A genuinely schema-valid RTM transmission on the CURRENT schema version — the
 * baseline that reaches the §6 happy-path 200 with a §3.2 pass. Mirrors the
 * valid body the existing route tests POST. `as const` keeps the literal shape;
 * callers deep-clone before mutating.
 */
export const validTransmission = {
  meta: {
    schemaVersion: '0.8.1',
    transferType: 'rtm',
    transferId: 'T-baseline',
    transferSrc: 'com.example',
    transferredAt: '2024-01-15T04:05:54Z',
  },
  data: [
    {
      AMID: 'appliance-1',
      CID: 'US',
      EDOP: '2021-06-01',
      EMFR: 'EMD_Name',
      EMOD: 'EMD-ModelNo',
      EPQS: 'E006/999',
      ESER: 'EMD-SerialNum',
      EMSV: 'v01.02.123',
      DLST: { TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' } },
      records: [{ ABST: '20200115T040554Z', ALRM: 'HEAT', BEMD: 14.3, EERR: 'none', TVC: 3.2 }],
    },
  ],
} as const;

/** Structured deep clone so a derived fixture never mutates the baseline. */
export function cloneValid(): {
  meta: Record<string, unknown>;
  data: Record<string, unknown>[];
} {
  // structuredClone yields a deep mutable copy at runtime, but its return type
  // inherits validTransmission's `as const` deep-readonly shape — so cast via
  // `unknown` to reach the mutable fixture type (TS2352 otherwise).
  return structuredClone(validTransmission) as unknown as {
    meta: Record<string, unknown>;
    data: Record<string, unknown>[];
  };
}

/** Serialize a payload object to the exact UTF-8 wire bytes. */
export function toBytes(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

/** The valid baseline as wire bytes. */
export function validBytes(): Buffer {
  return toBytes(validTransmission);
}

/**
 * OVERSIZE (stage 3 → 413). One byte over the §1.4 1MB cap. Content is
 * irrelevant — the size stage halts before parse — so we use filler bytes.
 */
export function oversizeBytes(): Buffer {
  return Buffer.alloc(1_048_577, 0x61); // 'a' × (1MB + 1)
}

/**
 * SCHEMA-INVALID (stage 7 → 422). Parses fine but fails Ajv: drop a required
 * DS01 field (`AMID`) from the lone data object. Everything else stays valid so
 * the failure is unambiguously a §3.2 schema violation, not a parse/version one.
 */
export function schemaInvalidPayload(): Record<string, unknown> {
  const p = cloneValid();
  delete p.data[0]?.AMID;
  return p;
}

export function schemaInvalidBytes(): Buffer {
  return toBytes(schemaInvalidPayload());
}

/**
 * UNPARSEABLE (stage 6 → 400). Malformed JSON bytes that never parse.
 */
export function unparseableBytes(): Buffer {
  return Buffer.from('{"meta":{ broken', 'utf8');
}

/**
 * ILLEGAL DOUBLE-ENCODING (stage 5 → 400). A gzip member that decompresses to
 * ANOTHER gzip member (gzip-of-gzip) — the double-wrapping §1.6 forbids. Sent
 * with `Content-Encoding: gzip`.
 */
export function doubleEncodedBytes(): Buffer {
  return gzipSync(gzipSync(validBytes()));
}

/**
 * DUPLICATE (stage 8 → 2xx + §1.8 fail). The exact valid baseline bytes: POSTed
 * twice to the same session, the second POST is a byte-identical replay AND a
 * repeated transferId, so the semantic stage records a §1.8 fail. Identical to
 * {@link validBytes}; named for intent at the call site.
 */
export function duplicateBytes(): Buffer {
  return validBytes();
}
