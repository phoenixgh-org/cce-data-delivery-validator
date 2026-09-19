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
 * ── WORDING: AN OBSERVATION AND A RATIONALE (agj.17) ─────────────────────────
 * Two pieces of prose, not one. `summary` is the OBSERVATION — one line naming
 * how many reports of how many arrived without the branch's identifier, and how
 * that identifier arrived in the first of them. `detail` is the RATIONALE — what
 * the identifier is and what the receiving country cannot do without it.
 *
 * THE RATIONALE IS ONE STATIC TEXT FOR BOTH BRANCHES (synm, approved
 * 2026-09-18), where it used to be one approved paragraph per branch. The
 * compliance column now carries a single expandable row per advisory id, which
 * has one rationale to show and no payload in front of it, so a branch-dependent
 * text would render whichever branch happened to arrive last. The approved copy
 * names the ems-report identifier and the rtmd-report identifier in turn; see
 * {@link NULL_IDENTITY_RATIONALE}.
 *
 * Observe, never conclude. We say what arrived and what the receiving side can
 * therefore not do with it. We do NOT say the supplier lost track of the
 * equipment, and we do not grade the practice. In particular the prose must not
 * claim the report carries "no appliance identifier at all" or that there is "no
 * appliance to file the readings under": this advisory can now fire while AID is
 * populated, so both claims would be false. What is true, and all we say, is
 * that the branch's own appliance identifier did not arrive and nothing else on
 * the branch stands in for it.
 *
 * The observation names the FIRST report's state ("in the first, ASER is null")
 * whenever more than one report is unnamed: the states can differ across them,
 * and a bare "ASER is null" would be a claim about all of them that we have not
 * checked.
 *
 * ── THE DS01.3 SHADOW AND THIS CHECK NEED NO GATE ────────────────────────────
 * The DS01.3 Annex 4 draft requires a non-null ASER on `ems-report` and a
 * minLength-1 AMID on `rtmd-report`, so most of what this advisory observes is a
 * clause 5.3.2 schema failure under the shadow profile the schema stage now also
 * grades (bd by1c.6). The check is deliberately NOT gated to the 2025 profile,
 * because stage order already settles which surface speaks: a payload declaring
 * the Annex 4 lineage is rejected 422 at stage 7 before stage 8 runs, and a
 * payload declaring the 0.8.x lineage is accepted, so the advisory (never a
 * grade) and the shadow failure describe the same fact on two surfaces by
 * design. The same reasoning, with both directions pinned in tests, is in
 * ./date-format.ts and ./date-format.test.ts.
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
export const NULL_IDENTITY_ID = 'adv.null_identity' as const;

/** The one identifier this advisory grades on an `ems-report`. */
const EMS_IDENTIFIER = 'ASER';

/** The one identifier this advisory grades on an `rtmd-report`. */
const RTMD_IDENTIFIER = 'AMID';

/**
 * THE RATIONALE, static per advisory id and approved verbatim (synm, Benson,
 * 2026-09-18). This module is its single owner: ./advisory.ts collects it into
 * `ADVISORY_RATIONALES`, the API serves it on the advisory signature, and the
 * browser holds no copy of its own.
 *
 * It carries no numbers and makes no claim the check has not made. In
 * particular it does not say the report names no appliance at all: AID may be
 * populated and is never read here (see the header).
 */
export const NULL_IDENTITY_RATIONALE =
  "This advisory looks at the one identifier that ties a report's records to an appliance, " +
  'and that identifier differs by report type. For an `ems-report` it is `ASER`, the ' +
  'appliance serial number as assigned by the manufacturer; no other ID is an adequate ' +
  "substitute. For an `rtmd-report` it is `AMID`, the identifier under which the supplier's " +
  'platform holds the appliance. The schema requires `AMID` as a non-null string, so a blank ' +
  'is the only empty form that passes, and neither `ASER` nor `AID` stands in for it on a ' +
  'retrofitted logger. Without this identifier, the receiving country cannot tie the records ' +
  'to an appliance.';

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

  for (const [index, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    total += 1;

    const state = stateOf(report, key);
    if (state === 'present') continue;

    unnamed += 1;
    if (firstIndex === -1) {
      firstIndex = index;
      firstBlank = `${key} ${BLANK_PHRASE[state]}`;
    }
  }

  if (unnamed === 0) return [];

  const reportNoun = total === 1 ? 'report' : 'reports';
  const verb = unnamed === 1 ? 'carries' : 'carry';
  // With more than one, the state listed is the FIRST one's — say so rather
  // than letting it read as a claim about all of them.
  const lead = unnamed === 1 ? '' : 'in the first, ';
  const missing = ems ? 'no appliance serial number' : 'no supplier-platform appliance identifier';

  return [
    advisory({
      id: NULL_IDENTITY_ID,
      pointer: `/data/${firstIndex}`,
      summary: `${unnamed} of ${total} ${reportNoun} ${verb} ${missing} — ${lead}${firstBlank}.`,
      detail: NULL_IDENTITY_RATIONALE,
    }),
  ];
};
