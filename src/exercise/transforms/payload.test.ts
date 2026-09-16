/**
 * Unit tests for the payload mutators whose contract Ajv cannot see (b0i; eyok,
 * ftx0).
 *
 * Most of the vocabulary needs no test of its own: ../cases.test.ts materializes
 * every case and runs the result through the real registry and the real Ajv
 * build, so a mutator that stops doing what its `schemaOutcome` claims fails CI
 * already. {@link padToWireCap} is different — its contract is a BYTE COUNT, and
 * nothing about schema validity would notice it being off by one. The §1.4 case
 * it serves is only meaningful if the body really lands on the cap.
 *
 * The record-synthesis mutators at the bottom are the same kind of gap from the
 * other direction: their contract is the SHAPE an advisory check reads — a record
 * count past a floor, a column of nulls, an explanation beside the null it
 * explains — and every one of those shapes is schema-valid whether the mutator
 * gets it right or not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAbst } from '../../ingest/stages/semantic/interval.js';
import { MIN_RECORDS } from '../../ingest/stages/semantic/null-padding.js';
import { DEFAULT_BASELINE, emsBaseline } from '../baseline.js';
import type { TransmissionPayload } from '../baseline.js';
import { explainedNullTemperature, nullPaddedSeries, padToWireCap } from './payload.js';

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

// ── the record-synthesis mutators (eyok, ftx0) ──────────────────────────────
//
// The same argument as above applies in reverse: ../cases.test.ts proves these
// stay SCHEMA-VALID, which is the half a schema can see. What it cannot see is
// whether they produce the SHAPE the advisory checks read — a column of nulls
// past the 12-record floor, an explanation sitting beside the null it explains —
// and a mutator that quietly stopped doing that would leave its case passing CI
// while observing nothing live. These tests pin the shape.

/** The EMS baseline, asked exactly as the runner asks. */
function ems() {
  return emsBaseline({ caseId: 'transforms.test', index: 0 });
}

function recordsOf(payload: TransmissionPayload): Record<string, unknown>[] {
  return payload.data[0]!.records as Record<string, unknown>[];
}

test('nullPaddedSeries clears the 12-record floor with HAMB and HOLD null throughout', () => {
  const records = recordsOf(nullPaddedSeries().apply(ems()));
  // The floor is the check's, not this transform's: fewer than MIN_RECORDS
  // records and adv.null_padding declines to call a column padded at all.
  assert.equal(records.length, MIN_RECORDS);
  for (const [i, record] of records.entries()) {
    assert.equal(record.HAMB, null, `record ${i} carries HAMB`);
    assert.equal(record.HOLD, null, `record ${i} carries HOLD`);
  }
});

test('nullPaddedSeries steps 15 minutes and leaves CMPR/SVA at the baseline', () => {
  const before = recordsOf(ems())[0]!;
  const records = recordsOf(nullPaddedSeries().apply(ems()));
  const stamps = records.map((r) => parseAbst(r.ABST));
  assert.ok(
    stamps.every((t) => t !== null),
    'every synthesized ABST parses',
  );
  for (let i = 1; i < stamps.length; i += 1) {
    assert.equal(stamps[i]! - stamps[i - 1]!, 15 * 60_000, `records ${i - 1}→${i} step 15 minutes`);
  }
  // Distinct stamps are also what keeps adv.duplicate_records quiet: the clones
  // would otherwise be identical in full.
  assert.equal(new Set(records.map((r) => r.ABST)).size, records.length);
  // The compressor values are the case's silence: 320 is nowhere near the 15 that
  // adv.cmpr_minutes reads as a minutes-valued feed, and far below SVA 900.
  for (const record of records) {
    assert.equal(record.CMPR, before.CMPR);
    assert.equal(record.SVA, before.SVA);
  }
});

test('explainedNullTemperature nulls TVC and names a logger error beside it', () => {
  const records = recordsOf(explainedNullTemperature().apply(ems()));
  assert.equal(records[0]!.TVC, null);
  // A non-empty LERR is what the abnormal branch requires — the baseline's null,
  // and equally an empty string, matches neither branch.
  assert.equal(records[0]!.LERR, 'E12');
  assert.ok((records[0]!.LERR as string).length > 0);
  // One record only: the rest of the series keeps its numeric reading, so the
  // case is about the conditional rather than about a whole null column.
  assert.equal(records.length, 3);
  assert.equal(records[1]!.TVC, 4.9);
  assert.equal(records[1]!.LERR, null);
});
