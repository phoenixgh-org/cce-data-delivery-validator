/**
 * Unit tests for the payload mutators that have an arithmetic contract (b0i).
 *
 * Most of the vocabulary needs no test of its own: ../cases.test.ts materializes
 * every case and runs the result through the real registry and the real Ajv
 * build, so a mutator that stops doing what its `schemaOutcome` claims fails CI
 * already. {@link padToWireCap} is different — its contract is a BYTE COUNT, and
 * nothing about schema validity would notice it being off by one. The §1.4 case
 * it serves is only meaningful if the body really lands on the cap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BASELINE } from '../baseline.js';
import { padToWireCap } from './payload.js';

const WIRE_CAP_BYTES = 1_048_576;

/** The generator the at-cap case is built on, asked exactly as the runner asks. */
function baseline() {
  return DEFAULT_BASELINE({ caseId: 'padToWireCap.test', index: 0 });
}

function wireBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

test('padToWireCap pads the payload to EXACTLY the 1MB §1.4 cap', () => {
  const padded = padToWireCap().apply(baseline());
  // Exactly, not "about": the size stage halts on `wireBytes > 1_048_576`, so one
  // byte either way is the difference between the boundary case and a 413 or a
  // comfortable pass that proves nothing new.
  assert.equal(wireBytes(padded), WIRE_CAP_BYTES);
});

test('padToWireCap pads FNAM, leaving the rest of the report untouched', () => {
  const before = baseline();
  const padded = padToWireCap().apply(baseline());
  const report = padded.data[0]!;
  assert.equal(typeof report.FNAM, 'string');
  assert.match(report.FNAM as string, /^A+$/, 'ASCII filler only — JSON escapes none of it');
  // FNAM is the ONLY difference: the padder must not disturb the baseline it was
  // handed, or the at-cap case would be exercising something other than size.
  const rest = { ...report };
  delete rest.FNAM;
  assert.deepEqual(rest, before.data[0]);
  assert.deepEqual(padded.meta, before.meta);
});

test('padToWireCap honors an explicit target and refuses one it has already passed', () => {
  const target = wireBytes(baseline()) + 500;
  assert.equal(wireBytes(padToWireCap(target).apply(baseline())), target);
  // A target smaller than the unpadded payload cannot be met by adding text, and
  // silently overshooting it would hand the case a body over the cap.
  assert.throws(() => padToWireCap(10).apply(baseline()), /past the 10-byte target/);
});
