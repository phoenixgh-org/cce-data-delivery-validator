/**
 * ADVISORY — `adv.unexplained_null_temp`: an `rtmd-report` record whose vaccine
 * compartment temperature arrived as `null` with no error code beside it
 * (owning issue: agj.2, epic agj).
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
 * ── RTMD BRANCH ONLY, AND WHY (agj.2, CORRECTED 2026-08-18) ──────────────────
 * This issue was filed on the belief that nothing catches the case. That is
 * wrong on the EMS branch: `ems-record` carries a record-level `allOf` whose
 * second `oneOf` is exactly this rule, and it is present in BOTH REGISTERED
 * VERSIONS (0.8.0 and 0.8.1), not new in a later draft:
 *
 *   NORMAL CASE    required [TVC], TVC `type: "number"`
 *   ABNORMAL CASE  required [TVC, LERR], TVC `type: "null"`,
 *                  LERR `type: "string"` with `minLength: 1`
 *
 * So on EMS a null TVC with a null, absent, or empty LERR is already a §3.2
 * SCHEMA FAILURE, stage 7 halts 422, and stage 8 never runs. An advisory arm
 * there would duplicate Ajv and put an `info` finding on a payload that is
 * already failing. {@link isEmsBranch} therefore returns early, and the EMS
 * branch of this observation is owned by the schema, not by this module.
 *
 * ── FIELD SHAPES, READ OFF THE SCHEMA ────────────────────────────────────────
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
 * gap is the whole surface of this advisory.
 *
 * ── WHAT "UNEXPLAINED" MEANS ─────────────────────────────────────────────────
 * TVC is PRESENT and `null`, AND LERR is absent, null, or empty/whitespace-only,
 * AND EERR is absent, null, or empty/whitespace-only.
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
 * ── ONE FINDING PER TRANSMISSION ─────────────────────────────────────────────
 * Like every advisory in this category: the compliance column carries a single
 * signature row per advisory id, so a finding per record would add no row and
 * only stack lines in the transmission block. The pointer addresses the FIRST
 * offending record, `/data/<r>/records/<i>`, for the raw-payload drill-down, and
 * the detail counts RECORDS across the reports that hold them. Counting records
 * rather than reports is the difference from null-identity.ts and blank-admin.ts:
 * this is a record-level condition, and "3 of 96 records" is what a supplier
 * needs in order to tell a single dropout from a dead sensor.
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
 * counterpart. Measured 2026-09-15 against src/schemas/pqs-e006-ds01-annex4-1.json:
 * the draft's `rtmd-record` adds exactly ONE `allOf`, tying a null BEMD to a
 * non-null EERR, and leaves TVC `["number","null"]` with nothing required to
 * explain it. So this gap is open on both lineages and this advisory is the only
 * surface that speaks to it. No profile gate is needed or wanted, for the reason
 * null-identity.ts gives: stage order already settles which surface speaks.
 *
 * Forward note (agj.2 NOTES, an upstream flag rather than our fix): 0.8.1
 * requires `minLength: 1` on LERR in the EMS abnormal branch; the proposed 0.8.4
 * drops it to a bare `{"type":"string"}`, so an empty-string LERR would satisfy
 * the explanation requirement there. If 0.8.4 is ever registered, the schema
 * stops catching blank-explanation EMS payloads and this advisory would need an
 * EMS arm again. 0.8.4 is NOT registered; nothing here acts on it.
 *
 * ── WORDING ──────────────────────────────────────────────────────────────────
 * Observe, never conclude. We say what arrived — a null reading with no error
 * code beside it — and what the receiving country therefore cannot distinguish:
 * a reading the device simply did not take from one it could not obtain. We do
 * NOT say the sensor broke, and we do not say the supplier suppressed anything.
 * The PQS sentence quoted at the top of this header is the MOTIVATION for the
 * check, not something the wire prose asserts about a particular supplier.
 *
 * The RTMD caveat agj.2 demoted the issue for belongs in the prose too. An RTMD
 * is a simpler device than an EMS, with a thinner error vocabulary, so a quiet
 * null may be ordinary there rather than a symptom. The finding is an
 * observation offered to the supplier, and it says so.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';

/** The reading this advisory grades. */
const TEMPERATURE = 'TVC';

/** The error codes that can explain a null reading, in the order the prose names them. */
const ERROR_CODES = ['LERR', 'EERR'] as const;

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
 * Whether this record is the case: TVC PRESENT and null, with neither error code
 * accounting for it. A TVC that was never sent is not this advisory's case — see
 * the header.
 */
function isUnexplained(record: Record<string, unknown>): boolean {
  if (!(TEMPERATURE in record)) return false;
  if (record[TEMPERATURE] !== null) return false;
  return !ERROR_CODES.some((key) => explains(record, key));
}

/**
 * Which report branch the schema applied. Mirrors the root `if/then/else` of
 * cce-interop-0.8.1 verbatim: `meta.transferType` matching `^ems$` selects
 * `ems-report`, and EVERYTHING else (including `rtm`) falls to `rtmd-report`.
 */
function isEmsBranch(ctx: PipelineContext): boolean {
  return ctx.meta.transferType === 'ems';
}

/** The `adv.unexplained_null_temp` check, registered in `ADVISORY_CHECKS`. */
export const unexplainedNullTempCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  // EMS is the schema's territory, not ours — see the header. A null TVC without
  // a minLength-1 LERR is a §3.2 failure in both registered versions.
  if (isEmsBranch(ctx)) return [];

  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  let totalRecords = 0;
  let affected = 0;
  let reportsAffected = 0;
  let pointer: string | null = null;

  for (const [reportIndex, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    const records = report.records;
    if (!Array.isArray(records)) continue;

    let hereAffected = 0;
    for (const [recordIndex, record] of records.entries()) {
      if (!isPlainObject(record)) continue;
      totalRecords += 1;
      if (!isUnexplained(record)) continue;

      hereAffected += 1;
      pointer ??= `/data/${reportIndex}/records/${recordIndex}`;
    }
    if (hereAffected > 0) reportsAffected += 1;
    affected += hereAffected;
  }

  if (affected === 0) return [];

  const recordNoun = totalRecords === 1 ? 'record' : 'records';
  const verb = affected === 1 ? 'carries' : 'carry';
  // With more than one report holding them, say so — "3 of 96 records" alone
  // would leave a supplier guessing whether one appliance or several are meant.
  const spread = reportsAffected === 1 ? ' ' : `, across ${reportsAffected} reports, `;

  return [
    advisory({
      id: 'adv.unexplained_null_temp',
      pointer,
      detail:
        `${affected} of ${totalRecords} ${recordNoun} in this transmission${spread}${verb} ` +
        `TVC as null with no error code beside it — LERR and EERR are both absent, null, or ` +
        `blank. rtmd-record types TVC ["number","null"] and, unlike ems-record, ties a null ` +
        `reading to nothing that would account for it, so these records arrive complete and ` +
        `fully conformant. The country receiving them cannot distinguish a reading the device ` +
        `simply did not take from one it could not obtain. An RTMD is a simpler device than an ` +
        `EMS and a quiet null may be ordinary on it, so this is an observation offered to the ` +
        `supplier rather than a verdict on the payload.`,
    }),
  ];
};
