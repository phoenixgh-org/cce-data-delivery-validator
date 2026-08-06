/**
 * ADVISORY — `adv.null_identity`: the appliance a report describes cannot be
 * named (owning issue: pwd, bite bva slice C).
 *
 * The motivating case (pwd): a report that validates perfectly and still leaves
 * the receiving country with no way to say WHICH refrigerator the readings came
 * from. It validates because the shared `$defs` definitions of the appliance
 * identifiers are `["string","null"]`, so `"ASER": null` is legal — the
 * transmission is conformant and the equipment is unidentifiable.
 *
 * This is an ADVISORY, never a verdict: it emits `severity: 'info'` under the
 * `adv.*` namespace through {@link advisory}, so it provably cannot move any §7
 * requirement's pass/fail status (see advisory.ts's header for how that is
 * enforced rather than merely intended).
 *
 * ── THE EMS/RTMD ASYMMETRY, READ OFF THE SCHEMA ──────────────────────────────
 * pwd states the case as "ASER and AMID both null". That is NOT a universal
 * rule: the two report branches do not carry the same identity fields at all.
 * Measured against src/schemas/cce-interop-0.8.1.json (and consistent with what
 * bd 1m8 measured about `ems-report`):
 *
 *   | field | ems-report                    | rtmd-report                     |
 *   |-------|-------------------------------|---------------------------------|
 *   | ASER  | REQUIRED, ["string","null"]   | optional, ["string","null"]     |
 *   | AID   | optional, ["string","null"]   | optional, ["string","null"]     |
 *   | AMID  | NOT A PROPERTY OF THE BRANCH  | REQUIRED, ["string"] — NOT null |
 *
 * So each branch is handled on its own terms:
 *
 *   - On `ems-report`, AMID is not part of the branch's vocabulary. ABSENT IS
 *     NOT NULL: a supplier who omits a field the branch never defined has said
 *     nothing, so we never count AMID against an EMS report and never name it in
 *     the prose. The appliance identifiers there are ASER and AID.
 *   - On `rtmd-report`, AMID is required AND non-nullable, so the schema itself
 *     very nearly forecloses this advisory — which is exactly why blank-string
 *     handling below matters. All three identifiers can appear.
 *   - A non-blank AMID on an EMS report still COUNTS AS IDENTIFICATION even
 *     though the branch does not define it (`additionalProperties: true` permits
 *     it, and a stable appliance reference is a stable appliance reference).
 *     We just never treat its absence there as evidence of anything.
 *
 * ── WHAT "UNIDENTIFIABLE" MEANS ──────────────────────────────────────────────
 * A report is unidentifiable when NONE of AMID/ASER/AID carries a usable value.
 * "No usable value" covers `null`, absent, and a string that is empty or
 * whitespace-only. Blank strings are in deliberately: on the rtmd branch AMID is
 * required and non-nullable, so if only a literal `null` counted, this advisory
 * could never fire on RTMD payloads at all — and an empty AMID identifies
 * exactly as much equipment as a null one. Any other value (a number, an object)
 * is treated as identification and keeps us silent: we grade what we can prove.
 *
 * ESER and LSER are NOT appliance identifiers. They name the monitoring device
 * and the logger — the thing doing the watching, not the appliance being
 * watched — so a report can carry both and still name no appliance. (On
 * `ems-report` LSER is required and non-nullable, so an EMS supplier always
 * names the logger; that says nothing about the refrigerator.)
 *
 * ── WORDING ──────────────────────────────────────────────────────────────────
 * Observe, never conclude. We say what arrived and what the receiving side can
 * therefore not do with it. We do NOT say the supplier lost track of the
 * equipment, and we do not grade the practice.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory.js';

/**
 * Appliance identifiers named in the prose for an `ems-report`. AMID is absent
 * from this list on purpose — the branch does not define it, so its absence is
 * not evidence (see the header).
 */
const EMS_APPLIANCE_IDS = ['ASER', 'AID'] as const;

/** Appliance identifiers named in the prose for an `rtmd-report`. */
const RTMD_APPLIANCE_IDS = ['AMID', 'ASER', 'AID'] as const;

/**
 * Every identifier that can NAME an appliance, on either branch. A value in any
 * of these keeps us silent regardless of which branch the report is on.
 */
const ANY_APPLIANCE_ID = ['AMID', 'ASER', 'AID'] as const;

/** How an identifier arrived. Only `present` names an appliance. */
type IdState = 'present' | 'null' | 'empty' | 'absent';

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

/** `a`, `a and b`, `a, b and c` — Oxford-free, matching the house prose. */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Blank states in the order they are reported, with their singular/plural verb. */
const BLANK_STATES: readonly { state: IdState; one: string; many: string }[] = [
  { state: 'null', one: 'is null', many: 'are null' },
  { state: 'empty', one: 'is empty', many: 'are empty' },
  { state: 'absent', one: 'was not sent', many: 'were not sent' },
];

/**
 * How one report's blank identifiers read: `ASER is null; AID was not sent`.
 * Grouped by state rather than listed key by key, so three blank identifiers do
 * not become three repetitions of the same verb.
 */
function describeBlanks(report: Record<string, unknown>, keys: readonly string[]): string {
  const phrases: string[] = [];
  for (const { state, one, many } of BLANK_STATES) {
    const named = keys.filter((key) => stateOf(report, key) === state);
    if (named.length === 0) continue;
    phrases.push(`${joinList(named)} ${named.length === 1 ? one : many}`);
  }
  return phrases.join('; ');
}

/**
 * Which report branch the schema applied. Mirrors the root `if/then/else` of
 * cce-interop-0.8.1 verbatim: `meta.transferType` matching `^ems$` selects
 * `ems-report`, and EVERYTHING else (including `rtm`) falls to `rtmd-report`.
 */
function isEmsBranch(ctx: PipelineContext): boolean {
  return ctx.meta.transferType === 'ems';
}

/**
 * A FUNCTION DECLARATION, not the sibling `export const check: SemanticCheck =`
 * idiom, and deliberately so: this module imports {@link advisory} from
 * advisory.ts while advisory.ts imports this check for `ADVISORY_CHECKS`, which
 * is an ESM cycle. A `const` binding would sit in its temporal dead zone when
 * advisory.ts's module body builds that array under the import order a test (or
 * any importer) reaching this module FIRST produces, throwing at load. A hoisted
 * function declaration is initialized before any module body runs, so the cycle
 * is safe in either order. `satisfies` below keeps the frozen signature checked.
 */
export function nullIdentityCheck(ctx: PipelineContext): Finding[] {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const ems = isEmsBranch(ctx);
  const named = ems ? EMS_APPLIANCE_IDS : RTMD_APPLIANCE_IDS;

  let total = 0;
  let firstIndex = -1;
  let firstBlanks = '';
  let unidentifiable = 0;
  let recordsUnderThem = 0;

  for (const [index, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    total += 1;

    if (ANY_APPLIANCE_ID.some((key) => stateOf(report, key) === 'present')) continue;

    unidentifiable += 1;
    recordsUnderThem += Array.isArray(report.records) ? report.records.length : 0;
    if (firstIndex === -1) {
      firstIndex = index;
      firstBlanks = describeBlanks(report, named);
    }
  }

  if (unidentifiable === 0) return [];

  const reportNoun = total === 1 ? 'report' : 'reports';
  const verb = unidentifiable === 1 ? 'carries' : 'carry';
  const pronoun = unidentifiable === 1 ? 'it' : 'them';
  // With more than one, the states listed are the FIRST one's — say so rather
  // than letting them read as a claim about all of them.
  const lead = unidentifiable === 1 ? '' : 'in the first, ';
  // Named only on the EMS branch, where the reason two identifiers are listed
  // instead of three is a property of the schema, not of the supplier.
  const branchNote = ems
    ? ' (an ems-report has no AMID property, so ASER and AID are the only appliance identifiers this branch carries)'
    : '';
  // `records` is required with minItems 1, so a schema-valid report always has
  // some; the countless phrasing is defensive, not expected.
  const under =
    recordsUnderThem > 0
      ? `The ${recordsUnderThem} ${recordsUnderThem === 1 ? 'record' : 'records'} under ${pronoun}`
      : `The records under ${pronoun}`;

  return [
    advisory({
      id: 'adv.null_identity',
      pointer: `/data/${firstIndex}`,
      detail:
        `${unidentifiable} of ${total} ${reportNoun} in this transmission ${verb} no appliance ` +
        `identifier — ${lead}${firstBlanks}${branchNote}. ${under} arrive complete ` +
        `and fully conformant, and the country receiving them has no appliance to file those ` +
        `readings under — ESER and LSER identify the monitoring device rather than the ` +
        `appliance it watches.`,
    }),
  ];
}

/** The frozen stage-8 signature, checked without giving up the hoisting above. */
nullIdentityCheck satisfies SemanticCheck;
