/**
 * ADVISORY — `adv.unexplained_null_temp`: a record whose vaccine compartment
 * temperature arrived as `null` with nothing beside it that accounts for the gap
 * (owning issues: agj.2 for the RTMD arm, xwgr for the EMS one; epic agj).
 *
 * The motivating case is PQS's own list of common EMS data issues: "Records with
 * null values in TVC and null values in LERR/EERR. If the system can't get a
 * temperature value, that suggests an error condition." A reading the device
 * could not take is a fact worth recording; a reading the device could not take
 * AND could not account for leaves the country holding a gap it cannot name.
 *
 * This is an ADVISORY, never a verdict: it emits `severity: 'info'` under the
 * `adv.*` namespace through {@link advisory}, so it provably cannot move any §7
 * requirement's pass/fail status (see advisory.ts's header for how that is
 * enforced rather than merely intended).
 *
 * ── TWO ARMS, AND WHY THE EMS ONE IS SO NARROW ───────────────────────────────
 * The two report branches are graded differently because the schema holds
 * different ground on each.
 *
 * `ems-record` carries a record-level `allOf` whose second `oneOf` is exactly
 * this rule, in BOTH REGISTERED `cce-interop` VERSIONS (0.8.0 and 0.8.1) and in
 * the DS01.3 Annex 4 draft:
 *
 *   NORMAL CASE    required [TVC], TVC `type: "number"`
 *   ABNORMAL CASE  required [TVC, LERR], TVC `type: "null"`,
 *                  LERR `type: "string"` with `minLength: 1`
 *
 * So on EMS a null TVC beside an ABSENT, `null`, or EMPTY-STRING LERR is a §3.2
 * SCHEMA FAILURE: stage 7 halts 422 and stage 8 never runs. Those three cases
 * stay the schema's, and this module says nothing about them — an advisory there
 * would duplicate Ajv and put an `info` finding on a payload already failing.
 *
 * `minLength: 1` counts CHARACTERS, not content, so `"   "` satisfies it. An EMS
 * record can therefore carry `TVC: null` beside a logger error code of blank
 * space, validate cleanly, reach stage 8, and leave the country holding the same
 * unnamed gap the rtm branch produces. Measured 2026-09-18 with Ajv through the
 * real registry, on all three registered entries (0.8.0, 0.8.1, and the DS01.3
 * Annex 4 draft as `'1'`), which agree:
 *
 *   ems TVC:null LERR:null     -> invalid (§3.2)
 *   ems TVC:null LERR:""       -> invalid (§3.2)
 *   ems TVC:null LERR:"   "    -> VALID
 *   ems TVC:null LERR:"\t\n"   -> VALID
 *   ems TVC:null LERR:"L1"     -> VALID, and explained
 *
 * THE EMS ARM IS THAT GAP AND NOTHING ELSE (xwgr): TVC PRESENT and `null`, with
 * a LERR that is PRESENT, a string, NON-EMPTY, and blank after `trim()`. EERR is
 * not consulted on this branch — the schema's own explanation requirement names
 * LERR specifically, and an EERR does not satisfy it.
 *
 * ── THE EMS BOUNDARY IS TVC AND LERR ONLY ────────────────────────────────────
 * xwgr asked whether a whitespace-only EERR beside a null BEMD is the same gap
 * on `ems-record`. It is not, measured the same day against 0.8.1: the
 * `cce-interop` lineage's `ems-record` carries NO BEMD → EERR rule at all, so
 * `BEMD: null` validates beside an EERR that is `null`, empty, or blank space
 * alike. There is no explanation requirement there for blank space to satisfy in
 * form only, so there is no gap of this shape to cover. An arm over BEMD would
 * be a DIFFERENT observation — an unexplained null accumulator rather than a
 * blank explanation — and would need its own issue and its own approved copy.
 *
 * The DS01.3 Annex 4 draft does add the BEMD → EERR rule, and it carries the
 * same whitespace gap inside it (`BEMD: null` with `EERR: "   "` validates
 * there; with `EERR: null` or `""` it does not). That is a fact about the draft,
 * not a reason to widen this advisory: the draft runs as the shadow profile, and
 * a shadow rule does not extend an observation the contract profile's payloads
 * are graded by.
 *
 * ── FIELD SHAPES ON THE RTM BRANCH, READ OFF THE SCHEMA ──────────────────────
 * Measured 2026-09-15 against src/schemas/cce-interop-0.8.1.json:
 *
 *   - `rtmd-record` requires ABST, ALRM, BEMD and EERR, and carries an `anyOf`
 *     asking that at least one of TVC / TFRZ / TAMB be PRESENT — a `null`
 *     satisfies that, since it asks for the key and not a value.
 *   - TVC is `["number","null"]`; LERR is `["string","null"]` and optional;
 *     EERR is `["string","null"]` and required, so it is always present on a
 *     schema-valid record, possibly as a null.
 *   - `rtmd-record` carries NO `allOf` in any registered version. Nothing ties a
 *     null reading to an explanation on this branch.
 *
 * So a record with `TVC: null`, `EERR: null` and no LERR validates cleanly. That
 * gap is the whole surface of the RTMD arm.
 *
 * ── WHAT "UNEXPLAINED" MEANS ON THE RTM BRANCH ───────────────────────────────
 * TVC is PRESENT and `null`, AND LERR is absent, null, or empty/whitespace-only,
 * AND EERR is absent, null, or empty/whitespace-only. Both codes count here
 * because the rtm branch requires neither of them to explain anything, so either
 * one arriving populated is the supplier accounting for the reading.
 *
 * Two boundaries are deliberate. A record whose TVC is ABSENT is not this
 * advisory's case: the `anyOf` lets an RTMD report TFRZ or TAMB instead, so a
 * freezer or an ambient-only device legitimately sends no TVC at all, and only
 * `TVC: null` — a reading the device set out to take and could not — fires.
 * And any non-string error code (a number, an object) is treated as an
 * explanation and keeps us silent: we grade what we can prove.
 *
 * The same rule means a literal `"none"` in EERR is a non-empty string and
 * therefore counts as an explanation here. The check cannot tell a placeholder
 * from a real code and does not try to — the repo's own rtm fixture sends
 * `EERR: "none"`, and reading placeholder vocabularies would be a judgement
 * about the supplier rather than an observation about the payload.
 *
 * ── ONE FINDING PER TRANSMISSION, ON EITHER ARM ──────────────────────────────
 * Like every advisory in this category: the compliance column carries a single
 * signature row per advisory id, so a finding per record would add no row and
 * only stack lines in the transmission block. The pointer addresses the FIRST
 * offending record, `/data/<r>/records/<i>`, for the raw-payload drill-down, and
 * the prose counts RECORDS across the reports that hold them. Counting records
 * rather than reports is the difference from null-identity.ts and blank-admin.ts:
 * this is a record-level condition, and "3 of 96 records" is what a supplier
 * needs in order to tell a single dropout from a dead sensor.
 *
 * The EMS arm's approved copy names ONE record (`Record 0 carries …`), which is
 * what a transmission with a single offender renders. More than one offender
 * pluralises the way the rtm arm already does — `2 of 3 records carry …` — and
 * the pointer places the first of them. The record number is the index inside
 * its report, the same number the pointer's last segment carries.
 *
 * ── `adv.null_padding` MAY ALSO FIRE, AND IS NOT SUPPRESSED ──────────────────
 * A report whose TVC is null in every record over at least twelve records raises
 * `adv.null_padding` as well. That is a DIFFERENT observation — a column padded
 * out with nulls for a sensor that is not fitted — and both are owed: one says
 * the column is empty, the other says nothing beside it explains why. Neither is
 * suppressed for the other, the same way agj.8 left duplicate_records and
 * time_not_increasing both standing.
 *
 * ── THE DS01.3 SHADOW DOES NOT RESTATE THIS ONE ──────────────────────────────
 * Unlike null-identity.ts and blank-admin.ts, whose observations the Annex 4
 * draft turns into clause 5.3.2 schema failures, this one has no shadow
 * counterpart on either arm. Measured 2026-09-15 and re-measured 2026-09-18
 * against src/schemas/pqs-e006-ds01-annex4-1.json: the draft's `rtmd-record`
 * adds exactly ONE `allOf`, tying a null BEMD to a non-null EERR, and leaves TVC
 * `["number","null"]` with nothing required to explain it; the draft's
 * `ems-record` keeps the TVC/LERR rule with `minLength: 1` intact, so the
 * whitespace gap the EMS arm covers is open there too. Both arms therefore
 * observe something neither lineage grades. No profile gate is needed or wanted,
 * for the reason null-identity.ts gives: stage order already settles which
 * surface speaks.
 *
 * Forward note (agj.2 NOTES, an upstream flag rather than our fix): 0.8.1
 * requires `minLength: 1` on LERR in the EMS abnormal branch; the proposed 0.8.4
 * drops it to a bare `{"type":"string"}`, so an EMPTY-string LERR would satisfy
 * the explanation requirement there. If 0.8.4 is ever registered, the empty-LERR
 * case stops being a §3.2 failure and joins the whitespace case in this module's
 * EMS arm — a widening of {@link isBlankExplanation}, not a new arm. 0.8.4 is
 * NOT registered; nothing here acts on it.
 *
 * ── WORDING: AN OBSERVATION AND A RATIONALE (agj.17) ─────────────────────────
 * Two pieces of prose, not one. `summary` is the OBSERVATION and `detail` is the
 * RATIONALE, and the two arms split the numbers differently because their
 * approved copy does:
 *
 *   - RTMD (approved 2026-09-15): the summary counts how many of the
 *     transmission's records carry TVC as null with neither error code beside
 *     it; the detail is static and carries no numbers.
 *   - EMS (xwgr, approved 2026-09-18): the summary is a single static sentence
 *     and the record reference sits in the detail's first sentence instead.
 *
 * THE RTMD RATIONALE WAS REPLACED ON 2026-09-15. The earlier draft argued from
 * what the receiving country cannot distinguish and closed on "a quiet null may
 * be ordinary on an RTMD", which reads as a reason to leave it alone. Benson's
 * decision the same day keeps the check exactly as it stands and states the
 * opposite emphasis instead: TVC is the most essential measurement for
 * protecting vaccine health, so a null one is worth investigating. The approved
 * paragraph is what this module emits.
 *
 * Observe, never conclude. We say what arrived — a null reading with no error
 * code beside it, or with blank space where the code should be — and we do NOT
 * say the sensor broke, or that the supplier suppressed anything. The EMS
 * rationale's "names a sensor or logger condition" describes what a REAL code
 * would do, not what this payload's device did. The PQS sentence quoted at the
 * top of this header is the MOTIVATION for the check, not something the wire
 * prose asserts about a particular supplier.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';

/**
 * THIS CHECK'S ADVISORY ID, exported so the registry can collect it (axdd).
 * `ADVISORY_IDS` in ./advisory.ts is built from these constants rather than from
 * a second hand-maintained list, so the id the check emits and the id the
 * coverage join asks about cannot drift apart.
 */
export const UNEXPLAINED_NULL_TEMP_ID = 'adv.unexplained_null_temp' as const;

/** The reading this advisory grades. */
const TEMPERATURE = 'TVC';

/** The logger error code — the one the EMS branch's schema rule names. */
const LOGGER_ERROR = 'LERR';

/** The error codes that can explain a null reading, in the order the prose names them. */
const ERROR_CODES = [LOGGER_ERROR, 'EERR'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `key` on `record` carries an explanation. Absent, `null`, and an empty
 * or whitespace-only string explain nothing; ANY other value (including a
 * non-string code) is read as an explanation — we grade what we can prove.
 */
function explains(record: Record<string, unknown>, key: string): boolean {
  if (!(key in record)) return false;
  const value = record[key];
  if (value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * Whether `key` on `record` is a string of BLANK SPACE — present, a string, at
 * least one character long, and empty after `trim()`. The EMS arm's whole
 * surface, and narrower than `!explains()` by exactly the two cases the schema
 * already rejects there: an absent or `null` code, and the empty string.
 */
function isBlankExplanation(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 && value.trim() === '';
}

/** Whether TVC was sent and sent as `null` — the precondition of both arms. */
function isNullReading(record: Record<string, unknown>): boolean {
  return TEMPERATURE in record && record[TEMPERATURE] === null;
}

/**
 * The RTM arm's case: TVC PRESENT and null, with neither error code accounting
 * for it. A TVC that was never sent is not this advisory's case — see the header.
 */
function isUnexplained(record: Record<string, unknown>): boolean {
  if (!isNullReading(record)) return false;
  return !ERROR_CODES.some((key) => explains(record, key));
}

/**
 * The EMS arm's case: TVC PRESENT and null with a LERR of blank space. Every
 * other shape of the same idea is a §3.2 failure on this branch and is the
 * schema's to report, not ours.
 */
function isBlankExplained(record: Record<string, unknown>): boolean {
  if (!isNullReading(record)) return false;
  return isBlankExplanation(record, LOGGER_ERROR);
}

/**
 * Which report branch the schema applied. Mirrors the root `if/then/else` of
 * cce-interop-0.8.1 verbatim: `meta.transferType` matching `^ems$` selects
 * `ems-report`, and EVERYTHING else (including `rtm`) falls to `rtmd-report`.
 */
function isEmsBranch(ctx: PipelineContext): boolean {
  return ctx.meta.transferType === 'ems';
}

/** The EMS arm's observation, approved 2026-09-18 (xwgr). It carries no numbers. */
const EMS_SUMMARY =
  'A temperature reading is null and the logger error code beside it is blank space.';

/** The EMS arm's rationale, approved 2026-09-18 (xwgr), following the record reference. */
const EMS_RATIONALE =
  'The schema accepts any one-character string as an error code, so this passes validation, ' +
  'but blank space explains nothing about why the reading is missing. A null reading with a ' +
  'real code names a sensor or logger condition; a null with blank space is indistinguishable ' +
  'from an unexplained gap.';

/** The RTMD arm's rationale, approved 2026-09-15 (agj.17). It carries no numbers. */
const RTM_RATIONALE =
  'rtmd-record allows a null TVC without tying it to anything that accounts for it, so ' +
  'these records are fully conformant. However, TVC is the most essential measurement ' +
  'for protecting vaccine health, so null TVC values should be investigated to ensure ' +
  'proper device operation.';

/** The `adv.unexplained_null_temp` check, registered in `ADVISORY_CHECKS`. */
export const unexplainedNullTempCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const ems = isEmsBranch(ctx);
  const isCase = ems ? isBlankExplained : isUnexplained;

  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  let totalRecords = 0;
  let affected = 0;
  let pointer: string | null = null;
  let firstRecordIndex: number | null = null;

  for (const [reportIndex, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    const records = report.records;
    if (!Array.isArray(records)) continue;

    for (const [recordIndex, record] of records.entries()) {
      if (!isPlainObject(record)) continue;
      totalRecords += 1;
      if (!isCase(record)) continue;

      affected += 1;
      pointer ??= `/data/${reportIndex}/records/${recordIndex}`;
      firstRecordIndex ??= recordIndex;
    }
  }

  if (affected === 0) return [];

  const recordNoun = totalRecords === 1 ? 'record' : 'records';
  const verb = affected === 1 ? 'carries' : 'carry';

  if (ems) {
    const subject =
      affected === 1
        ? `Record ${firstRecordIndex} carries`
        : `${affected} of ${totalRecords} ${recordNoun} ${verb}`;
    return [
      advisory({
        id: UNEXPLAINED_NULL_TEMP_ID,
        pointer,
        summary: EMS_SUMMARY,
        detail:
          `${subject} ${TEMPERATURE} null with ${LOGGER_ERROR} set to whitespace only. ` +
          EMS_RATIONALE,
      }),
    ];
  }

  return [
    advisory({
      id: UNEXPLAINED_NULL_TEMP_ID,
      pointer,
      summary:
        `${affected} of ${totalRecords} ${recordNoun} ${verb} ${TEMPERATURE} as null with ` +
        `${ERROR_CODES.join(' and ')} both blank.`,
      detail: RTM_RATIONALE,
    }),
  ];
};
