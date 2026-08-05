/**
 * Semantic check — §3.1 conditional `meta.customDataSchema` (owning issue: 5bs.1).
 *
 * WHAT §3.1 IS FOR HERE (decided 2026-07-31, 5bs.1). With schema-precedence kept
 * as a house rule, §3.1's STRUCTURAL content is subsumed by §3.2: if Ajv passes,
 * the transmission-metadata block and the DS01 object shapes are correct by
 * construction, and grading them twice would just double-count §3.2. What Ajv
 * CANNOT express is the CONDITIONAL obligation, and that is what §3.1 owns here:
 *
 *   `meta.customDataSchema` is required ONLY WHEN the payload carries
 *   manufacturer-specific data objects.
 *
 * That conditional is the substance of DS01.3 clauses 5.3.3 (the new metadata
 * field) and 5.3.5 (manufacturer-specific objects must be described by a schema),
 * so one implementation serves both.
 *
 * ── why this cannot be a schema check ────────────────────────────────────────
 * `meta.customDataSchema` does not exist in `cce-interop-0.8.1.json` at all —
 * neither in the vendored bytes nor in the published artifact they are identical
 * to (sha256 `290290fd…`). It appears first in the published `0.8.2`, whose own
 * `$comment` on `$defs/custom-data-schema` says the conditional is "deliberately
 * NOT enforced by this schema … Employers wishing to enforce it should do so in
 * their own validation layer." We are that layer. And because every relevant
 * `$def` in 0.8.1 carries `additionalProperties: true` (6 places: both report and
 * both record defs, the metadata block, and the root), custom objects — and a
 * `customDataSchema` sent against 0.8.1 — sail through Ajv unexamined. So this
 * runs as a SEMANTIC check, independent of which schema version was validated
 * against.
 *
 * ── detection rule ───────────────────────────────────────────────────────────
 * Manufacturer-specific objects are lower-case and `z`-prefixed (DS01.2/DS01.3
 * clause 4.5, e.g. `ztpcm`) and "may appear at the report root or within
 * records" (0.8.2 `custom-data-schema` description). So we inspect the keys of
 * every `data[]` report root and every `records[]` entry, skipping the
 * structural `records` key itself, and classify each key:
 *
 *   1. `^z[a-z0-9]*$`          → CUSTOM, conformantly named (clause 4.5).
 *   2. `^[A-Z]{3,4}[0-9]?$`    → a DS01 object code by SHAPE. Never counted as
 *                                custom. If it is not in {@link KNOWN_DS01_CODES}
 *                                (the `$defs/PQS-DS01-objects` key set of the
 *                                vendored 0.8.1, plus the report-level `AMID`
 *                                and `DLST`) we merely NOTE it: an unrecognized
 *                                uppercase code is far more likely a DS01 object
 *                                newer than our vendored registry than a custom
 *                                object, and a hard fail driven by our own
 *                                schema lag would be dishonest.
 *   3. uppercases to a known code (`tvc`, `Tamb`) → a MIS-CASED DS01 object, not
 *                                a custom object. Noted, never counted as custom.
 *   4. anything else (`zTPCM`, `customTemp`) → CUSTOM by elimination, with
 *                                naming that violates clause 4.5.
 *
 * Cases 1 and 4 are "custom objects present" and drive the conditional. Cases 2
 * and 3 never do — they only feed the informational naming finding. That
 * asymmetry is deliberate: we fail hard only where the evidence is unambiguous.
 *
 * ── what we grade ────────────────────────────────────────────────────────────
 *   - custom present, `meta.customDataSchema` absent → §3.1 FAIL.
 *   - custom present, `meta.customDataSchema` present → §3.1 PASS. We record the
 *     declaration ONLY: we never fetch a by-reference URL and never validate the
 *     custom objects against the referenced/inline schema (DESIGN.md §9 — we do
 *     not fetch schemas at runtime). The detail says so.
 *   - no custom objects → §3.1 PASS, detail saying the conditional did not apply.
 *
 * Plus, when any key fell in case 2/3/4, ONE additional `info` finding naming
 * them against the clause-4.5 convention. Informational, never a hard fail:
 * §3.1's own text asks suppliers to "adopt the Data Objects naming conventions",
 * and observing a deviation is within our vantage point, but calling a name
 * wrong is a weaker claim than an undeclared custom object.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';

/** Manufacturer-specific object codes: lower-case, `z`-prefixed (clause 4.5). */
const CUSTOM_CODE = /^z[a-z0-9]*$/;

/** DS01 object-code SHAPE: 3-4 uppercase letters, optional trailing digit. */
const DS01_CODE_SHAPE = /^[A-Z]{3,4}[0-9]?$/;

/** Structural keys of a report that are not data objects. */
const STRUCTURAL_KEYS = new Set<string>(['records']);

/**
 * The DS01 object codes the vendored `cce-interop-0.8.1.json` knows: the key set
 * of its `$defs/PQS-DS01-objects`, plus `AMID` and `DLST`, which appear as
 * report-level properties without an entry in that def. Used ONLY to soften the
 * naming signal (recognizing a mis-cased known code, and telling a familiar
 * uppercase code from an unfamiliar one) — never to decide a hard fail, so the
 * list falling behind a newer schema cannot manufacture a false FAIL.
 */
const KNOWN_DS01_CODES = new Set<string>(
  // Space-separated so the list stays readable at 100 columns.
  (
    'ABST ACAT ACCD ACSV ADOP AID ALRM AMFR AMID AMOD APQS ASER BEMD BLOG CDAT CDAT2 CID ' +
    'CMPR CMPR2 CMPS CMPS2 CNAM CNAM2 CSER CSER2 CSOF CSOF2 DCCD DCSV DLST DNAM DORF DORV ' +
    'DRCF DRCV EDOP EERR EID EMFR EMOD EMSV EPQS ESER FANS FID FNAM HAMB HCOM HOLD IDRF ' +
    'IDRV LACC LAT LDOP LERR LID LMFR LMOD LNG LPQS LSER LSV MSW RNAM SIGN SVA TAMB TCON ' +
    'TCON2 TFRZ TPCB TPCB2 TVC'
  ).split(' '),
);

/** Max object names listed in a finding detail before it elides the rest. */
const MAX_LISTED = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One offending key plus the JSON Pointer of where we first saw it. */
interface KeySighting {
  key: string;
  pointer: string;
}

/** What a scan of the payload's data objects found. */
interface ScanResult {
  /** Manufacturer-specific objects, conformantly named (`^z[a-z0-9]*$`). */
  custom: KeySighting[];
  /** Manufacturer-specific objects whose naming violates clause 4.5. */
  misnamed: KeySighting[];
  /** Keys that uppercase to a known DS01 code — mis-cased, not custom. */
  miscased: KeySighting[];
  /** DS01-SHAPED codes we do not recognize — noted, never counted as custom. */
  unknownCode: KeySighting[];
}

/** Insert `key` into `bucket` unless already recorded (first sighting wins). */
function remember(bucket: KeySighting[], key: string, pointer: string): void {
  if (!bucket.some((s) => s.key === key)) bucket.push({ key, pointer });
}

/** JSON-Pointer-escape one path token (RFC 6901: `~` → `~0`, `/` → `~1`). */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Classify every data-object key on `obj` into `out`. */
function classify(obj: Record<string, unknown>, basePointer: string, out: ScanResult): void {
  for (const key of Object.keys(obj)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    const pointer = `${basePointer}/${escapeToken(key)}`;

    if (CUSTOM_CODE.test(key)) {
      remember(out.custom, key, pointer);
    } else if (DS01_CODE_SHAPE.test(key)) {
      if (!KNOWN_DS01_CODES.has(key)) remember(out.unknownCode, key, pointer);
    } else if (KNOWN_DS01_CODES.has(key.toUpperCase())) {
      remember(out.miscased, key, pointer);
    } else {
      remember(out.misnamed, key, pointer);
    }
  }
}

/** Walk `data[]` report roots and their `records[]`, classifying every key. */
export function scanDataObjects(parsedBody: unknown): ScanResult {
  const out: ScanResult = { custom: [], misnamed: [], miscased: [], unknownCode: [] };
  const data = (parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return out;

  data.forEach((report, i) => {
    if (!isPlainObject(report)) return;
    classify(report, `/data/${i}`, out);
    const records = report.records;
    if (!Array.isArray(records)) return;
    records.forEach((record, j) => {
      if (isPlainObject(record)) classify(record, `/data/${i}/records/${j}`, out);
    });
  });

  return out;
}

/**
 * Whether one `customDataSchema` value carries an actual declaration, matching
 * the shapes 0.8.2's `$defs/custom-data-schema-item` allows:
 *
 *   - BY REFERENCE — a string, `minLength: 1`. Blank/whitespace names no schema.
 *   - INLINE — an object with `required: ["$id"]`, itself `minLength: 1`. We
 *     accept a non-empty inline schema whose `$id` is missing as well: neither
 *     registered version (0.8.0, 0.8.1) carries this field at all, so an
 *     inline schema lacking `$id` has still made a declaration, and §3.1 grades
 *     whether one was made — not whether it is well-formed. But an `$id` that IS
 *     present and empty/non-string names nothing, and `{}` is not a schema.
 *
 * Everything else — `null`, numbers, booleans, `{}`, `''` — is absent.
 */
function isSchemaDeclaration(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!isPlainObject(value)) return false;
  if ('$id' in value) return typeof value.$id === 'string' && value.$id.trim().length > 0;
  return Object.keys(value).length > 0;
}

/**
 * Whether `meta.customDataSchema` is DECLARED. Present means: the key exists with
 * a value that actually carries a declaration — a non-empty string, an inline
 * schema object (see {@link isSchemaDeclaration}), or an array with at least one
 * entry that is itself such a declaration. `null`, `''`, `[]`, `{}`, `['']` and
 * `[{}]` are all treated as absent: they name no schema, so they cannot
 * discharge the obligation, and letting them through would turn an empty
 * declaration into a §3.1 PASS.
 */
export function hasCustomDataSchema(parsedBody: unknown): boolean {
  const meta = (parsedBody as { meta?: unknown } | null | undefined)?.meta;
  if (!isPlainObject(meta)) return false;
  const value = meta.customDataSchema;
  if (Array.isArray(value)) return value.some(isSchemaDeclaration);
  return isSchemaDeclaration(value);
}

/** Sorted, capped, comma-joined key list for a finding detail. */
function listKeys(sightings: readonly KeySighting[]): string {
  const keys = sightings.map((s) => s.key).sort();
  if (keys.length <= MAX_LISTED) return keys.join(', ');
  return `${keys.slice(0, MAX_LISTED).join(', ')} (+${keys.length - MAX_LISTED} more)`;
}

/** The standing caveat on a declared custom schema — we never dereference it. */
const NO_FETCH_CAVEAT =
  'we record the declaration only: the referenced schema is never fetched and the ' +
  'custom objects are never validated against it';

/** The standing §3.2 division-of-labour note carried on every §3.1 grade. */
const DIVISION_OF_LABOUR =
  'structural conformance of the metadata block and DS01 object shapes is graded under §3.2';

export const customDataSchemaCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const scan = scanDataObjects(ctx.parsedBody);
  const findings: Finding[] = [];

  // The custom objects that drive the conditional: conformantly named ones plus
  // the ones custom by elimination. DS01-shaped and mis-cased keys never do.
  const custom = [...scan.custom, ...scan.misnamed];

  if (custom.length === 0) {
    findings.push({
      requirement: '3.1',
      severity: 'pass',
      detail:
        'no manufacturer-specific data objects present, so the conditional ' +
        '§3.1 obligation to declare meta.customDataSchema did not apply; ' +
        `${DIVISION_OF_LABOUR}`,
    });
  } else if (hasCustomDataSchema(ctx.parsedBody)) {
    findings.push({
      requirement: '3.1',
      severity: 'pass',
      detail:
        `manufacturer-specific data objects (${listKeys(custom)}) are declared via ` +
        `meta.customDataSchema — ${NO_FETCH_CAVEAT}; ${DIVISION_OF_LABOUR}`,
    });
  } else {
    findings.push({
      requirement: '3.1',
      severity: 'fail',
      pointer: '/meta/customDataSchema',
      code: 'tx.missing_custom_schema',
      detail:
        `manufacturer-specific data objects (${listKeys(custom)}) are present but ` +
        'meta.customDataSchema is missing or names no schema: a payload carrying ' +
        'custom objects must ' +
        'describe them with a schema, by reference (a versioned, immutable URL) or ' +
        `inline (a schema bearing a versioned $id); ${DIVISION_OF_LABOUR}`,
    });
  }

  // Naming observations — informational, never a grade.
  const notes: string[] = [];
  if (scan.misnamed.length > 0) {
    notes.push(
      `${listKeys(scan.misnamed)} read as manufacturer-specific but are not lower-case ` +
        "and 'z'-prefixed (e.g. ztpcm) as DS01 clause 4.5 requires",
    );
  }
  if (scan.miscased.length > 0) {
    notes.push(
      `${listKeys(scan.miscased)} match a DS01 object code apart from letter case — ` +
        'DS01 object codes are upper-case',
    );
  }
  if (scan.unknownCode.length > 0) {
    notes.push(
      `${listKeys(scan.unknownCode)} look like DS01 object codes but are not in ` +
        'Annex 1 as of the schema version we validate against — either newer than our ' +
        "registry, or manufacturer-specific objects that should be lower-case and 'z'-prefixed",
    );
  }

  if (notes.length > 0) {
    const first =
      scan.misnamed[0]?.pointer ?? scan.miscased[0]?.pointer ?? scan.unknownCode[0]!.pointer;
    findings.push({
      requirement: '3.1',
      severity: 'info',
      pointer: first,
      detail: `data-object naming (§3.1 / DS01 clause 4.5): ${notes.join('; ')}`,
    });
  }

  return findings;
};
