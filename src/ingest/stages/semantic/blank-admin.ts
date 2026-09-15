/**
 * ADVISORY — `adv.blank_admin`: administrative objects the report's own schema
 * branch REQUIRES, delivered blank (owning issue: agj.5, epic agj).
 *
 * The motivating case is the first item on PQS's own list of common EMS data
 * issues: "Empty string or null found in required administrative data objects...
 * easy to ignore, figuring the data will be there when the monitor is put into a
 * real fridge." A bench-configured device ships with its appliance and logger
 * description left unfilled, the deployment never goes back to fill it in, and
 * every transmission after that describes equipment nobody can identify.
 *
 * It validates because the shared `$defs` types most DS01 administrative objects
 * as `["string","null"]`, and because NONE of them — nullable or not — carries a
 * `minLength` or a `pattern`. The schema can require the KEY; it has no
 * vocabulary for requiring a VALUE.
 *
 * This is an ADVISORY, never a verdict: it emits `severity: 'info'` under the
 * `adv.*` namespace through {@link advisory}, so it provably cannot move any §7
 * requirement's pass/fail status (see advisory.ts's header for how that is
 * enforced rather than merely intended).
 *
 * ── WHAT IT READS, PER BRANCH ────────────────────────────────────────────────
 * The field set is the branch's own `required` list, MINUS `records` (not an
 * administrative object), MINUS the identity trio, MINUS `DLST`:
 *
 *   | branch        | reads                                        | count |
 *   |---------------|----------------------------------------------|-------|
 *   | `ems-report`  | {@link EMS_ADMIN_FIELDS}                     | 15    |
 *   | `rtmd-report` | {@link RTMD_ADMIN_FIELDS}                    | 6     |
 *
 * ASER, AID and AMID are EXCLUDED. `adv.null_identity` owns them, one identifier
 * per branch (2km, 38p), and reporting the same blank on two advisories would
 * stack two near-identical lines in the transmission block for one fact. A
 * report whose ASER is null and whose administrative objects are all populated
 * therefore raises `adv.null_identity` alone — pinned in ./blank-admin.test.ts.
 *
 * DLST is EXCLUDED as well, on `rtmd-report` where it is required. It is an
 * OBJECT (the sensor list, `type: "object"`), not an administrative string, so
 * "blank" as this check defines it does not describe it: an empty `{}` is a
 * different observation from an empty string, and what an rtmd-report's sensor
 * list owes is a separate question this advisory does not open.
 *
 * ── FIELD SHAPES, READ OFF THE SCHEMA ────────────────────────────────────────
 * Measured 2026-09-15 against src/schemas/cce-interop-0.8.1.json:
 *
 *   - `ems-report` requires CID ADOP AMFR AMOD APQS ASER LDOP LMFR LMOD LPQS
 *     LSER EDOP EMFR EMOD EPQS ESER and `records`. Exactly five are non-nullable
 *     (`type: "string"`): LDOP LMFR LMOD LPQS LSER. The other eleven are
 *     `["string","null"]`.
 *   - `rtmd-report` requires AMID CID DLST EDOP EMFR EMOD EPQS ESER and
 *     `records`. AMID is `["string"]`, DLST is an object, and the remaining six
 *     are `["string","null"]`.
 *   - NOTHING in either list carries `minLength` or `pattern`, so `""` and
 *     `"   "` are legal values everywhere.
 *
 * The lists below are CONSTANTS transcribed from those branches rather than read
 * out of the registry at runtime: the house rule is that a check mirrors the
 * schema verbatim, the same way {@link isEmsBranch} mirrors the root `if/then`.
 *
 * ── THE ADVISORY'S CONFORMANT SURFACE ────────────────────────────────────────
 * Absent or null on a NON-NULLABLE required field is already a §3.2 failure, and
 * stage 8 never runs on a 422. So on a payload that actually reaches this check,
 * what it can observe is: `null` on any of the nullable fields, and a blank
 * (empty or whitespace-only) string anywhere. On the five non-nullable EMS
 * fields the blank string is the whole surface — which is exactly why blanks
 * count at all, and is the same shape null-identity.ts records for AMID.
 *
 * "Blank" therefore covers absent, `null`, AND a string that is empty or
 * whitespace-only. Any other value (a number, an object) is treated as content
 * and keeps us silent: we grade what we can prove.
 *
 * ── ONE FINDING PER TRANSMISSION ─────────────────────────────────────────────
 * Like every advisory in this category: the compliance column carries a single
 * signature row per advisory id, so a finding per field would add no row and
 * only stack lines in the transmission block. The detail names EVERY blank field
 * of the first offending report (52r retired the old six-name cap — the list is
 * the actionable part, and it is bounded at fifteen by the branch) and counts the
 * reports affected, "N of M reports", as null-identity does.
 *
 * ── WORDING ──────────────────────────────────────────────────────────────────
 * Observe, never conclude. We say which required objects arrived blank and what
 * the receiving country is therefore holding. We do NOT say the supplier forgot,
 * that the device was never commissioned, or that the practice is wrong — the
 * PQS framing quoted at the top of this header is the motivation for the check,
 * not something the wire prose asserts about a particular supplier.
 *
 * ── THE DS01.3 SHADOW AND THIS CHECK NEED NO GATE ────────────────────────────
 * The DS01.3 Annex 4 draft TIGHTENS every object this advisory reads. Measured
 * 2026-09-15 against src/schemas/pqs-e006-ds01-annex4-1.json: all of them but
 * CID carry an `allOf` excluding the shared definition's null case, and each of
 * the fifteen EMS and six RTMD fields gains a `minLength` of 1, a date
 * `pattern`, or — on CID — `^[A-Z]{2}$`. So a null (except on CID, which stays
 * nullable) and an empty string anywhere are restated as clause 5.3.2 schema
 * failures under the shadow profile the schema stage now also grades (by1c.6),
 * the same way null-identity.ts's ASER and AMID are.
 *
 * The check is nonetheless deliberately NOT gated to the 2025 profile, for the
 * reason null-identity.ts gives: stage order already settles which surface
 * speaks. A payload DECLARING the Annex 4 lineage is rejected 422 at stage 7,
 * before stage 8 runs at all; a payload declaring the 0.8.x lineage is
 * accepted; so the advisory (never a grade) and the shadow failure describe the
 * same fact on two surfaces by design, and there is nothing a profile gate
 * would usefully suppress.
 *
 * One part of the surface stays this advisory's own on BOTH lineages: a
 * `minLength` of 1 accepts `"   "`, so a whitespace-only value on the eleven
 * EMS and four RTMD fields whose only floor is that `minLength` satisfies the
 * draft too, and is reported here or nowhere.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';

/**
 * The administrative objects `ems-report` requires, in the branch's own
 * `required` order, less `records` and less ASER (adv.null_identity's field).
 */
const EMS_ADMIN_FIELDS = [
  'CID',
  'ADOP',
  'AMFR',
  'AMOD',
  'APQS',
  'LDOP',
  'LMFR',
  'LMOD',
  'LPQS',
  'LSER',
  'EDOP',
  'EMFR',
  'EMOD',
  'EPQS',
  'ESER',
] as const;

/**
 * The administrative objects `rtmd-report` requires, in the branch's own
 * `required` order, less `records`, less AMID (adv.null_identity's field) and
 * less DLST (an object, not an administrative string — see the header).
 */
const RTMD_ADMIN_FIELDS = ['CID', 'EDOP', 'EMFR', 'EMOD', 'EPQS', 'ESER'] as const;

/** How a field arrived. Only `present` carries a description. */
type FieldState = 'present' | 'null' | 'empty' | 'absent';

/** How each blank state reads in the prose: `AMFR is null`. */
const BLANK_PHRASE: Record<Exclude<FieldState, 'present'>, string> = {
  null: 'is null',
  empty: 'is empty',
  absent: 'was not sent',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `a`, `a and b`, `a, b and c`. */
function joinPhrases(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Classify one administrative object on one report. */
function stateOf(report: Record<string, unknown>, key: string): FieldState {
  if (!(key in report)) return 'absent';
  const value = report[key];
  if (value === null) return 'null';
  if (typeof value === 'string') return value.trim() === '' ? 'empty' : 'present';
  // Anything else is not a shape we can call blank — treat it as content.
  return 'present';
}

/**
 * Which report branch the schema applied. Mirrors the root `if/then/else` of
 * cce-interop-0.8.1 verbatim: `meta.transferType` matching `^ems$` selects
 * `ems-report`, and EVERYTHING else (including `rtm`) falls to `rtmd-report`.
 */
function isEmsBranch(ctx: PipelineContext): boolean {
  return ctx.meta.transferType === 'ems';
}

/** The `adv.blank_admin` check, registered in `ADVISORY_CHECKS`. */
export const blankAdminCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const ems = isEmsBranch(ctx);
  const fields = ems ? EMS_ADMIN_FIELDS : RTMD_ADMIN_FIELDS;

  let total = 0;
  let affected = 0;
  let firstIndex = -1;
  let firstBlanks: string[] = [];
  let recordsUnderThem = 0;

  for (const [index, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    total += 1;

    const blanks: string[] = [];
    for (const key of fields) {
      const state = stateOf(report, key);
      if (state === 'present') continue;
      blanks.push(`${key} ${BLANK_PHRASE[state]}`);
    }
    if (blanks.length === 0) continue;

    affected += 1;
    recordsUnderThem += Array.isArray(report.records) ? report.records.length : 0;
    if (firstIndex === -1) {
      firstIndex = index;
      firstBlanks = blanks;
    }
  }

  if (affected === 0) return [];

  const reportNoun = total === 1 ? 'report' : 'reports';
  const verb = affected === 1 ? 'carries' : 'carry';
  const pronoun = affected === 1 ? 'it' : 'them';
  // With more than one, the fields listed are the FIRST one's — say so rather
  // than letting it read as a claim about all of them.
  const lead = affected === 1 ? '' : 'in the first, ';
  const list = joinPhrases(firstBlanks);
  // `records` is required with minItems 1, so a schema-valid report always has
  // some; the countless phrasing is defensive, not expected.
  const under =
    recordsUnderThem > 0
      ? `The ${recordsUnderThem} ${recordsUnderThem === 1 ? 'record' : 'records'} under ${pronoun}`
      : `The records under ${pronoun}`;
  const arrive = recordsUnderThem === 1 ? 'arrives' : 'arrive';

  // Each branch names the equipment ITS administrative objects describe, and
  // states how many of them the schema lets through blank. Neither claims the
  // report identifies nothing: ASER and AMID belong to adv.null_identity, are
  // never read here, and may well be populated.
  const body = ems
    ? `administrative objects that ems-report requires, delivered blank — ${lead}${list}. ` +
      `These objects describe the country, the appliance, the logger and the monitoring ` +
      `device rather than the readings taken from them, and they arrive once per report ` +
      `rather than once per reading. ems-report requires all fifteen of the keys read here; ` +
      `ten of them also accept null, none of them carries a minimum length, and so a null ` +
      `or an empty string satisfies the schema.`
    : `administrative objects that rtmd-report requires, delivered blank — ${lead}${list}. ` +
      `These objects describe the country and the monitoring device rather than the readings ` +
      `taken from it, and they arrive once per report rather than once per reading. ` +
      `rtmd-report requires all six of the keys read here; all six also accept null, none of ` +
      `them carries a minimum length, and so a null or an empty string satisfies the schema.`;

  return [
    advisory({
      id: 'adv.blank_admin',
      pointer: `/data/${firstIndex}`,
      detail:
        `${affected} of ${total} ${reportNoun} in this transmission ${verb} ${body} ` +
        `${under} ${arrive} complete and fully conformant, and the country receiving them ` +
        `holds readings whose description of the equipment is blank in those places.`,
    }),
  ];
};
