/**
 * ADVISORY — `adv.null_identity`: the report does not carry the identifier that
 * names the appliance on its branch (owning issue: pwd, bite bva slice C;
 * collapsed to one identifier per branch by 2km/38p).
 *
 * The motivating case (pwd): a report that validates perfectly and still leaves
 * the receiving country unable to say WHICH refrigerator the readings came from.
 * It validates because the shared `$defs` definitions of the appliance
 * identifiers are `["string","null"]`, so `"ASER": null` is legal.
 *
 * This is an ADVISORY, never a verdict: it emits `severity: 'info'` under the
 * `adv.*` namespace through {@link advisory}, so it provably cannot move any §7
 * requirement's pass/fail status (see advisory.ts's header for how that is
 * enforced rather than merely intended).
 *
 * ── ONE IDENTIFIER PER BRANCH (DECIDED 2026-08-06, Benson — 2km, 38p) ────────
 * The check does NOT ask "is any of AMID/ASER/AID populated". Each branch has
 * exactly ONE identifier that this advisory speaks to, and the other two are not
 * substitutes for it:
 *
 *   | branch        | this advisory looks at | fires when it is            |
 *   |---------------|------------------------|-----------------------------|
 *   | `ems-report`  | ASER, and ASER alone   | null, absent, or blank      |
 *   | `rtmd-report` | AMID, and AMID alone   | null, absent, or blank      |
 *
 * EMS (2km). ASER is programmed at the factory or at commissioning, and a core
 * value statement of an EMS is that the logger and the appliance are INTEGRATED
 * — the logger is expected to know the appliance's details. So a missing ASER
 * means a process broke down rather than that a reading was unavailable. Neither
 * of the other two stands in: `ems-report` has no AMID property at all, and AID
 * is a programme asset-tracking identifier the employer assigns rather than the
 * manufacturer's serial. A populated AID therefore does NOT silence this.
 *
 * RTMD (38p). Most RTMDs are retrofitted rather than integrated at the factory,
 * so appliance-side identifiers were frequently never captured and ASER/AID are
 * not reliable there. AMID — the supplier platform's own handle on the appliance
 * — is the one that must be present and populated, so it is the only one graded.
 *
 * ── FIELD SHAPES, READ OFF THE SCHEMA ────────────────────────────────────────
 * Measured against src/schemas/cce-interop-0.8.1.json (and consistent with what
 * bd 1m8 measured about `ems-report`):
 *
 *   | field | ems-report                    | rtmd-report                     |
 *   |-------|-------------------------------|---------------------------------|
 *   | ASER  | REQUIRED, ["string","null"]   | optional, ["string","null"]     |
 *   | AID   | optional, ["string","null"]   | optional, ["string","null"]     |
 *   | AMID  | NOT A PROPERTY OF THE BRANCH  | REQUIRED, ["string"] — NOT null |
 *
 * Two consequences worth stating plainly:
 *
 *   - On EMS, ASER is required but NULLABLE, so `"ASER": null` is the ordinary
 *     fully-conformant firing path, and blank strings are a second one.
 *   - On RTMD, AMID is required AND non-nullable, so null and absent are already
 *     §3.2 failures. THE ADVISORY'S ONLY SURFACE ON A FULLY CONFORMANT RTM
 *     PAYLOAD IS A BLANK (empty or whitespace-only) AMID. That is expected, not
 *     a defect in the rule: the check earns its place by catching the one case
 *     the schema cannot express (no `minLength`, no `pattern`, anywhere).
 *
 * "No usable value" therefore covers `null`, absent, AND a string that is empty
 * or whitespace-only. Any other value (a number, an object) is treated as
 * identification and keeps us silent: we grade what we can prove.
 *
 * ESER and LSER are NOT appliance identifiers. They name the monitoring device
 * and the logger — the thing doing the watching, not the appliance being
 * watched — so a report can carry both and still name no appliance. (On
 * `ems-report` LSER is required and non-nullable, so an EMS supplier always
 * names the logger; that says nothing about the refrigerator.)
 *
 * ── THE ID STAYS `adv.null_identity` (2km) ───────────────────────────────────
 * Deliberately not renamed to something like `adv.missing_appliance_serial`.
 * The rationale for collapsing to one field per branch is precisely that
 * NOTHING ELSE SUBSTITUTES for it, so the identity framing is still the correct
 * one — and the id is a stable value the dashboard keys on: an advisory's
 * signature key is `adv|<adv.id>` (`sigKey` in src/api/signatures.ts), so the id
 * is what its row in the compliance column and the `?signatureKey=` cross-filter
 * are addressed by. Renaming it is a separate, confirmed decision.
 *
 * Forward note: if the proposed schema 0.8.4 lands, `ASER: null` becomes a hard
 * §3.2 failure on EMS and this advisory then fires on that path only for
 * payloads declaring 0.8.0/0.8.1/0.8.3. It does not become redundant — the
 * registry deliberately keeps older cohorts.
 *
 * ── WORDING ──────────────────────────────────────────────────────────────────
 * Observe, never conclude. We say what arrived and what the receiving side can
 * therefore not do with it. We do NOT say the supplier lost track of the
 * equipment, and we do not grade the practice. In particular the prose must not
 * claim the report carries "no appliance identifier at all" or that there is "no
 * appliance to file the readings under": this advisory can now fire while AID is
 * populated, so both claims would be false. What is true, and all we say, is
 * that the branch's own appliance identifier did not arrive and nothing else on
 * the branch stands in for it.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';

/** The one identifier this advisory grades on an `ems-report`. */
const EMS_IDENTIFIER = 'ASER';

/** The one identifier this advisory grades on an `rtmd-report`. */
const RTMD_IDENTIFIER = 'AMID';

/** How an identifier arrived. Only `present` names an appliance. */
type IdState = 'present' | 'null' | 'empty' | 'absent';

/** How each non-identifying state reads in the prose: `ASER is null`. */
const BLANK_PHRASE: Record<Exclude<IdState, 'present'>, string> = {
  null: 'is null',
  empty: 'is empty',
  absent: 'was not sent',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Classify one identifier on one report. */
function stateOf(report: Record<string, unknown>, key: string): IdState {
  if (!(key in report)) return 'absent';
  const value = report[key];
  if (value === null) return 'null';
  if (typeof value === 'string') return value.trim() === '' ? 'empty' : 'present';
  // Anything else is not a shape we can call blank — treat it as identification.
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

/** The `adv.null_identity` check, registered in `ADVISORY_CHECKS`. */
export const nullIdentityCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const ems = isEmsBranch(ctx);
  const key = ems ? EMS_IDENTIFIER : RTMD_IDENTIFIER;

  let total = 0;
  let firstIndex = -1;
  let firstBlank = '';
  let unnamed = 0;
  let recordsUnderThem = 0;

  for (const [index, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    total += 1;

    const state = stateOf(report, key);
    if (state === 'present') continue;

    unnamed += 1;
    recordsUnderThem += Array.isArray(report.records) ? report.records.length : 0;
    if (firstIndex === -1) {
      firstIndex = index;
      firstBlank = `${key} ${BLANK_PHRASE[state]}`;
    }
  }

  if (unnamed === 0) return [];

  const reportNoun = total === 1 ? 'report' : 'reports';
  const verb = unnamed === 1 ? 'carries' : 'carry';
  const pronoun = unnamed === 1 ? 'it' : 'them';
  // With more than one, the state listed is the FIRST one's — say so rather
  // than letting it read as a claim about all of them.
  const lead = unnamed === 1 ? '' : 'in the first, ';
  // `records` is required with minItems 1, so a schema-valid report always has
  // some; the countless phrasing is defensive, not expected.
  const under =
    recordsUnderThem > 0
      ? `The ${recordsUnderThem} ${recordsUnderThem === 1 ? 'record' : 'records'} under ${pronoun}`
      : `The records under ${pronoun}`;
  // The verb has to agree with the noun `under` just built. A single record is
  // the ordinary case, not an edge one — `records` has minItems 1 and the rtm
  // baseline sends exactly one — so the singular is rendered as often as not.
  const arrive = recordsUnderThem === 1 ? 'arrives' : 'arrive';

  // Each branch says what is true of ITS identifier, and why the other two are
  // not read as substitutes for it. Neither claims the report names nothing at
  // all — AID (and on rtm, ASER) may well be populated.
  const body = ems
    ? `no appliance serial number — ${lead}${firstBlank}. ASER is the serial number the ` +
      `appliance's manufacturer assigned, and nothing else on an ems-report stands in for it: ` +
      `an ems-report has no AMID property, AID is an asset identifier a programme assigns, and ` +
      `ESER and LSER name the monitoring device and the logger rather than the appliance they ` +
      `watch. ${under} ${arrive} complete and fully conformant, and the country receiving them ` +
      `cannot tie those readings to the appliance by its manufacturer's serial number.`
    : `no supplier-platform appliance identifier — ${lead}${firstBlank}. AMID is the handle the ` +
      `supplier's own platform holds the appliance under, and an rtmd-report carries it as a ` +
      `required, non-null string, so a blank value is the only form of this the schema itself ` +
      `lets through. ASER and AID are frequently never captured where the monitoring device was ` +
      `added to an appliance already in service, so neither is read as standing in for AMID. ` +
      `${under} ${arrive} complete and fully conformant, and the country receiving them cannot ` +
      `tie those readings to an appliance in the supplier's platform.`;

  return [
    advisory({
      id: 'adv.null_identity',
      pointer: `/data/${firstIndex}`,
      detail: `${unnamed} of ${total} ${reportNoun} in this transmission ${verb} ${body}`,
    }),
  ];
};
