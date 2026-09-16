/**
 * ADVISORY — `adv.short_identifier`: an identifier that arrived populated and is
 * still too short to carry enough distinct values for a national fleet (owning
 * issue: krh).
 *
 * The motivating case: a supplier sends `"AMID": "A1"`. Nothing in the schema
 * objects — none of the identifier objects carries a `minLength` or a `pattern`
 * in either registered `cce-interop` version — and the value is neither null nor
 * blank, so `adv.null_identity` and `adv.blank_admin` both stay silent. What the
 * receiving country is holding is an identifier whose value space is far smaller
 * than the fleet it has to name.
 *
 * This is an ADVISORY, never a verdict: it emits `severity: 'info'` under the
 * `adv.*` namespace through {@link advisory}, so it provably cannot move any §7
 * requirement's pass/fail status (see advisory.ts's header for how that is
 * enforced rather than merely intended).
 *
 * ── WHAT IT READS, AND WHY THAT LIST (DECIDED FOR krh) ───────────────────────
 * The field set is the IDENTIFIER FAMILY: the values whose job is to pick out one
 * physical thing. Measured 2026-09-15 against src/schemas/cce-interop-0.8.1.json,
 * with each object's own `title` as the evidence for including or excluding it:
 *
 *   | key  | title                              | read? |
 *   |------|------------------------------------|-------|
 *   | ASER | Appliance manufacturer serial number | yes |
 *   | LSER | Logger serial number                 | yes |
 *   | ESER | EMD serial number                    | yes |
 *   | AMID | Appliance Monitoring ID              | yes (rtmd-report only) |
 *   | AID  | Appliance identifier                 | yes |
 *   | LID  | Logger identifier                    | yes |
 *   | EID  | EMD identifier                       | yes |
 *   | SID  | Sensor ID ("Unique sensor ID")       | yes, under every `DLST.<prop>` |
 *   | CSER | Compressor Electronic Unit Product Code   | NO |
 *   | CSER2| Secondary Compressor Electronic Unit ...  | NO |
 *   | FID  | Facility ID                          | NO |
 *   | CID  | Country ID                           | NO |
 *
 * CSER and CSER2 are EXCLUDED on the strength of their titles: a "Product Code",
 * described as "Compressor electronic unit admin information", names a model of
 * compressor electronics rather than one unit of it. Product codes are short by
 * design, so reading them here would raise this advisory on values that are doing
 * exactly what they are for.
 *
 * FID and CID are EXCLUDED because they do not identify the monitored unit at
 * all. CID is a country code, constrained to two letters by the DS01.3 draft's
 * own `^[A-Z]{2}$`; FID names a facility, a population several orders smaller
 * than a fleet of appliances. Neither carries the load this check is weighing.
 *
 * ESER IS INCLUDED although the proposing issue's candidate list omitted it: it
 * is an "EMD serial number", the same kind of value as ASER and LSER, and the
 * issue itself raised adding it.
 *
 * SID is reached by a different path from the rest. It lives in
 * `rtmd-sensor-schema` under `DLST.<TVC|TFRZ|TAMB|IDRV>`, not on the report, and
 * the branch types it a required non-null `string` described as a "Unique sensor
 * ID" — so uniqueness is squarely in scope and every sensor in the list is read.
 * `ems-report` declares no `DLST` property, so that path exists on the rtmd
 * branch alone; `AMID` is likewise an rtmd-report property only.
 *
 * ── THE THRESHOLD: FEWER THAN FOUR CHARACTERS ────────────────────────────────
 * Argued from FLEET SIZE, not from entropy per character. An entropy argument has
 * to assume an alphabet, and the original "16^4" framing assumed hex, which
 * understates what real identifiers carry.
 *
 *   - A national cold chain fleet is on the order of 10^4 to 10^5 appliances.
 *   - Identifiers also need headroom for namespacing across the manufacturers
 *     delivering into one country, so the value space wanted is on the order of
 *     10^6 rather than the fleet count itself.
 *   - Take the most generous common alphabet, 36 case-insensitive alphanumeric
 *     symbols. Three characters give 36^3 = 46,656 distinct values — short of
 *     even the low end of a single national fleet. Four give 36^4 = 1,679,616,
 *     which clears 10^6.
 *
 * So one to three characters cannot address a national fleet under ANY alphabet,
 * which is a statement about the value space and needs no assumption about how a
 * particular supplier allocates it. Four characters is borderline: it clears the
 * bar on a full alphanumeric alphabet and misses it on a narrower one, and
 * four-character serials that are perfectly legitimate are common enough that
 * raising an advisory on them would cost more than the borderline case it would
 * catch. Four is therefore deliberately NOT flagged — see
 * {@link MIN_IDENTIFIER_LENGTH}.
 *
 * ── WHAT COUNTS, AND WHAT BELONGS ELSEWHERE ──────────────────────────────────
 * The value is TRIMMED before it is measured, so `"  A1  "` is two characters,
 * not six: surrounding whitespace is not identification, and counting it would
 * let padding silence the check.
 *
 * A BLANK VALUE IS NEVER "SHORT". After trimming, a length of zero is handed to
 * the advisory that owns it — `adv.null_identity` for ASER on `ems-report` and
 * AMID on `rtmd-report`, `adv.blank_admin` for the rest — so the three are
 * exclusive by construction and one blank value raises exactly one line. The
 * range this check speaks to is one to three characters.
 *
 * Absent and `null` are likewise not this check's case, and a value that is not a
 * string (a number, an object) is not graded at all: we grade what we can prove,
 * and a length in characters is not defined for a value that is not text.
 *
 * ── ONE FINDING PER TRANSMISSION ─────────────────────────────────────────────
 * Like every advisory in this category: the compliance column carries a single
 * signature row per advisory id, so a finding per field would add no row and only
 * stack lines in the transmission block. The pointer addresses the FIRST
 * offending value — `/data/<r>/<KEY>`, or `/data/<r>/DLST/<prop>/SID` — and the
 * detail names every offending key of that first report with its length, plus the
 * count of reports affected, the way ./blank-admin.ts does.
 *
 * ── WORDING: AN OBSERVATION AND A RATIONALE (agj.17) ─────────────────────────
 * Two pieces of prose, not one. `summary` is the OBSERVATION — how many of the
 * transmission's reports carry an identifier under four characters, and which
 * values those were on the first of them, each with its own width. `detail` is
 * the RATIONALE, static and carrying no numbers of this transmission's: the
 * arithmetic of the value space, and what to review.
 *
 * The rationale does NOT vary with the branch. Which identifier objects are read
 * does (the table above), and the observation's list is what carries that — an
 * rtmd-report's line can name AMID and a DLST sensor's SID where an ems-report's
 * cannot.
 *
 * OBSERVE, NEVER CONCLUDE (krh's governing constraint). We CANNOT prove a short
 * identifier is non-unique, and the validator sees one supplier's sandbox data,
 * so it usually cannot observe an actual collision either. The prose therefore
 * observes that the value is too short to carry enough distinct values for a
 * national fleet, and says so as arithmetic about the value space. It does NOT
 * say that identifiers are colliding, that two appliances share one identifier,
 * or that the supplier's data is wrong — none of which this check has grounds
 * for.
 *
 * THE STRONGER SIGNAL, DEFERRED: an ACTUAL collision between two distinct CCE
 * units inside one session is provable and worth far more than a length
 * heuristic. It is out of scope here and filed as
 * cce-data-delivery-validator-0rfk — it needs cross-transmission state that this
 * stage does not have (the §1.8 `findPriorTransmissions` lookup in
 * ../semantic.ts keys on transferId and content hash, not on identifiers) and a
 * definition of "two distinct CCE units" that overlaps an open identity decision.
 *
 * ── THE DS01.3 SHADOW RESTATES NONE OF THIS ──────────────────────────────────
 * Measured 2026-09-15 against src/schemas/pqs-e006-ds01-annex4-1.json: the draft
 * adds `minLength: 1` to every identifier object read here (and to SID), and
 * nothing above 1 anywhere. A one-to-three character identifier satisfies the
 * draft exactly as it satisfies the contract lineage, so unlike ./blank-admin.ts
 * and ./null-identity.ts this advisory is not restated as a clause 5.3.2 shadow
 * failure at all. There is nothing for a profile gate to suppress, and the check
 * is ungated for the same stage-order reason the other modules give: a payload
 * declaring the Annex 4 lineage is rejected 422 at stage 7 before stage 8 runs.
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
export const SHORT_IDENTIFIER_ID = 'adv.short_identifier' as const;

/**
 * The shortest identifier this check treats as able to address a national fleet.
 * Four characters of a 36-symbol alphanumeric alphabet give 1,679,616 distinct
 * values; three give 46,656. See the header for the full argument.
 */
const MIN_IDENTIFIER_LENGTH = 4;

/** The identifier objects `ems-report` declares. `ems-report` has no AMID. */
const EMS_IDENTIFIER_FIELDS = ['ASER', 'LSER', 'ESER', 'AID', 'LID', 'EID'] as const;

/** The identifier objects `rtmd-report` declares, AMID included. */
const RTMD_IDENTIFIER_FIELDS = ['ASER', 'LSER', 'ESER', 'AMID', 'AID', 'LID', 'EID'] as const;

/** The sensor list, and the one identifier inside each of its entries. */
const SENSOR_LIST = 'DLST';
const SENSOR_IDENTIFIER = 'SID';

/** One value this check found too short, with everything the prose needs. */
interface ShortValue {
  /** How it reads in the observation: `ASER is 3 characters`. */
  readonly phrase: string;
  /** JSON Pointer to the value itself. */
  readonly pointer: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `a`, `a and b`, `a, b and c`. */
function joinPhrases(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** JSON-Pointer-escape one path token (RFC 6901: `~` → `~0`, `/` → `~1`). */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** `3 characters`, and `1 character` for the singular. */
function lengthPhrase(length: number): string {
  return `${length} character${length === 1 ? '' : 's'}`;
}

/**
 * The trimmed length of a value that is a string, or null for anything else.
 * A trimmed length of zero is a BLANK and belongs to adv.null_identity or
 * adv.blank_admin, so it is not short here either.
 */
function shortLengthOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const length = value.trim().length;
  if (length === 0 || length >= MIN_IDENTIFIER_LENGTH) return null;
  return length;
}

/**
 * Which report branch the schema applied. Mirrors the root `if/then/else` of
 * cce-interop-0.8.1 verbatim: `meta.transferType` matching `^ems$` selects
 * `ems-report`, and EVERYTHING else (including `rtm`) falls to `rtmd-report`.
 */
function isEmsBranch(ctx: PipelineContext): boolean {
  return ctx.meta.transferType === 'ems';
}

/** Every too-short identifier on one report, report keys first then sensors. */
function shortValuesIn(
  report: Record<string, unknown>,
  index: number,
  fields: readonly string[],
): ShortValue[] {
  const found: ShortValue[] = [];

  for (const key of fields) {
    const length = shortLengthOf(report[key]);
    if (length === null) continue;
    found.push({ phrase: `${key} is ${lengthPhrase(length)}`, pointer: `/data/${index}/${key}` });
  }

  // `DLST` is an rtmd-report property, and the branch's field list is what puts
  // us on that branch, so the sensor walk is guarded by the list rather than by
  // a second branch test. An ems-report MAY carry `DLST` as an additional
  // property (`ems-report` sets `additionalProperties: true`, so such a payload
  // validates and reaches this stage); that case is deliberately NOT read,
  // because `SID` is an rtmd-sensor-schema value — the header's table says the
  // same. `EMS_IDENTIFIER_FIELDS` carries no `AMID`, so the guard below skips it.
  const sensors = report[SENSOR_LIST];
  if (fields.includes('AMID') && isPlainObject(sensors)) {
    for (const [prop, sensor] of Object.entries(sensors)) {
      if (!isPlainObject(sensor)) continue;
      const length = shortLengthOf(sensor[SENSOR_IDENTIFIER]);
      if (length === null) continue;
      found.push({
        phrase: `${SENSOR_LIST}.${prop} ${SENSOR_IDENTIFIER} is ${lengthPhrase(length)}`,
        pointer: `/data/${index}/${SENSOR_LIST}/${escapeToken(prop)}/${SENSOR_IDENTIFIER}`,
      });
    }
  }

  return found;
}

/** The `adv.short_identifier` check, registered in `ADVISORY_CHECKS`. */
export const shortIdentifierCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const ems = isEmsBranch(ctx);
  const fields = ems ? EMS_IDENTIFIER_FIELDS : RTMD_IDENTIFIER_FIELDS;

  let total = 0;
  let affected = 0;
  let firstPointer = '';
  let firstPhrases: string[] = [];

  for (const [index, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    total += 1;

    const short = shortValuesIn(report, index, fields);
    if (short.length === 0) continue;

    affected += 1;
    if (firstPointer === '') {
      firstPointer = short[0]!.pointer;
      firstPhrases = short.map((s) => s.phrase);
    }
  }

  if (affected === 0) return [];

  const reportNoun = total === 1 ? 'report' : 'reports';
  const verb = affected === 1 ? 'carries' : 'carry';
  // With more than one, the values listed are the FIRST one's — say so rather
  // than letting them read as a claim about all of them.
  const lead = affected === 1 ? '' : 'in the first, ';
  const list = joinPhrases(firstPhrases);

  return [
    advisory({
      id: SHORT_IDENTIFIER_ID,
      pointer: firstPointer,
      summary:
        `${affected} of ${total} ${reportNoun} ${verb} an identifier under four characters — ` +
        `${lead}${list}.`,
      detail:
        'A national cold chain in a large country might hold over 50,000 appliances across ' +
        'several suppliers, but three alphanumeric characters span only 46,656 values. An ' +
        'identifier of this width is not likely to distinguish the members of a national ' +
        'fleet, much less a global population of equipment. Review the structure of these ' +
        'values to ensure they are suitable for the intended scale of deployment.',
    }),
  ];
};
