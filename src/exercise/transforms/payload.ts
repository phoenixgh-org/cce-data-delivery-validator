/**
 * PAYLOAD mutators — the first of the two exercise transform families (8qa.1;
 * epic 8qa design notes).
 *
 * A payload mutator takes the canonical baseline payload (see ../baseline.ts)
 * and returns a variant. One baseline × this vocabulary is what yields the case
 * variety cheaply, and it generalizes the `cloneValid() + one mutation` pattern
 * already used by `src/ingest/fixtures/transmissions.ts` rather than inventing a
 * second one.
 *
 * ── the declared schema effect is the CI hook ────────────────────────────────
 * Every mutator declares what it does to the payload's standing with the
 * vendored schema, as a {@link SchemaOutcome}:
 *
 *   - `valid`               the payload still validates (the mutant's defect, if
 *                           any, lives above Ajv — §3.1/§3.4 semantics — or the
 *                           mutator is benign scaffolding);
 *   - `invalid`             Ajv must reject it (a §3.2 schema violation);
 *   - `unsupported-version` Ajv is never reached: `meta.schemaVersion` names a
 *                           version the registry does not carry, which stage 7
 *                           grades as a §3.2 fail before validating anything.
 *
 * CURRENCY IS NOT AN OUTCOME. The vocabulary describes what happens at stage 7's
 * VALIDATION step, not the currency verdict that follows it. A payload declaring
 * a registered-but-OLDER version (0.8.0 today) is plainly `valid` — the registry
 * resolves it and its own compiled validator accepts the body — even though the
 * stage then records `info` + `outdated` rather than a §3.2 pass. Considered and
 * rejected: a fourth `outdated` value. It would conflate "did Ajv accept this?"
 * with "is this the newest version we know?", make `combineSchemaOutcomes` rank
 * two unrelated axes, and leave ../cases.test.ts unable to state the thing worth
 * stating — that the payload validates against the OLD schema's actual bytes.
 * Currency is expressed where it belongs: in the case's expected findings and
 * expected status, checked live by the runner.
 *
 * That declaration is not an annotation someone must remember to keep true:
 * ../cases.test.ts runs every materialized payload through the real registry and
 * the real Ajv validator and asserts the declared outcome, so a vocabulary entry
 * that stops doing what it claims fails CI.
 *
 * ── ownership contract ──────────────────────────────────────────────────────
 * `apply` receives a payload the caller has already cloned and hands over; it
 * may mutate in place and must return the payload to use next. Callers must not
 * keep using the input afterwards.
 */

import { parseAbst } from '../../ingest/stages/semantic/interval.js';
import type { TransmissionPayload } from '../baseline.js';
import { deleteAtPointer, escapePointerToken, setAtPointer } from '../pointer.js';

/** What a payload is expected to do when it reaches the §6 schema stage. */
export type SchemaOutcome = 'valid' | 'invalid' | 'unsupported-version';

/** One named payload mutation. */
export interface PayloadTransform {
  readonly kind: 'payload';
  /** Self-documenting name, e.g. `dropRequiredField(/data/0/AMID)`. */
  readonly name: string;
  /**
   * Requirement ids (COMPLIANCE_MATRIX ids) this mutation bears on. Empty for
   * benign scaffolding that only sets up a case (e.g. pinning a transferId).
   */
  readonly targets: readonly string[];
  /** What this mutation does to the payload's schema standing. */
  readonly schemaOutcome: SchemaOutcome;
  apply(payload: TransmissionPayload): TransmissionPayload;
}

/**
 * The extension point: build a payload mutator from an explicit spec. Later
 * bites (8qa.3–.5) add vocabulary through this rather than by widening the type.
 */
export function payloadTransform(spec: {
  name: string;
  targets?: readonly string[];
  schemaOutcome?: SchemaOutcome;
  apply: (payload: TransmissionPayload) => TransmissionPayload;
}): PayloadTransform {
  return {
    kind: 'payload',
    name: spec.name,
    targets: spec.targets ?? [],
    schemaOutcome: spec.schemaOutcome ?? 'valid',
    apply: spec.apply,
  };
}

// ── benign scaffolding ──────────────────────────────────────────────────────

/**
 * Pin `meta.transferId` to a fixed value.
 *
 * Benign on its own, and the reason sequence cases stay generator-agnostic: the
 * §1.8 duplicate heuristic trips on a repeated transferId OR byte-identical
 * content, and only the former survives a future baseline generator that
 * randomizes payload content. A duplicate case therefore pins the id on BOTH
 * POSTs instead of relying on two baseline calls returning identical bytes.
 */
export function setTransferId(transferId: string): PayloadTransform {
  return payloadTransform({
    name: `setTransferId(${transferId})`,
    apply: (payload) => {
      setAtPointer(payload, '/meta/transferId', transferId);
      return payload;
    },
  });
}

/**
 * Declare a REGISTERED `meta.schemaVersion`. Benign: the registry resolves it and
 * Ajv runs, so the outcome stays `valid` however OLD the named version is.
 *
 * This is how the outdated-but-valid path is exercised now that a second version
 * is registered (0.8.0 alongside the current 0.8.1, bd 8qa.4): pointing it at the
 * older entry leaves the payload schema-valid while making the schema stage grade
 * §3.2 `info` + `outdated` instead of `pass`. ../cases.test.ts asserts the version
 * named here really is registered — and, for a case expecting that info finding,
 * that it really is older than current — so this cannot silently decay into an
 * unsupported-version case or into an ordinary current-version pass.
 */
export function setSchemaVersion(version: string): PayloadTransform {
  return payloadTransform({
    name: `setSchemaVersion(${version})`,
    targets: ['3.2'],
    apply: (payload) => {
      setAtPointer(payload, '/meta/schemaVersion', version);
      return payload;
    },
  });
}

// ── §3.2 schema violations ──────────────────────────────────────────────────

/**
 * Declare a `meta.schemaVersion` the registry does NOT carry — stage 7 halts 422
 * with a §3.2 fail before Ajv is reached. The payload itself stays schema-shaped,
 * which is why this is its own outcome rather than `invalid`.
 */
export function setUnsupportedSchemaVersion(version: string): PayloadTransform {
  return payloadTransform({
    name: `setUnsupportedSchemaVersion(${version})`,
    targets: ['3.2'],
    schemaOutcome: 'unsupported-version',
    apply: (payload) => {
      setAtPointer(payload, '/meta/schemaVersion', version);
      return payload;
    },
  });
}

/**
 * Remove a field the schema requires (e.g. `/data/0/AMID`) — the §3.2 mutation
 * `schemaInvalidPayload()` already encodes, generalized to any pointer. Throws
 * if the field is not there to remove, so a stale pointer fails loudly.
 */
export function dropRequiredField(pointer: string): PayloadTransform {
  return payloadTransform({
    name: `dropRequiredField(${pointer})`,
    targets: ['3.2'],
    schemaOutcome: 'invalid',
    apply: (payload) => {
      deleteAtPointer(payload, pointer);
      return payload;
    },
  });
}

/**
 * Write a value the schema rejects at `pointer` (wrong type, out of enum, out of
 * the Annex-1 bounds, …). Declared `invalid`; ../cases.test.ts proves Ajv agrees.
 */
export function setInvalidValue(pointer: string, value: unknown): PayloadTransform {
  return payloadTransform({
    name: `setInvalidValue(${pointer}, ${JSON.stringify(value)})`,
    targets: ['3.2'],
    schemaOutcome: 'invalid',
    apply: (payload) => {
      setAtPointer(payload, pointer, value);
      return payload;
    },
  });
}

// ── §3.2 violations of the EMS branch's `oneOf`s (1m8) ──────────────────────
//
// The two mutators below exist because the ems branch of the schema constrains
// things the rtmd branch has no analogue for, so no pointer-level mutation
// expresses them: both violations are about a COMBINATION of fields being
// present, not about any one field's value. They are also the shape of Ajv error
// the suite had never produced — a failed `oneOf` reports every branch's
// complaints at once, unlike the single `required`/`maximum` errors the rtm cases
// trigger (1m8's second gap).
//
// Both are `invalid` and both THROW when the payload they are handed does not
// have the precondition their invalidity depends on. That is deliberate: a
// declared `schemaOutcome` is only checked against Ajv for whatever the case
// actually materializes, so a mutator silently applied to the wrong baseline
// could turn its declaration into a lie that ../cases.test.ts would report as an
// unhelpful "declared invalid but validated clean". Failing at the point of the
// wrong assumption says what is really wrong.

/** The record pointer prefix of the report these mutators operate on. */
function recordsPointer(reportIndex: number): string {
  return `/data/${reportIndex}/records`;
}

function reportOf(payload: TransmissionPayload, reportIndex: number, name: string) {
  const report = payload.data[reportIndex];
  if (report === undefined) throw new Error(`${name}: /data/${reportIndex} is missing`);
  const records = report.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${name}: /data/${reportIndex}/records is missing or empty`);
  }
  return { report, records: records as Record<string, unknown>[] };
}

/**
 * Add the SOLAR power objects (`DCSV` + `DCCD`) to a record that already carries
 * the MAINS one (`SVA`) — an `ems-record` violation with no rtmd counterpart.
 *
 * WHAT THE SCHEMA SAYS. `$defs/ems-record` carries `allOf[0].oneOf` with a mains
 * branch (`required: [SVA]`, `not: { required: [DCSV, DCCD] }`) and a solar branch
 * (`required: [DCSV, DCCD]`, `not: { required: [SVA] }`). Each branch excludes the
 * other's fields explicitly, so a record carrying all three matches NEITHER — and
 * a `oneOf` is violated by zero matches exactly as it is by two. (One of the pair
 * alone would NOT break it: `DCSV` without `DCCD` leaves the mains branch's `not`
 * unsatisfied and still matches once. Both objects are therefore required to make
 * the mutation bite, which is why this is one transform and not two.)
 *
 * Applied to the FIRST record only by default: one non-conformant record is
 * enough, and leaving the rest conformant keeps the Ajv error set pointed at a
 * single `/data/0/records/0`.
 */
export function addSolarPowerToMainsRecord(
  recordIndex = 0,
  reportIndex = 0,
  values: { DCSV: number; DCCD: number } = { DCSV: 19.2, DCCD: 3.8 },
): PayloadTransform {
  const name = `addSolarPowerToMainsRecord(${reportIndex}/${recordIndex})`;
  return payloadTransform({
    name,
    targets: ['3.2'],
    schemaOutcome: 'invalid',
    apply: (payload) => {
      const { records } = reportOf(payload, reportIndex, name);
      const record = records[recordIndex];
      if (record === undefined) {
        throw new Error(`${name}: ${recordsPointer(reportIndex)}/${recordIndex} is missing`);
      }
      if (record.SVA === undefined) {
        throw new Error(
          `${name}: the record carries no SVA, so adding DCSV+DCCD makes it a CONFORMANT ` +
            `solar record, not a violation — this mutator wants a mains baseline`,
        );
      }
      record.DCSV = values.DCSV;
      record.DCCD = values.DCCD;
      return payload;
    },
  });
}

/**
 * Copy a report's `LSV` and `EMSV` into EVERY record while leaving them on the
 * report — the placement violation, again `ems-report`-only.
 *
 * WHAT THE SCHEMA SAYS. `$defs/ems-report` carries two `oneOf`s of the same shape,
 * one per version string: branch A requires it on the report, branch B requires it
 * on every entry of `records`. Either placement alone matches exactly one branch;
 * BOTH placements match both, and a `oneOf` matched twice is violated. So this is
 * the mirror of {@link addSolarPowerToMainsRecord}'s zero-match violation, and
 * between them the suite sees both ways a `oneOf` can fail.
 *
 * Throws unless the report carries both strings and no record already does —
 * "copy" must mean the report keeps them, or the payload is merely a conformant
 * per-record placement.
 */
export function duplicateVersionStringsIntoRecords(reportIndex = 0): PayloadTransform {
  const name = `duplicateVersionStringsIntoRecords(${reportIndex})`;
  const KEYS = ['LSV', 'EMSV'] as const;
  return payloadTransform({
    name,
    targets: ['3.2'],
    schemaOutcome: 'invalid',
    apply: (payload) => {
      const { report, records } = reportOf(payload, reportIndex, name);
      for (const key of KEYS) {
        if (typeof report[key] !== 'string') {
          throw new Error(
            `${name}: /data/${reportIndex}/${key} is not on the report, so copying it into the ` +
              `records is a conformant per-record placement, not a violation`,
          );
        }
      }
      for (const [i, record] of records.entries()) {
        for (const key of KEYS) {
          if (record[key] !== undefined) {
            throw new Error(
              `${name}: ${recordsPointer(reportIndex)}/${i}/${key} is already set — this payload ` +
                `does not have the single-placement baseline the mutation needs`,
            );
          }
          record[key] = report[key];
        }
      }
      return payload;
    },
  });
}

// ── §3.1 manufacturer-specific data objects ─────────────────────────────────

/** Where a custom data object is added when no pointer is given. */
const DEFAULT_RECORD_POINTER = '/data/0/records/0';

/**
 * Add a manufacturer-specific data object to a record (or to any pointer given).
 *
 * Schema-VALID by design: every relevant `$def` in 0.8.1 carries
 * `additionalProperties: true`, so custom objects sail through Ajv unexamined —
 * which is precisely why §3.1's conditional (declare them via
 * `meta.customDataSchema`) is graded semantically. Undeclared, this is a §3.1
 * fail; paired with {@link declareCustomDataSchema} it is a §3.1 pass.
 */
export function addCustomDataObject(
  key: string,
  value: unknown = 1.5,
  parentPointer: string = DEFAULT_RECORD_POINTER,
): PayloadTransform {
  return payloadTransform({
    name: `addCustomDataObject(${key})`,
    targets: ['3.1'],
    apply: (payload) => {
      setAtPointer(payload, `${parentPointer}/${escapePointerToken(key)}`, value);
      return payload;
    },
  });
}

/**
 * Declare `meta.customDataSchema` (by reference, or inline when handed an
 * object). Discharges the §3.1 conditional; unknown to 0.8.1's schema, whose
 * metadata block is `additionalProperties: true`, so it stays schema-valid.
 */
export function declareCustomDataSchema(
  declaration: string | Record<string, unknown>,
): PayloadTransform {
  return payloadTransform({
    name: `declareCustomDataSchema(${typeof declaration === 'string' ? declaration : 'inline'})`,
    targets: ['3.1'],
    apply: (payload) => {
      setAtPointer(payload, '/meta/customDataSchema', declaration);
      return payload;
    },
  });
}

// ── §3.4 reading cadence ────────────────────────────────────────────────────

/** Format epoch-ms as the compact `YYYYMMDDThhmmssZ` ABST form. */
function formatAbst(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Replace a report's `records` with clones of its FIRST record, stamped at the
 * given minute offsets from that record's own `ABST`. The shared engine behind
 * {@link regularCadence} / {@link irregularCadence}: cloning the baseline record
 * keeps every other field schema-valid, so only the cadence varies.
 */
function withCadence(
  name: string,
  targets: readonly string[],
  offsetsMinutes: readonly number[],
  reportIndex: number,
): PayloadTransform {
  return payloadTransform({
    name,
    targets,
    apply: (payload) => {
      const report = payload.data[reportIndex];
      const records = report?.records;
      const first = Array.isArray(records) ? (records[0] as Record<string, unknown>) : undefined;
      if (first === undefined) {
        throw new Error(`${name}: /data/${reportIndex}/records/0 is missing`);
      }
      const start = parseAbst(first.ABST);
      if (start === null) {
        throw new Error(`${name}: /data/${reportIndex}/records/0/ABST is not a parseable ABST`);
      }
      const stamped = offsetsMinutes.map((minutes) => ({
        ...structuredClone(first),
        ABST: formatAbst(start + minutes * 60_000),
      }));
      setAtPointer(payload, `/data/${reportIndex}/records`, stamped);
      return payload;
    },
  });
}

/**
 * A regular reading cadence: `count` records spaced `everyMinutes` apart. The
 * §3.4 interval check grades the coefficient of variation of consecutive
 * intervals, so an evenly spaced series is a §3.4 pass (CV 0).
 */
export function regularCadence(
  count: number,
  everyMinutes: number,
  reportIndex = 0,
): PayloadTransform {
  const offsets = Array.from({ length: count }, (_, i) => i * everyMinutes);
  return withCadence(`regularCadence(${count}×${everyMinutes}min)`, ['3.4'], offsets, reportIndex);
}

/**
 * An irregular reading cadence from explicit minute offsets — a §3.4 fail once
 * the interval CV clears the check's 25% tolerance. Still schema-valid: §3.4 is
 * a heuristic over well-formed timestamps, not a schema violation.
 */
export function irregularCadence(
  offsetsMinutes: readonly number[],
  reportIndex = 0,
): PayloadTransform {
  return withCadence(
    `irregularCadence(${offsetsMinutes.join(',')})`,
    ['3.4'],
    offsetsMinutes,
    reportIndex,
  );
}
