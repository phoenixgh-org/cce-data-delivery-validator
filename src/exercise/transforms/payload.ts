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

// ── §1.4 wire size ──────────────────────────────────────────────────────────

/**
 * The §1.4 cap, in bytes. Mirrors `MAX_WIRE_BYTES` in src/ingest/stages/size.ts,
 * which is the authority; restated here rather than imported because the exercise
 * vocabulary describes what a SUPPLIER sends and must keep working if the stage's
 * own constant ever moves — a padder that tracked the stage automatically would
 * make the at-cap case unfalsifiable.
 */
const WIRE_CAP_BYTES = 1_048_576;

/**
 * Pad the payload with free text until its serialization is EXACTLY
 * `targetBytes` — 1MB by default, the §1.4 cap (b0i).
 *
 * The suite already sends a comfortable pass (a few hundred bytes) and a
 * one-byte-over fail. This is the third point that matters: the boundary itself,
 * end to end, through undici, Fastify's own 2MB `bodyLimit` and the `*` raw-body
 * parser before src/ingest/stages/size.ts measures `ctx.rawBody.length` against
 * `wireBytes > MAX_WIRE_BYTES`. Exactly at the cap is a §1.4 PASS.
 *
 * WHY `FNAM`. It is an Annex 1 data object — Facility Name — declared on
 * `rtmd-report` as `["string","null"]` with no `maxLength`, `pattern` or `enum`,
 * and absent from the rtm baseline. Three properties earn it the job:
 *
 *   - It is a KNOWN DS01 code, so src/ingest/stages/semantic/custom-schema.ts
 *     classifies it as a DS01 object, never CUSTOM, and the §3.1 conditional
 *     stays silent. An unknown key would be CUSTOM by elimination and, with no
 *     `meta.customDataSchema` declared, would raise a §3.1 FAIL — a stray finding
 *     on a case that is supposed to prove one thing about size.
 *   - It is FREE TEXT with no length bound, so a megabyte of it is schema-valid
 *     under both registered versions rather than a §3.2 violation.
 *   - It is semantically HARMLESS: a facility name is read by nothing else in the
 *     pipeline, so no semantic check changes its mind about the payload.
 *
 * `meta` is not an option: its properties are enumerated, so padding there means
 * inventing a key.
 *
 * HOW THE COUNT IS EXACT. The field is set to the empty string first and the
 * payload serialized once to measure; the difference is then filled with ASCII
 * `A`s, which JSON never escapes and UTF-8 encodes one byte per character, so the
 * serialization grows by exactly the number of characters added. The key keeps
 * its insertion position across the two writes, so nothing else about the
 * serialization moves.
 *
 * ORDERING — DO NOT COMPOSE WITH A TRANSPORT WRAPPER. Payload mutators run BEFORE
 * serialization and transport wrappers operate on the serialized bytes
 * (../case.ts `materializePost`), so `gzip()` after this padder would send about
 * a kilobyte of compressed `A`s and the size stage would measure THAT. The at-cap
 * case sends the body uncompressed on purpose: the §1.4 cap is measured on the
 * wire bytes, after any content-encoding, so only an unencoded body puts a known
 * number in front of the stage.
 */
export function padToWireCap(targetBytes = WIRE_CAP_BYTES, reportIndex = 0): PayloadTransform {
  const name = `padToWireCap(${targetBytes}: ${reportIndex}/FNAM)`;
  return payloadTransform({
    name,
    targets: ['1.4'],
    apply: (payload) => {
      if (payload.data[reportIndex] === undefined) {
        throw new Error(`${name}: /data/${reportIndex} is missing`);
      }
      const pointer = `/data/${reportIndex}/FNAM`;
      setAtPointer(payload, pointer, '');
      const withoutPadding = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      const fill = targetBytes - withoutPadding;
      if (fill < 0) {
        throw new Error(
          `${name}: the payload is already ${withoutPadding} bytes, past the ${targetBytes}-byte target`,
        );
      }
      setAtPointer(payload, pointer, 'A'.repeat(fill));
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

// ── advisory-provoking payloads (adv.*) ─────────────────────────────────────
//
// A mutator here produces a payload that is fully schema-VALID and fully
// requirement-conformant, and still gives the receiving country something to
// observe. That is the whole shape of the Advisories category
// (src/ingest/stages/semantic/advisory.ts): an advisory can never move a §7
// requirement's status, so a case built on one of these expects a 200, an `info`
// finding under an `adv.*` id, and no fail anywhere.
//
// `targets` stays EMPTY on these. It lists COMPLIANCE_MATRIX ids and an advisory
// id is not one — the coverage join reads §7 rows only. A case names the advisory
// in its `expectedFindings` instead (../cases/payload.ts).
//
// SOME OF THEM PROVOKE SILENCE INSTEAD (496w). Each advisory's header documents a
// population it deliberately says nothing about — solar records for the
// compressor/supply arithmetic, an explained null, a series under the padding
// floor — and since a case can now declare `absentFindings`, those rules are
// exercisable too. A silence mutator sits BESIDE the firing one it is the
// counterpart of, and puts the check's trigger in place while withholding the one
// thing the check reads last, so the silence is the rule rather than a payload
// that was never close to firing: {@link solarPoweredRecords} carries a
// full-period CMPR, {@link explainedNullRuntimeDuringOutage} keeps SVA 0 beside
// the null, {@link nullTemperatureWithErrorCode} sends the null reading.

/**
 * Write a production date in a form other than ISO-8601's `YYYY-MM-DD` — e.g.
 * `2026-7-4` at `/data/0/ADOP` — which is what `adv.date_format` observes.
 *
 * Schema-VALID by design, and that is the point: cce-interop-0.8.1 declares the
 * DS01 date objects (ADOP, LDOP, EDOP, CDAT, CDAT2) as bare strings with no
 * `format` and no `pattern`, so Ajv accepts any text at all. ../cases.test.ts
 * runs the materialized payload through the real validator, so this declaration
 * is checked rather than asserted: if a future schema learns to express dates,
 * this stops being `valid` and the case fails in CI instead of live.
 */
export function setNonIsoDate(pointer: string, value: string): PayloadTransform {
  return payloadTransform({
    name: `setNonIsoDate(${pointer}, ${value})`,
    apply: (payload) => {
      setAtPointer(payload, pointer, value);
      return payload;
    },
  });
}

/**
 * Swap the `ABST` of two records inside one report, leaving every other field
 * where it was — so the same readings arrive in an order that steps BACKWARDS,
 * which is what `adv.time_not_increasing` observes.
 *
 * Schema-VALID by design, and again that is the point: `ABST` carries a
 * `pattern` per VALUE and the schema has no vocabulary for a value's
 * relationship to its neighbours, so a swapped pair validates exactly like the
 * baseline. Nothing else notices either — §3.4's interval check sorts the
 * timestamps before grading cadence (src/ingest/stages/semantic/interval.ts), so
 * this payload keeps its §3.4 pass and the advisory is the ONLY thing the
 * session shows for it.
 *
 * Swapping rather than re-stamping is deliberate: it holds the set of readings
 * and their spacing constant, so the case varies order and nothing else.
 */
export function swapRecordTimestamps(
  indexA: number,
  indexB: number,
  reportIndex = 0,
): PayloadTransform {
  const name = `swapRecordTimestamps(${reportIndex}: ${indexA} ↔ ${indexB})`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const records = payload.data[reportIndex]?.records;
      const a = Array.isArray(records) ? (records[indexA] as Record<string, unknown>) : undefined;
      const b = Array.isArray(records) ? (records[indexB] as Record<string, unknown>) : undefined;
      if (a === undefined || b === undefined) {
        throw new Error(`${name}: /data/${reportIndex}/records is shorter than the swap needs`);
      }
      const held = a.ABST;
      a.ABST = b.ABST;
      b.ABST = held;
      return payload;
    },
  });
}

/**
 * Set one MAINS EMS record's `CMPR` and `SVA` so the compressor runtime runs
 * past the supply availability the same record reports — which is what
 * `adv.compressor_exceeds_supply` observes.
 *
 * Schema-VALID by design, and that is the point: `CMPR` and `SVA` are each
 * bounded 0..900 independently, and the schema has no vocabulary for one
 * property's relationship to another in the same record, so `CMPR: 420` beside
 * `SVA: 200` validates exactly like the baseline. Both values stay inside those
 * bounds so the case varies the RELATIONSHIP and nothing else.
 *
 * EMS-only by construction: it writes `SVA`, which lives on the mains branch of
 * `ems-record.allOf[0]`, so a case using it declares `emsBaseline`.
 */
export function setCompressorAboveSupply(
  runtimeSeconds: number,
  supplySeconds: number,
  recordIndex = 0,
  reportIndex = 0,
): PayloadTransform {
  const name = `setCompressorAboveSupply(${reportIndex}/${recordIndex}: CMPR ${runtimeSeconds} > SVA ${supplySeconds})`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const records = payload.data[reportIndex]?.records;
      const record = Array.isArray(records)
        ? (records[recordIndex] as Record<string, unknown> | undefined)
        : undefined;
      if (record === undefined) {
        throw new Error(`${name}: /data/${reportIndex}/records/${recordIndex} is missing`);
      }
      record.CMPR = runtimeSeconds;
      record.SVA = supplySeconds;
      return payload;
    },
  });
}

/**
 * Convert a mains EMS report to a SOLAR one — drop `SVA` from every record and
 * give each the DC pair (`DCSV` + `DCCD`) instead — and put a full-period
 * compressor runtime on one of them, which is the payload
 * `adv.compressor_exceeds_supply` must stay SILENT on (496w).
 *
 * Schema-VALID by design, and the validity is the whole case. `ems-record`'s
 * `allOf[0]` is an exclusive `oneOf` between a mains branch (`required: [SVA]`,
 * `not: { required: [DCSV, DCCD] }`) and a solar one (`required: [DCSV, DCCD]`,
 * `not: { required: [SVA] }`), so a record carrying the DC pair and no `SVA`
 * matches the solar branch exactly once. `DCSV` is bounded 0..999.9 and `DCCD`
 * 0..99.9 in the shared `$defs`, and the defaults sit inside both. The Annex 4
 * draft carries the same partition unchanged. ../cases.test.ts runs the
 * materialized payload through the real validator, so this is checked rather
 * than asserted.
 *
 * THE CONVERSION IS EVERY RECORD, not one. The `oneOf` is per record, so a
 * report with one solar record among mains ones is still a conformant mixture
 * and the check would simply grade the records that kept their `SVA` — which is
 * not the silence the case is about.
 *
 * THE SKIP IS UNCONDITIONAL IN `CMPR` (vxt9). The check selects mains records by
 * the PRESENCE of `SVA` and `continue`s past a solar one before it reads a runtime
 * at all, so no compressor value would make this payload speak: `DCSV` is a
 * VOLTAGE and nothing on the branch substitutes for the supply duration
 * (src/ingest/stages/semantic/compressor-supply.ts, "SOLAR RECORDS ARE OUT OF
 * SCOPE"). The silence is a statement about the branch, not about the number.
 *
 * `CMPR` AT 900 is therefore a property of the VALUE rather than a counterfactual
 * about this payload: 900 s is the schema's own maximum for the object, the
 * longest runtime a 15-minute period can hold. Do not read it as "it would have
 * fired on a mains record" — the check fires only on a STRICT excess
 * (`if (runtime <= supply) continue`), and `emsBaseline` reports `SVA: 900` on
 * every record, so the mains form of this payload would be conformant too. What
 * proves the check fires on the mains branch is the separate fire case built on
 * {@link setCompressorAboveSupply} (CMPR 420 against SVA 200).
 *
 * Contrast {@link addSolarPowerToMainsRecord}, which ADDS the DC pair while
 * leaving `SVA` in place and is therefore a §3.2 violation: this one removes it,
 * which is what makes the record a conformant solar one.
 *
 * EMS-only by construction: the mains/solar partition lives on `ems-record`, so
 * a case using this declares `emsBaseline`. It throws on a report whose records
 * carry no `SVA`, since converting an already-solar report would silently make
 * the case prove nothing.
 */
export function solarPoweredRecords(
  reportIndex = 0,
  values: { DCSV: number; DCCD: number } = { DCSV: 12.6, DCCD: 4.2 },
  runtimeSeconds = 900,
  runtimeRecordIndex = 0,
): PayloadTransform {
  const name = `solarPoweredRecords(${reportIndex}: DCSV=${values.DCSV}, DCCD=${values.DCCD}, records/${runtimeRecordIndex} CMPR=${runtimeSeconds})`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const { records } = reportOf(payload, reportIndex, name);
      for (const [index, record] of records.entries()) {
        if (!('SVA' in record)) {
          throw new Error(
            `${name}: ${recordsPointer(reportIndex)}/${index} carries no SVA, so it is already ` +
              `a solar record — this mutator wants a mains baseline`,
          );
        }
        delete record.SVA;
        record.DCSV = values.DCSV;
        record.DCCD = values.DCCD;
      }
      const record = records[runtimeRecordIndex];
      if (record === undefined) {
        throw new Error(`${name}: ${recordsPointer(reportIndex)}/${runtimeRecordIndex} is missing`);
      }
      record.CMPR = runtimeSeconds;
      return payload;
    },
  });
}

/**
 * Replace a report's `records` with `count` minutes-shaped ones: clones of the
 * first record stamped at 15-minute intervals, each carrying a `CMPR` at or
 * below 15, at least one above 0, and several at exactly 15 while `SVA` stays at
 * the baseline's 900 — which is what `adv.cmpr_minutes` observes.
 *
 * SYNTHESIZING RECORDS IS THE POINT. The advisory needs at least
 * `MIN_RECORDS` (12) readings before a ceiling says anything, and the EMS
 * baseline is 3 records; extending the series here is what keeps that floor
 * where the check set it instead of weakening it to fit a fixture.
 *
 * Schema-VALID by design, and that is the whole gap the advisory covers: the
 * pre-0.8.0 correction WIDENED CMPR from `maximum: 15` (minutes) to
 * `maximum: 900` (seconds), so every minutes value is a legal seconds value and
 * a minutes-valued feed validates cleanly on a 0.8.x envelope. ../cases.test.ts
 * runs the materialized payload through the real validator, so this declaration
 * is checked rather than asserted.
 *
 * The 15-minute stamping keeps §3.4's cadence pass intact (CV 0), and CMPR stays
 * far below `SVA`, so `adv.compressor_exceeds_supply` stays silent — the two
 * CMPR advisories are complementary, and this case shows one of them alone.
 *
 * EMS-only by construction: `SVA` lives on the mains branch of
 * `ems-record.allOf[0]`, so a case using this declares `emsBaseline`.
 */
export function setMinutesShapedCompressor(count = 12, reportIndex = 0): PayloadTransform {
  // At or below 15, at least one above 0, and six sitting at exactly 15 — the
  // saturation signature, since the baseline record's SVA is 900.
  const walk = [15, 12, 15, 9, 15, 0, 14, 15, 11, 15, 7, 15];
  const name = `setMinutesShapedCompressor(${reportIndex}: ${count} records)`;
  return payloadTransform({
    name,
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
      const stamped = Array.from({ length: count }, (_, i) => ({
        ...structuredClone(first),
        ABST: formatAbst(start + i * 15 * 60_000),
        CMPR: walk[i % walk.length],
      }));
      setAtPointer(payload, `/data/${reportIndex}/records`, stamped);
      return payload;
    },
  });
}

/**
 * Null the appliance serial on one EMS report and give it a populated `AID` —
 * which is what `adv.null_identity` observes on the ems branch (2km).
 *
 * Schema-VALID by design, and again that is the point: `ems-report` REQUIRES
 * `ASER` but the shared `$defs` types it `["string","null"]`, so the key is
 * satisfied by a null and Ajv has nothing to say. ../cases.test.ts runs the
 * materialized payload through the real validator, so this declaration is
 * checked rather than asserted.
 *
 * The `AID` is the CASE, not scaffolding: it is a programme asset-tracking
 * identifier the employer assigns rather than the serial the appliance's
 * manufacturer programmed, so it is not read as standing in for `ASER` and does
 * not silence the advisory. Before 2km a populated `AID` did silence it, which
 * is exactly why the case plants one.
 */
export function nullApplianceSerial(assetId = 'asset-tag-9', reportIndex = 0): PayloadTransform {
  return payloadTransform({
    name: `nullApplianceSerial(${reportIndex}, AID=${assetId})`,
    apply: (payload) => {
      setAtPointer(payload, `/data/${reportIndex}/ASER`, null);
      setAtPointer(payload, `/data/${reportIndex}/AID`, assetId);
      return payload;
    },
  });
}

/**
 * Re-stamp a report's readings onto a cadence WIDER than DS01's 15-minute
 * sampling period — `count` records spaced `everyMinutes` apart, hourly by
 * default — which is what `adv.sample_gap` observes.
 *
 * Schema-VALID by design, and that is the point: `ABST` carries a `pattern` per
 * VALUE and the schema has no vocabulary for how far apart two values sit, so an
 * hourly series validates exactly like the quarter-hourly baseline.
 *
 * REGULAR ON PURPOSE, and this is the case rather than scaffolding. §3.4 grades
 * the coefficient of variation of the intervals, which is scale-free BY DESIGN
 * (src/ingest/stages/semantic/interval.ts), so an evenly spaced hourly series
 * scores CV 0 and keeps its §3.4 PASS while every one of its periods is four
 * times the one the accumulators are defined over. The advisory is the only
 * thing the session shows for it — which is exactly why agj.6 put the absolute
 * cap in its own check instead of tightening §3.4.
 *
 * Built on the same `withCadence` engine as {@link regularCadence}, so every
 * other field is a clone of the baseline record and only the spacing varies. It
 * declares NO targets: `adv.sample_gap` is not a COMPLIANCE_MATRIX id, and the
 * §3.4 pass this payload keeps is not something the case is claiming to exercise.
 */
export function longSamplePeriod(count = 4, everyMinutes = 60, reportIndex = 0): PayloadTransform {
  const offsets = Array.from({ length: count }, (_, i) => i * everyMinutes);
  return withCadence(`longSamplePeriod(${count}×${everyMinutes}min)`, [], offsets, reportIndex);
}

/**
 * Append a deep clone of one of a report's records to the END of that report's
 * `records` array, so the same reading is delivered twice inside one
 * transmission — which is what `adv.duplicate_records` observes.
 *
 * PQS's shape in miniature: "a chunk of records were placed at the end of the
 * previous data file", which leaves the file carrying records it already had and
 * a series that stops stepping forward at the join. Cloning rather than
 * synthesizing is what makes the copy IDENTICAL IN FULL — the stronger of the two
 * signals the advisory distinguishes — and the shared `ABST` raises the weaker
 * one at the same time.
 *
 * Schema-VALID by design, and that is the point: each record is validated against
 * `ems-record`/`rtmd-record` on its own and the schema has no vocabulary for a
 * record's relationship to its siblings, so a repeated record validates exactly
 * like the baseline. §1.8 does not see it either — ./duplicate.ts compares the
 * sha256 of the whole body and `meta.transferId` against EARLIER transmissions,
 * both properties of the envelope, so a payload that repeats a record inside
 * itself is byte-novel and keeps its §1.8 pass (that is the gap agj.8 covers).
 *
 * On the single-record rtm baseline the result is a two-record report, which also
 * keeps §3.4's cadence pass intact: a repeat contributes an interval of ZERO to
 * the sorted series, and one interval has no spread for §3.4 to grade. The
 * advisories are the only thing the session shows for this payload.
 */
export function repeatRecord(index = 0, reportIndex = 0): PayloadTransform {
  const name = `repeatRecord(${reportIndex}: records/${index})`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const records = payload.data[reportIndex]?.records;
      const source = Array.isArray(records) ? (records[index] as unknown) : undefined;
      if (source === undefined) {
        throw new Error(`${name}: /data/${reportIndex}/records/${index} is missing`);
      }
      (records as unknown[]).push(structuredClone(source));
      return payload;
    },
  });
}

/**
 * Blank two of the administrative objects `ems-report` REQUIRES — one nullable
 * one set to `null`, one non-nullable one set to the empty string — which is
 * what `adv.blank_admin` observes.
 *
 * Schema-VALID by design, and both halves are the case rather than scaffolding.
 * `AMFR` is typed `["string","null"]` in the shared `$defs`, so the key is
 * satisfied by a null. `LMOD` is typed `["string"]` — null and absent are §3.2
 * failures there — but it carries no `minLength`, so `""` satisfies it. Between
 * them they cover both halves of the advisory's conformant surface in one
 * payload, and ../cases.test.ts runs the materialized payload through the real
 * validator, so this declaration is checked rather than asserted.
 *
 * ASER IS DELIBERATELY LEFT POPULATED. The identity trio belongs to
 * `adv.null_identity` (2km, 38p) and is not read by this advisory at all, so a
 * blanked ASER would raise a second, unrelated finding and blur what the case
 * proves.
 */
export function blankAdminObjects(reportIndex = 0): PayloadTransform {
  return payloadTransform({
    name: `blankAdminObjects(${reportIndex}: AMFR=null, LMOD="")`,
    apply: (payload) => {
      setAtPointer(payload, `/data/${reportIndex}/AMFR`, null);
      setAtPointer(payload, `/data/${reportIndex}/LMOD`, '');
      return payload;
    },
  });
}

/**
 * Null the vaccine compartment temperature on one RTMD record and null its EERR
 * — which is what `adv.unexplained_null_temp` observes on the rtm branch (agj.2).
 *
 * Schema-VALID by design, and that is the point: `rtmd-record` types TVC
 * `["number","null"]`, requires EERR as `["string","null"]`, and carries NO
 * `allOf` tying the two together, so a reading that did not arrive and an error
 * code that does not explain it both satisfy the branch. `ems-record` is the
 * opposite — its `allOf` requires a `minLength`-1 LERR beside a null TVC in both
 * registered versions — which is why this transform is rtm-only and the case
 * that uses it takes the DEFAULT (rtm) baseline. ../cases.test.ts runs the
 * materialized payload through the real validator, so this declaration is
 * checked rather than asserted.
 *
 * BOTH MUTATIONS ARE THE CASE. The rtm baseline record sends `EERR: "none"` —
 * a non-empty string, which the check reads as an explanation and stays quiet
 * for — so nulling TVC alone would prove nothing. The record carries no LERR to
 * begin with, so nothing else has to be cleared.
 *
 * On the single-record rtm baseline `adv.null_padding` stays silent: it needs at
 * least twelve records before it will call a column padded. On a longer series
 * both would fire, and neither is suppressed for the other — see the header of
 * src/ingest/stages/semantic/unexplained-null-temp.ts.
 */
export function unexplainedNullTemperature(recordIndex = 0, reportIndex = 0): PayloadTransform {
  return payloadTransform({
    name: `unexplainedNullTemperature(${reportIndex}: records/${recordIndex} TVC=null, EERR=null)`,
    apply: (payload) => {
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/TVC`, null);
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/EERR`, null);
      return payload;
    },
  });
}

/**
 * Null the vaccine compartment temperature on one RTMD record and LEAVE the
 * baseline's `EERR` in place — the payload `adv.unexplained_null_temp` must stay
 * SILENT on (496w).
 *
 * The SIBLING of {@link unexplainedNullTemperature}, differing in the one
 * mutation that transform makes second: the rtm baseline record sends
 * `EERR: "none"`, a non-empty string the check reads as an explanation and stays
 * quiet for. The check does not interpret the vocabulary — it asks only whether
 * a code is present and non-blank, and deciding that `"none"` is a placeholder
 * rather than a real code would be a judgement the receiving side cannot make
 * (src/ingest/stages/semantic/unexplained-null-temp.ts). So this transform nulls
 * TVC and nothing else, and the silence it earns is the check's documented rule
 * rather than an accident of the fixture.
 *
 * Schema-VALID by design, and that is the point: `rtmd-record` types TVC
 * `["number","null"]` and carries NO `allOf` tying it to anything, so a null
 * reading satisfies the branch on its own — which is exactly why the advisory
 * exists on this branch and the schema cannot be asked to do its job.
 * ../cases.test.ts runs the materialized payload through the real validator, so
 * this declaration is checked rather than asserted.
 *
 * RTM-only by construction, exactly as its sibling is: on `ems-record` a null
 * TVC needs a `minLength`-1 `LERR` beside it or the record is a §3.2 rejection
 * ({@link explainedNullTemperature} is the EMS form). It throws when the record
 * carries no non-blank `EERR`, since without one the payload would fire the
 * advisory and the case would assert the opposite of what it says.
 */
export function nullTemperatureWithErrorCode(recordIndex = 0, reportIndex = 0): PayloadTransform {
  const name = `nullTemperatureWithErrorCode(${reportIndex}: records/${recordIndex} TVC=null, EERR kept)`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const { records } = reportOf(payload, reportIndex, name);
      const record = records[recordIndex];
      if (record === undefined) {
        throw new Error(`${name}: ${recordsPointer(reportIndex)}/${recordIndex} is missing`);
      }
      const code = record.EERR;
      if (typeof code !== 'string' || code.trim() === '') {
        throw new Error(
          `${name}: the record carries no non-blank EERR, so a null TVC would be an ` +
            `UNEXPLAINED one — this mutator wants a baseline that already sends a code`,
        );
      }
      record.TVC = null;
      return payload;
    },
  });
}

/**
 * Take the AC supply to zero on one EMS record and null that record's compressor
 * runtime — which is what `adv.null_accumulator` observes (agj.9).
 *
 * Schema-VALID by design, and that is the point: `ems-record` types SVA and CMPR
 * alike as `["number","null"]` bounded 0..900, and the only record-level rule
 * either takes part in is the mains/solar `oneOf`, which asks for SVA's PRESENCE
 * and nothing about its value. The 0.8.x lineage ties a null reading to an
 * explanation for TVC ONLY, so a null CMPR beside null LERR and EERR satisfies
 * the branch. ../cases.test.ts runs the materialized payload through the real
 * validator, so this declaration is checked rather than asserted.
 *
 * BOTH MUTATIONS ARE THE CASE. The advisory reads the correlated form: SVA 0
 * says the period carried no AC supply, so the compressor could not have run and
 * its runtime for that period is a known 0. A null CMPR on its own is the bare
 * intermittent form the issue defers, and the check stays silent on it.
 *
 * It takes the EMS baseline, whose three records each carry `SVA: 900`, a
 * numeric CMPR (320/285/300) and `LERR: null, EERR: null` — so the null lands
 * unexplained without touching either code, and records 0 and 2 keep the numeric
 * CMPR that makes this null an INTERMITTENT one rather than a padded column
 * (`adv.null_padding` needs twelve records of nulls and stays silent here).
 *
 * THE DS01.3 SHADOW RESTATES IT. The Annex 4 draft requires a non-null LERR
 * beside a null CMPR, so the shadow run records a clause 5.3.2 fail on this
 * payload — measured, and asserted by the case that uses this transform.
 */
export function nullRuntimeDuringOutage(recordIndex = 1, reportIndex = 0): PayloadTransform {
  return payloadTransform({
    name: `nullRuntimeDuringOutage(${reportIndex}: records/${recordIndex} SVA=0, CMPR=null)`,
    apply: (payload) => {
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/SVA`, 0);
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/CMPR`, null);
      return payload;
    },
  });
}

/**
 * Take the AC supply to zero on one EMS record, null that record's compressor
 * runtime, and put a logger error code beside it — the payload
 * `adv.null_accumulator` must stay SILENT on (496w).
 *
 * The SIBLING of {@link nullRuntimeDuringOutage}, differing in the one field the
 * check reads last: it stays quiet when `LERR` or `EERR` carries a non-empty
 * string, because a null beside a populated code is an EXPLAINED null — the
 * device said why the accumulator is missing, which is the behaviour the
 * supplier is entitled to (src/ingest/stages/semantic/null-accumulator.ts). With
 * `SVA: 0` and `CMPR: null` the payload is otherwise the correlated form that
 * check exists for, so the code is the only thing standing between the case and
 * an advisory.
 *
 * Schema-VALID by design, and under BOTH lineages (measured). `ems-record` types
 * `SVA` and `CMPR` alike `["number","null"]`, and the record-level `oneOf` it
 * takes part in is the TVC/LERR one: the NORMAL branch requires a numeric `TVC`
 * and says nothing about `LERR`, so a populated `LERR` beside the baseline's
 * numeric `TVC` still matches exactly one branch. The Annex 4 draft goes
 * further and REQUIRES a non-null `LERR` beside a null `CMPR`, so this payload —
 * unlike {@link nullRuntimeDuringOutage}'s — satisfies the draft as well, and
 * the shadow run has nothing to add. ../cases.test.ts runs the materialized
 * payload through the real validator, so the contract half is checked rather
 * than asserted.
 *
 * EMS-only by construction, exactly as its sibling is: `SVA` lives on the mains
 * branch of `ems-record.allOf[0]`, so a case using this declares `emsBaseline`.
 */
export function explainedNullRuntimeDuringOutage(
  recordIndex = 1,
  reportIndex = 0,
  code = 'E7',
): PayloadTransform {
  const name = `explainedNullRuntimeDuringOutage(${reportIndex}: records/${recordIndex} SVA=0, CMPR=null, LERR="${code}")`;
  return payloadTransform({
    name,
    apply: (payload) => {
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/SVA`, 0);
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/CMPR`, null);
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/LERR`, code);
      return payload;
    },
  });
}

/**
 * Shorten the appliance monitoring ID on one RTMD report to three characters —
 * which is what `adv.short_identifier` observes (krh).
 *
 * Schema-VALID by design, and that is the point: `rtmd-report` types AMID a
 * required non-null `string` and no identifier object on either branch carries a
 * `minLength` in the registered `cce-interop` versions, so a one-character value
 * satisfies the branch. ../cases.test.ts runs the materialized payload through
 * the real validator, so this declaration is checked rather than asserted.
 *
 * THE VALUE STAYS NON-BLANK, deliberately. A blank AMID belongs to
 * `adv.null_identity` (the trimmed length is zero, and short-identifier.ts never
 * reads a blank), so blanking it would raise a different, unrelated finding and
 * blur what the case proves. `"A1B"` is three characters of content — the
 * sharpest value the advisory still speaks to, since it observes one to three.
 *
 * It takes the DEFAULT (rtm) baseline, whose other identifiers — ASER, ESER and
 * the lone `DLST.TVC` sensor's SID — are all comfortably longer than the
 * threshold, so AMID is the only value the advisory speaks to.
 */
export function shortApplianceMonitoringId(value = 'A1B', reportIndex = 0): PayloadTransform {
  return payloadTransform({
    name: `shortApplianceMonitoringId(${reportIndex}: AMID="${value}")`,
    apply: (payload) => {
      setAtPointer(payload, `/data/${reportIndex}/AMID`, value);
      return payload;
    },
  });
}

/**
 * Replace a report's `records` with `count` clones of its first record, stamped
 * at 15-minute intervals, with `HAMB` and `HOLD` set to `null` in every one of
 * them — which is what `adv.null_padding` observes (pwd, agj.17).
 *
 * SYNTHESIZING RECORDS IS THE POINT, the same way it is for
 * {@link setMinutesShapedCompressor}. A property qualifies as padded only once
 * at least `MIN_RECORDS` (12, src/ingest/stages/semantic/null-padding.ts)
 * records carried it AND it was null in all of them, and the EMS baseline is 3
 * records — four times under the floor. Extending the series here is what keeps
 * that floor where the check set it instead of weakening it to fit a fixture.
 * The 15-minute stamping is DS01's own sampling period, so the series also keeps
 * §3.4's cadence pass (CV 0) and `adv.sample_gap` stays silent.
 *
 * Schema-VALID by design, and that is the point: the shared `$defs` type both
 * `HAMB` (ambient relative humidity) and `HOLD` (holdover autonomy time) as
 * `["number","null"]`, so a column of nulls satisfies the ems branch. That
 * holds under BOTH registered lineages — `cce-interop` 0.8.0/0.8.1 and the
 * DS01.3 Annex 4 draft — measured against the vendored bytes, and
 * ../cases.test.ts runs the materialized payload through the real validator, so
 * the contract half of it is checked rather than asserted.
 *
 * WHY HAMB AND HOLD, and not some other pair. The choice is constrained from
 * both sides:
 *
 *   - `ALRM`, `EERR` and `LERR` are already null in every baseline record, and
 *     the check EXCLUDES all three: for those three the schema defines `null` as
 *     the value meaning "no condition present", so a healthy device correctly
 *     sends a column of them. Nulling nothing else leaves the advisory silent,
 *     which is why the baseline itself never fires it.
 *   - `TAMB` and `BLOG` are typed a bare `number` under the contract lineage —
 *     a null in either is a §3.2 rejection, not a padded column, so neither can
 *     carry this case. (The Annex 4 draft widens both to `["number","null"]`,
 *     but the contract profile is what grades.)
 *   - `BEMD`, `CMPR` and `DORV` are nullable under the contract, but the Annex 4
 *     draft requires an explaining `EERR`/`LERR` beside a null in each of them
 *     (memory `annex4-ems-record-null-explanations`), so the shadow run would
 *     add a clause 5.3.2 fail. Legal, but it muddies a case about padding.
 *
 * `CMPR` AND `SVA` STAY AT THE BASELINE'S 320 AND 900, unmodified, so the two
 * compressor advisories stay silent: 320 never approaches the 15 that
 * `adv.cmpr_minutes` reads as a minutes-valued feed, and it sits far below the
 * supply `adv.compressor_exceeds_supply` compares it against. Cloning one record
 * leaves every other value at the baseline's too, so padding is the only thing
 * this payload varies.
 *
 * EMS-only by construction: `HOLD` and `SVA` are `ems-record` properties, so a
 * case using this declares `emsBaseline`.
 */
export function nullPaddedSeries(count = 12, reportIndex = 0): PayloadTransform {
  const name = `nullPaddedSeries(${reportIndex}: ${count} records, HAMB=null, HOLD=null)`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const records = payload.data[reportIndex]?.records;
      const first = Array.isArray(records) ? (records[0] as Record<string, unknown>) : undefined;
      if (first === undefined) {
        throw new Error(`${name}: /data/${reportIndex}/records/0 is missing`);
      }
      const start = parseAbst(first.ABST);
      if (start === null) {
        throw new Error(`${name}: /data/${reportIndex}/records/0/ABST is not a parseable ABST`);
      }
      const stamped = Array.from({ length: count }, (_, i) => ({
        ...structuredClone(first),
        ABST: formatAbst(start + i * 15 * 60_000),
        HAMB: null,
        HOLD: null,
      }));
      setAtPointer(payload, `/data/${reportIndex}/records`, stamped);
      return payload;
    },
  });
}

/**
 * Null the vaccine compartment temperature on one EMS record and put a logger
 * error code beside it — the ABNORMAL branch of `ems-record`'s TVC/LERR `oneOf`,
 * and the one place the table exercises a null TVC on the ems branch at all
 * (ftx0).
 *
 * Schema-VALID by design, and the validity is the whole case. `ems-record`
 * carries a record-level `allOf` whose second rule partitions a record two ways:
 * NORMAL (`TVC` present and a number) xor ABNORMAL (`TVC` null, with a `LERR`
 * string of `minLength` 1 naming the fault). Both registered `cce-interop`
 * versions carry it, and the Annex 4 draft keeps it unchanged, so this payload
 * validates under both lineages (measured). `EERR` does NOT satisfy the rule —
 * `LERR` specifically does — which is why this transform writes that one.
 *
 * THE SIBLING IS THE OTHER HALF. `setInvalidValue('/data/0/records/0/TVC', null)`
 * on the same baseline leaves `LERR` at the baseline's `null` and matches NEITHER
 * branch, so Ajv rejects it and the transmission earns a §3.2 fail and a 422.
 * Together the two make a header comment into a measured fact of the live
 * instance: on EMS the schema itself demands the explanation, which is why
 * `adv.unexplained_null_temp` is RTMD-only ({@link unexplainedNullTemperature}
 * takes the rtm baseline for exactly this reason).
 *
 * `adv.null_padding` stays silent on the result: the EMS baseline is 3 records,
 * a quarter of the 12 that check requires before it will call a column padded.
 *
 * EMS-only by construction: the `oneOf` this satisfies lives on `ems-record`, so
 * a case using this declares `emsBaseline`.
 */
export function explainedNullTemperature(recordIndex = 0, reportIndex = 0): PayloadTransform {
  return payloadTransform({
    name: `explainedNullTemperature(${reportIndex}: records/${recordIndex} TVC=null, LERR="E12")`,
    targets: ['3.2'],
    apply: (payload) => {
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/TVC`, null);
      setAtPointer(payload, `/data/${reportIndex}/records/${recordIndex}/LERR`, 'E12');
      return payload;
    },
  });
}

// ── DS01.3 READINESS mutators (meyf) ────────────────────────────────────────
//
// These two exist for the shadow lineage rather than for any advisory: each
// produces a payload the CONTRACT accepts and the unpublished Annex 4 draft
// rejects, which is the whole shape a readiness case is made of (../cases/
// shadow.ts). Both THROW when the field they are pointed at is not there, for
// the reason `dropRequiredField` does: a stale key would otherwise turn the
// mutation into a no-op and leave the case asserting a draft failure against a
// payload the draft is perfectly happy with.

/**
 * Null one data object on one record, touching nothing else — notably NOT the
 * `LERR`/`EERR` codes, which is what makes the resulting null an UNEXPLAINED one.
 *
 * Schema-VALID by design, and the asymmetry between the two lineages is the
 * point. `ems-record` in cce-interop 0.8.x types BEMD, CMPR and DORV as
 * `["number","null"]` and ties a null to an explanation for TVC ALONE, so a null
 * in any of the three satisfies the contract with both codes left null.
 * `rtmd-record` ties nothing to anything at all. The DS01.3 Annex 4 draft adds
 * five explanation rules to `ems-record` — BEMD null requires a non-null EERR;
 * CMPR, DORV, TAMB and BLOG null each require a non-null LERR — and gives
 * `rtmd-record` the BEMD → EERR one (bd memory
 * annex4-ems-record-null-explanations, measured 2026-09-15). So the shadow run
 * records a clause 5.3.2 fail on what the contract graded a §3.2 pass, which is
 * exactly the readiness signal the second run exists to produce.
 *
 * TAMB AND BLOG ARE NOT REACHABLE THIS WAY. The draft names them, but 0.8.1
 * types neither as nullable on `ems-record`, so a null there is a §3.2 rejection
 * under the contract — a 422, not a readiness case. Only BEMD, CMPR and DORV sit
 * in the gap between the two lineages.
 *
 * NULLING AN EXPLANATION CODE IS THE SAME MUTATION, and a case that needs one
 * says so with a second call: the rtm dual-pass fixture sends `EERR: "none"`,
 * which the draft reads as an explanation, so a readiness case on that branch
 * nulls BEMD and EERR both. ../cases.test.ts runs the materialized payload
 * through the real contract validator and ../cases/shadow.test.ts runs it
 * through the real draft one, so neither half of this declaration is asserted
 * rather than checked.
 */
export function nullRecordProperty(
  key: string,
  recordIndex = 0,
  reportIndex = 0,
): PayloadTransform {
  const name = `nullRecordProperty(${key}, ${reportIndex}: records/${recordIndex})`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const { records } = reportOf(payload, reportIndex, name);
      const record = records[recordIndex];
      if (record === undefined) {
        throw new Error(`${name}: ${recordsPointer(reportIndex)}/${recordIndex} is missing`);
      }
      if (!(key in record)) {
        throw new Error(
          `${name}: the record carries no ${key}, so this would ADD a null property rather ` +
            `than blank a reading the baseline sends — a stale key, not a mutation`,
        );
      }
      record[key] = null;
      return payload;
    },
  });
}

/**
 * Deliver ONE report-level administrative object as an empty string.
 *
 * Schema-VALID by design: the shared `$defs` in cce-interop 0.8.x give the admin
 * objects no `minLength`, so `""` satisfies every one of them that accepts a
 * string at all. The DS01.3 Annex 4 draft adds `minLength: 1` to AMFR AMOD APQS
 * LMFR LMOD LPQS LSER EMFR EMOD EPQS ESER and a `YYYY-MM-DD` pattern to ADOP
 * LDOP EDOP (bd memory annex4-tightens-admin-objects, measured 2026-09-15), so
 * the same payload is a clause 5.3.2 failure under the shadow lineage.
 *
 * It also fires `adv.blank_admin` on the contract run, which reads a required
 * admin object arriving blank and says so as an `info` observation — a case built
 * on this expects both, because both are true of the one payload.
 *
 * DISTINCT FROM {@link blankAdminObjects}, which blanks AMFR and LMOD together to
 * cover both halves of that advisory's conformant surface (a null and an empty
 * string) in one payload. A readiness case wants the opposite: one field, one
 * blank state, so the case's docblock states one fact about the draft.
 */
export function blankAdminObject(key: string, reportIndex = 0): PayloadTransform {
  const name = `blankAdminObject(${key}, ${reportIndex}: "")`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const { report } = reportOf(payload, reportIndex, name);
      if (!(key in report)) {
        throw new Error(
          `${name}: /data/${reportIndex} carries no ${key}, so blanking it would ADD a ` +
            `property rather than deliver a required object empty`,
        );
      }
      report[key] = '';
      return payload;
    },
  });
}

/**
 * Deliver an rtmd-report's `AMID` as the EMPTY STRING — the only form of a
 * missing appliance identifier that a CONFORMANT rtm payload can carry, and what
 * `adv.null_identity` observes on the rtm branch (c833).
 *
 * WHY `''` AND NOT `null`. `rtmd-report` requires `AMID` and types it a bare
 * `"string"`, so `null` and an absent key are §3.2 REJECTIONS (422) and never
 * reach the semantic stage at all. The advisory's only surface on an accepted rtm
 * transmission is therefore a blank — empty or whitespace-only — which is
 * precisely the case the schema cannot express: no `minLength` and no `pattern`
 * anywhere in either registered `cce-interop` version
 * (src/ingest/stages/semantic/null-identity.ts). Contrast
 * {@link nullApplianceSerial}, which CAN send a null because `ems-report` types
 * `ASER` `["string","null"]`.
 *
 * Schema-VALID by design on the contract lineage, and ../cases.test.ts runs the
 * materialized payload through the real validator, so that is checked rather than
 * asserted. The DS01.3 Annex 4 draft adds `minLength: 1` to `AMID`, so the same
 * payload is a clause 5.3.2 failure under the shadow lineage (bd memory
 * annex4-proposal-measured-2026-09-12).
 *
 * RTM-ONLY by construction: `AMID` is not a property of `ems-report`, so it
 * refuses a report that does not carry one rather than ADDING a key the branch
 * has no rule about.
 */
export function blankApplianceMonitoringId(value = '', reportIndex = 0): PayloadTransform {
  const name = `blankApplianceMonitoringId(${reportIndex}: AMID="${value}")`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const { report } = reportOf(payload, reportIndex, name);
      if (!('AMID' in report)) {
        throw new Error(
          `${name}: /data/${reportIndex} carries no AMID, so this would ADD a property to a ` +
            `branch that has no rule about it — this mutator wants an rtm baseline`,
        );
      }
      report.AMID = value;
      return payload;
    },
  });
}

/**
 * Deliver ONE report-level administrative object as `null` — the other half of
 * `adv.blank_admin`'s conformant surface, beside {@link blankAdminObject}'s empty
 * string.
 *
 * Schema-VALID by design on the contract lineage: the shared `$defs` type the
 * nullable admin objects `["string","null"]`, so a null satisfies them. WHICH KEY
 * IS PASSED DECIDES THE SHADOW VERDICT, and the caller owns that choice: the
 * DS01.3 Annex 4 draft excludes the null case from 14 of the 15 EMS admin objects
 * and 5 of the 6 RTMD ones, so a null in any of those is a clause 5.3.2 failure.
 * `CID` IS THE EXCEPTION ON BOTH BRANCHES — it stays `["string","null"]` under the
 * draft and gains only `^[A-Z]{2}$` — so a null `CID` validates under both
 * lineages (bd memory annex4-tightens-admin-objects, measured 2026-09-15).
 *
 * Refuses a key the report does not carry, for {@link blankAdminObject}'s reason:
 * adding an absent property would be a stale key rather than a required object
 * delivered blank.
 */
export function nullAdminObject(key: string, reportIndex = 0): PayloadTransform {
  const name = `nullAdminObject(${key}, ${reportIndex}: null)`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const { report } = reportOf(payload, reportIndex, name);
      if (!(key in report)) {
        throw new Error(
          `${name}: /data/${reportIndex} carries no ${key}, so nulling it would ADD a ` +
            `property rather than deliver a required object blank`,
        );
      }
      report[key] = null;
      return payload;
    },
  });
}

/**
 * Deliver an `ems-report`'s `ASER` as a value too SHORT to address a national
 * fleet — the EMS twin of {@link shortApplianceMonitoringId} (c833).
 *
 * Schema-VALID by design, and that is the gap the advisory covers: no identifier
 * object carries a `minLength` or a `pattern` in either registered `cce-interop`
 * version, so a three-character serial validates exactly like a fifteen-character
 * one. The DS01.3 Annex 4 draft does not close it either — it excludes the NULL
 * case from `ems-report`'s `ASER` and adds no length floor — so the payload stays
 * dual-valid and the advisory is the only thing that speaks.
 *
 * THE VALUE STAYS NON-BLANK. A blank `ASER` is `adv.null_identity`'s subject on
 * this branch (src/ingest/stages/semantic/null-identity.ts), so a case built on
 * this one carries a single observation rather than two.
 *
 * EMS-only by construction: `adv.short_identifier` reads `AMID` on the rtm branch
 * and `ASER` on both, but `ems-report` is where `ASER` is REQUIRED, and this
 * refuses a report that does not already carry one.
 */
export function shortApplianceSerial(value = 'A1B', reportIndex = 0): PayloadTransform {
  const name = `shortApplianceSerial(${reportIndex}: ASER="${value}")`;
  return payloadTransform({
    name,
    apply: (payload) => {
      const { report } = reportOf(payload, reportIndex, name);
      if (!('ASER' in report)) {
        throw new Error(
          `${name}: /data/${reportIndex} carries no ASER, so this would ADD a property rather ` +
            `than shorten an identifier the baseline sends`,
        );
      }
      report.ASER = value;
      return payload;
    },
  });
}

/**
 * Append a SECOND report to the transmission — a deep clone of `reportIndex`
 * given its own identity and its own reading window — so the batch carries two
 * distinct pieces of equipment (c833).
 *
 * WHY THE SUITE NEEDS ONE. Every other case in the table sends a single report,
 * so the per-report counting the report-level advisories do has never run live:
 * `adv.null_identity`, `adv.blank_admin` and `adv.short_identifier` each phrase
 * their observation as "N of M reports ... in the first, ..." and the plural
 * branch of that sentence was reachable only from a unit test.
 *
 * THE SHAPE MIRRORS src/ingest/stages/semantic/multi-report.test.ts, which is
 * where the constraints are documented:
 *
 *   - DISTINCT IDENTITY on the clone (`AMID`, `ESER` and every `DLST.<prop>.SID`
 *     on rtm; `ASER`, `ESER` and `LSER` on ems), each suffixed `-2`. Two reports
 *     naming the same equipment would be a batch of one CCE sent twice, which is
 *     a different payload with different meaning.
 *   - THE WINDOW MOVES 24 HOURS EARLIER on every record. The record-series checks
 *     — §3.4's cadence, `adv.time_not_increasing`, `adv.sample_gap`,
 *     `adv.duplicate_records` — are scoped per report, and a day's separation
 *     keeps the two windows from reading as one interleaved series should that
 *     scoping ever be loosened. Shifting rather than re-stamping also leaves each
 *     report's INTERNAL cadence exactly as it was.
 *
 * The suffixes keep every identifier well past `adv.short_identifier`'s
 * four-character floor, so appending a report raises nothing by itself.
 *
 * Schema-VALID by design and BRANCH-AGNOSTIC: `data` is an array of reports on
 * both branches with no `maxItems`, and the clone is the baseline report with a
 * handful of string values changed. ../cases.test.ts runs the materialized
 * payload through the real validator, so that is checked rather than asserted.
 */
export function appendSecondReport(reportIndex = 0): PayloadTransform {
  const name = `appendSecondReport(from ${reportIndex}: identity suffixed -2, window 24h earlier)`;
  const DAY_MS = 24 * 60 * 60 * 1000;
  return payloadTransform({
    name,
    apply: (payload) => {
      const { report, records } = reportOf(payload, reportIndex, name);
      const clone = structuredClone(report) as Record<string, unknown>;

      // Identity: whichever of the branch's identifiers the source report carries.
      // Both branches are covered by one list because a key the report does not
      // have is simply skipped — an `ems-report` has no AMID, an `rtmd-report` no
      // LSER, and neither needs a special case here.
      for (const key of ['AMID', 'ASER', 'ESER', 'LSER']) {
        const value = clone[key];
        if (typeof value === 'string' && value.trim() !== '') clone[key] = `${value}-2`;
      }
      const sensors = clone.DLST;
      if (typeof sensors === 'object' && sensors !== null && !Array.isArray(sensors)) {
        for (const sensor of Object.values(sensors as Record<string, unknown>)) {
          if (typeof sensor !== 'object' || sensor === null || Array.isArray(sensor)) continue;
          const entry = sensor as Record<string, unknown>;
          const sid = entry.SID;
          if (typeof sid === 'string' && sid.trim() !== '') entry.SID = `${sid}-2`;
        }
      }

      // The window: every record a day earlier, the internal cadence untouched.
      const cloned = structuredClone(records) as Record<string, unknown>[];
      for (const [index, record] of cloned.entries()) {
        const at = parseAbst(record.ABST);
        if (at === null) {
          throw new Error(
            `${name}: ${recordsPointer(reportIndex)}/${index}/ABST is not a parseable ABST`,
          );
        }
        record.ABST = formatAbst(at - DAY_MS);
      }
      clone.records = cloned;

      payload.data.push(clone);
      return payload;
    },
  });
}
