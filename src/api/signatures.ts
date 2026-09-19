/**
 * Signature normalization (4h4.3) — a PURE projection of validator output that
 * collapses identical defects into distinct "issues". No DB/HTTP: it folds the
 * structured per-transmission findings the dashboard already carries.
 *
 * WHY: one requirement (esp. §3.2 schema validation) can fail for many unrelated
 * reasons, so a requirement-level count cannot answer "what are the distinct
 * things to fix, and how widespread is each?". A signature is a finding stripped
 * of its instance-specific bits (array indices generalized, offending value never
 * in the key), keyed off Ajv's closed keyword vocabulary or a stable check code —
 * so the set is comprehensive on day one with no curated catalogue to maintain.
 *
 * This is a behavioral port of design_handoff_scale_at_volume/redesign/engine.js
 * (computeSignatures/sigKey/sigTitle/generalizePath + the CODE_TITLE map). The
 * FOLD logic is identical; only the accessors are adapted to the landed view:
 *   - the prototype's `f.sev`/`f.req` are `f.severity`/`f.requirement` here;
 *   - structured fields are camelCase on the view (keyword/instancePath/param/code);
 *   - timestamps come from `tx.received_at` (ISO string), not minutes-since-midnight;
 *   - the source Set keys off `tx.source` (raw transfer_src; '' is the single
 *     stable unknown bucket and counts as one source).
 *
 * ADVISORIES (agj.15). Advisory findings (`adv.*`, src/ingest/stages/semantic/
 * advisory.ts) are folded here too, as a THIRD `kind: 'advisory'` keyed
 * `adv|<adv.id>` — so the one `?signatureKey=` cross-filter serves them with no
 * new endpoint. They are NOT issues: `isIssue()` still rejects them, they carry
 * no requirement (`req: ''`), {@link signaturesForReq} never returns them, and
 * every requirement/matrix count must read {@link issueSignatures} rather than
 * the raw set (the `distinctIssues` headline does). An advisory is an
 * observation about a conformant payload; counting one as a defect is the single
 * thing the whole category exists to avoid.
 *
 * PROFILES (by1c.7). A finding grades against one requirement lineage — '2025',
 * the contract in force, or 'ds013', the DS01.3 shadow run — and the two are kept
 * DISJOINT here: the same Ajv keyword failing at the same path under the two
 * lineages is two different defects with two different clause ids, so the key is
 * prefixed with the profile and the fold can never merge them. Everything that
 * feeds a verdict surface (the §7 matrix rows via {@link signaturesForReq}, the
 * `distinctIssues` headline via {@link contractIssueSignatures}) then filters to
 * {@link CONTRACT_PROFILE}: a shadow result must never grade a supplier.
 *
 * THE LENS (tfnv.4) does not change any of that. It changes which package the
 * reader is looking at, so {@link issueSignaturesUnderLens} answers "what counts
 * here?" for the selected package and {@link withRequirementUnderLens} says which
 * of its rows each signature belongs to. Both collapse to the contract behaviour
 * when the contract package is the one selected, which is the default.
 */

import { clauseUnderLens } from './lens.js';
import {
  ADVISORY_PREFIX,
  advisoryRationale,
  isAdvisoryId,
} from '../ingest/stages/semantic/advisory.js';
import { CONTRACT_PROFILE } from '../schema-registry.js';
import type { Profile } from '../schema-registry.js';

/** §7 severity carried by a per-transmission finding (mirror src/web/api.ts). */
export type Severity = 'pass' | 'fail' | 'info';

/**
 * The structured finding shape this engine signs on — the camelCase view emitted
 * by src/api/sessions.ts `toFindingView` (FindingView + the 4h4.1 structured
 * fields). Self-contained so the module stays pure (no backend imports).
 */
export interface SignatureFinding {
  requirement: string;
  severity: Severity;
  detail: string | null;
  pointer: string | null;
  /** True for the §3.2 outdated-but-valid info finding (a soft issue). */
  outdated: boolean;
  /** Ajv keyword for §3.2 schema errors; null for non-schema findings. */
  keyword: string | null;
  /** JSON Pointer to the failing instance node; null for non-schema. */
  instancePath: string | null;
  /** Identifying param of a schema error (missingProperty/format/…) — NOT the value. */
  param: string | null;
  /** Stable check code for transport/heuristic findings; null for schema. */
  code: string | null;
  /**
   * Which requirement lineage this finding graded against (by1c.5). Part of the
   * signature key for every non-advisory finding — see {@link sigKey}.
   */
  profile: Profile;
}

/** The minimal transmission shape the fold reads (mirror src/web/api.ts). */
export interface SignatureTransmission {
  id: string;
  /** ISO timestamp string (serialized Date). */
  received_at: string;
  /** Raw source key (empty string for the single stable unknown bucket). */
  source: string;
  findings: SignatureFinding[];
}

/**
 * What a signature was folded from (mirror src/web/api.ts `Signature.kind`).
 * 'advisory' is not a defect class — see the ADVISORIES note in the header.
 */
export type SignatureKind = 'schema' | 'check' | 'advisory';

/**
 * Key namespace for advisory signatures: `adv|adv.null_padding`. The left half is
 * a literal namespace where a PROFILE would sit, which is unambiguous — the
 * profile vocabulary is closed ('2025' | 'ds013'), so no keyed finding can
 * collide with it.
 */
export const ADVISORY_KEY_PREFIX = 'adv|';

/**
 * One aggregated signature, pre-rolled for the wire — the browser must NEVER need
 * every raw finding to render the summary.
 */
export interface Signature {
  /** Stable key the list cross-filter matches against (see {@link sigKey}). */
  key: string;
  /**
   * The requirement this signature belongs to (e.g. "3.2"). EMPTY STRING for an
   * advisory: an advisory violates no requirement, so it belongs to no §7 row —
   * the sentinel is '' rather than a fake id so a stray advisory can never match
   * a matrix row in `signaturesForReq` (server or browser copy).
   */
  req: string;
  /**
   * The requirement lineage this signature belongs to, NULL for an advisory (an
   * advisory grades against no lineage — it is an observation about a conformant
   * payload). Every verdict surface filters this to {@link CONTRACT_PROFILE}, so
   * the null is the same kind of sentinel as `req: ''`: unmatchable by design.
   */
  profile: Profile | null;
  /** Human title for the issue (see {@link sigTitle}). */
  title: string;
  /**
   * 'schema' for Ajv-keyword defects, 'check' for transport/heuristic codes,
   * 'advisory' for an `adv.*` observation (never a defect — see the header).
   */
  kind: SignatureKind;
  /** Severity of the representative finding ('fail', or 'info' for outdated/advisory). */
  sev: Severity;
  /** Raw finding count across all transmissions. */
  count: number;
  /** Distinct transmissions exhibiting this signature. */
  txCount: number;
  /** Distinct sources exhibiting this signature ('' counts as one). */
  sourceCount: number;
  /** Earliest received_at (ISO string) exhibiting this signature. */
  first: string;
  /** Latest received_at (ISO string) exhibiting this signature. */
  last: string;
  /** Representative JSON Pointer for the issue (may be null). */
  examplePointer: string | null;
  /**
   * The row this signature belongs to under the SELECTED grading lens (tfnv.4).
   *
   * ABSENT under the contract lens, where `req` already names the row — the
   * default response stays byte-identical. Under the DS01.3 lens it is the clause
   * the signature is counted on: its own `req` for a draft-profile signature, the
   * forward-mapped clause for a contract one. Also absent when a contract
   * signature folds onto no clause at all (§3.2, which the draft re-runs), which
   * is what tells a reader the signature has no row on the page in front of them.
   *
   * It exists so the browser can group signatures under the lens without
   * mirroring the clause map, the re-run set and the §3.1 split — three rules that
   * would then have two homes.
   */
  requirementUnderLens?: string;
  /**
   * Why a receiving country cares about this advisory (synm). PRESENT ONLY on an
   * advisory signature: a §7 signature is a defect, and its explanation is the
   * requirement text the matrix already carries.
   *
   * Resolved from {@link advisoryRationale} by advisory id, NOT read off a
   * representative finding. The rationale is static per id, so the catalogue is
   * the current text while a stored finding's `detail` is whatever was current
   * when it was ingested, and a signature folds findings from across the
   * retention window. Reading the catalogue means one row never shows two
   * suppliers different wording for the same advisory.
   *
   * Absent for an id the catalogue does not hold, which is what a row stored
   * under a since-renamed advisory produces; the browser shows no rationale
   * rather than inventing one.
   */
  rationale?: string;
}

/**
 * Display titles for the non-schema check codes (the only hand-written table;
 * ~one row per MUST clause authored — bounded by the spec, not by traffic).
 *
 * The prototype's CODE_TITLE covered only 7 of the 14 emitted tx.* codes; the 7
 * added here (tx.unsupported_encoding / tx.undecodable_body / tx.missing_schema_version
 * / tx.unsupported_schema_version / tx.schema_invalid / tx.irregular_interval /
 * tx.concurrent_delivery) match the intent of the stages that raise them so they
 * get a stable title rather than drifting to the raw detail string. Note: the
 * §1.3 auth fail carries NO code by design — it correctly falls through to the
 * req+detail fallback in {@link sigTitle}.
 */
const CODE_TITLE: Record<string, string> = {
  // Prototype (engine.js) — copied verbatim.
  'tx.missing_charset': 'Content-Type missing “charset=utf-8”',
  'tx.body_too_large': 'Body exceeds the 1 MB wire cap',
  'tx.parse_failed': 'Body is not valid UTF-8 JSON',
  'tx.duplicate_transfer': 'Duplicate transferId',
  'tx.outdated_schema': 'Validated against an outdated schema',
  'tx.bad_media_type': 'Wrong media type (not application/json)',
  'tx.double_encoded': 'Body double-encoded (gzip + base64)',
  // Added to cover all 14 emitted codes (4h4.3).
  'tx.unsupported_encoding': 'Unsupported Content-Encoding (only gzip permitted)',
  'tx.undecodable_body': 'gzip body could not be decompressed',
  'tx.missing_schema_version': 'meta.schemaVersion is missing',
  'tx.unsupported_schema_version': 'Unsupported schemaVersion',
  'tx.schema_invalid': 'Body failed schema validation',
  'tx.irregular_interval': 'ABST reading cadence looks irregular',
  'tx.concurrent_delivery': 'Concurrent delivery (expected serial)',
  // Added with the §3.1 conditional custom-object check (5bs.1).
  'tx.missing_custom_schema': 'Custom data objects sent without meta.customDataSchema',
  // Added with the null-explanation translator (by1c.6): the leaf errors of one
  // record's failed oneOf are collapsed into this single code.
  'tx.null_unexplained': 'Null sensed value without an explaining error code',
};

/**
 * Strip array indices so per-element failures collapse: /data/0/ABST and
 * /data/7/ABST both become /data/*\/ABST. ~one of three total normalization rules.
 */
export function generalizePath(p: string | null | undefined): string {
  return (p || '').replace(/\/\d+/g, '/*');
}

/**
 * Whether a finding is a groupable "issue": a hard fail, OR the §3.2
 * outdated-but-valid info finding (a soft issue worth surfacing). Plain passes
 * and plain info findings are not grouped.
 */
export function isIssue(f: SignatureFinding): boolean {
  if (f.severity === 'fail') return true;
  if (f.severity === 'info' && f.outdated) return true;
  return false;
}

/**
 * Whether a finding is an advisory — reusing `isAdvisoryId`, the ONE definition
 * of the `adv.*` namespace (src/ingest/stages/semantic/advisory.ts), rather than
 * a fourth copy of the prefix. The emission helper writes the id into BOTH
 * `requirement` and `code`, so either half identifies one.
 *
 * (src/web/api.ts mirrors the prefix instead of importing it — the browser must
 * not import backend code. That constraint does not apply on this side.)
 */
export function isAdvisoryFinding(f: SignatureFinding): boolean {
  return isAdvisoryId(f.requirement) || isAdvisoryId(f.code);
}

/**
 * Whether a finding gets a signature at all: an issue, or an advisory. Kept
 * separate from {@link isIssue} on purpose — everything that COUNTS defects
 * (distinctIssues, the §7 matrix) must keep asking `isIssue`.
 */
export function isSignable(f: SignatureFinding): boolean {
  return isIssue(f) || isAdvisoryFinding(f);
}

/** The `adv.*` id an advisory finding carries (`code` first, `requirement` as fallback). */
function advisoryIdOf(f: SignatureFinding): string {
  return isAdvisoryId(f.code) ? (f.code as string) : f.requirement;
}

/**
 * Human title for an advisory id: `adv.null_padding` → `Null padding`. Derived,
 * not looked up: the `adv.*` ids are hand-authored words, so a derivation cannot
 * go stale as the catalogue grows or leave a new check rendering a raw id. Same
 * derivation as `advisoryLabel` in src/web/advisories.ts (which the browser keeps
 * for labelling the raw per-transmission findings in the transmission block); an
 * id that somehow arrives without the prefix is returned verbatim rather than
 * mangled.
 */
export function advisoryTitle(id: string): string {
  if (!isAdvisoryId(id)) return id;
  const words = id.slice(ADVISORY_PREFIX.length).replaceAll('_', ' ').replaceAll('.', ' ').trim();
  if (words === '') return id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The stable signature key. Sign on Ajv's structured fields (never the message),
 * generalize the path, and never put the offending value in the key:
 *   - advisory:      adv|<adv.id>
 *   - schema error:  profile|req|keyword|generalizedInstancePath|param
 *   - check code:    profile|req|code
 *   - last resort:   profile|req|detail
 *
 * The PROFILE prefix (by1c.7) makes the two lineages disjoint:
 * `2025|3.2|required|/data/*|LSER` and `ds013|5.3.2|required|/data/*|LSER` are
 * separate rows even though the keyword and path are identical, because they are
 * separate defects against separate clauses. The requirement id alone would not
 * be enough — a future DS01.3 clause id could collide with a §7 id. Advisory
 * keys carry no profile (an advisory grades against no lineage).
 */
export function sigKey(f: SignatureFinding): string {
  // Advisories first: they carry the adv.* id in `requirement`, which would
  // otherwise key them off a requirement that does not exist.
  if (isAdvisoryFinding(f)) return ADVISORY_KEY_PREFIX + advisoryIdOf(f);
  const head = f.profile + '|' + f.requirement;
  if (f.keyword) {
    return head + '|' + f.keyword + '|' + generalizePath(f.instancePath) + '|' + (f.param || '');
  }
  if (f.code) return head + '|' + f.code;
  return head + '|' + (f.detail || '');
}

/**
 * Human title for a signature. Schema keywords get a templated label (the only
 * hand-written table beyond CODE_TITLE); non-schema findings use CODE_TITLE,
 * falling back to the detail string, then the requirement. Worst case for an
 * untemplated edge is a plainer title — never a dropped or misfiled issue.
 */
export function sigTitle(f: SignatureFinding): string {
  if (isAdvisoryFinding(f)) return advisoryTitle(advisoryIdOf(f));
  if (f.keyword) {
    const field = generalizePath(f.instancePath).split('/').filter(Boolean).pop() || 'document';
    switch (f.keyword) {
      case 'required':
        return 'Missing required property ' + f.param;
      case 'format':
        return field + ' must match format “' + f.param + '”';
      case 'additionalProperties':
        return 'Unexpected property ' + f.param;
      case 'type':
        return field + ' has the wrong type';
      case 'enum':
        return field + ' is not an allowed value';
      case 'minimum':
      case 'maximum':
        return field + ' out of allowed range';
      case 'pattern':
        return field + ' does not match the required pattern';
      case 'minLength':
        // Annex 4's minLength is always 1, so the defect is an EMPTY string, not
        // a too-short one. Phrasing it as emptiness says what to fix; quoting a
        // limit of 1 would read as an arbitrary number.
        return field + ' must not be empty';
      default:
        return f.detail || f.keyword + ' at ' + generalizePath(f.instancePath);
    }
  }
  return CODE_TITLE[f.code ?? ''] || f.detail || f.requirement;
}

/**
 * Fold every issue finding — and every advisory — across the given transmissions
 * into signatures, accumulating raw count, DISTINCT transmissions, DISTINCT
 * sources, the earliest/latest received_at, and a representative pointer. Returns
 * the pre-aggregated wire shape sorted by count DESC.
 *
 * Advisory entries ride in the SAME set so one cross-filter serves both, but they
 * are not defects: filter with {@link issueSignatures} before any count that
 * grades a supplier.
 */
export function computeSignatures(transmissions: readonly SignatureTransmission[]): Signature[] {
  interface Group {
    key: string;
    req: string;
    profile: Profile | null;
    title: string;
    kind: SignatureKind;
    sev: Severity;
    count: number;
    sources: Set<string>;
    txIds: string[];
    first: string;
    last: string;
    examplePointer: string | null;
    /** The catalogue rationale for an advisory; null for every other kind. */
    rationale: string | null;
  }

  const map = new Map<string, Group>();
  for (const tx of transmissions) {
    for (const f of tx.findings) {
      if (!isSignable(f)) continue;
      const adv = isAdvisoryFinding(f);
      const k = sigKey(f);
      let g = map.get(k);
      if (!g) {
        g = {
          key: k,
          // An advisory belongs to no §7 row — '' is the sentinel (see Signature.req).
          req: adv ? '' : f.requirement,
          // …and to no lineage — null is the matching sentinel (see Signature.profile).
          profile: adv ? null : f.profile,
          title: sigTitle(f),
          kind: adv ? 'advisory' : f.keyword ? 'schema' : 'check',
          sev: f.severity,
          count: 0,
          sources: new Set<string>(),
          txIds: [],
          first: tx.received_at,
          last: tx.received_at,
          examplePointer: f.pointer ?? null,
          // From the catalogue, keyed by id — never from this finding's stored
          // `detail` (see Signature.rationale).
          rationale: adv ? advisoryRationale(advisoryIdOf(f)) : null,
        };
        map.set(k, g);
      }
      g.count += 1;
      // Transmissions arrive grouped per tx, so a dedupe against the last id is
      // enough to count DISTINCT transmissions (mirrors engine.js).
      if (g.txIds[g.txIds.length - 1] !== tx.id) g.txIds.push(tx.id);
      g.sources.add(tx.source);
      if (epoch(tx.received_at) < epoch(g.first)) g.first = tx.received_at;
      if (epoch(tx.received_at) > epoch(g.last)) g.last = tx.received_at;
    }
  }

  return [...map.values()]
    .map((g) => ({
      key: g.key,
      req: g.req,
      profile: g.profile,
      title: g.title,
      kind: g.kind,
      sev: g.sev,
      count: g.count,
      txCount: g.txIds.length,
      sourceCount: g.sources.size,
      first: g.first,
      last: g.last,
      examplePointer: g.examplePointer,
      // Spread rather than assigned, so a non-advisory signature carries no
      // `rationale` KEY at all: an explicit `undefined` would serialize away on
      // the wire but still compare unequal in a deepEqual pin.
      ...(g.rationale === null ? {} : { rationale: g.rationale }),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Filter an already-computed signature set down to one requirement of the
 * CONTRACT profile. NEVER returns advisory signatures: requirement grouping in
 * ComplianceCard is a verdict surface, and an advisory has no verdict. (`req` is
 * '' for advisories, so the equality alone excludes them; the explicit `kind`
 * guard says so on purpose.)
 *
 * The profile test is not redundant with the requirement test: the §7 matrix
 * grades the contract in force, and a DS01.3 clause id that one day collides
 * with a §7 id would otherwise file a shadow defect in a contract row. Filtering
 * on the lineage makes that impossible rather than merely unlikely.
 */
export function signaturesForReq(sigs: readonly Signature[], reqId: string): Signature[] {
  return sigs.filter(
    (s) => s.kind !== 'advisory' && s.profile === CONTRACT_PROFILE && s.req === reqId,
  );
}

/**
 * The defect half of a computed signature set — everything EXCEPT advisories.
 * BOTH lineages: this is the set the signature list renders, where a shadow
 * defect is legitimate information. Anything that GRADES reads
 * {@link contractIssueSignatures} instead.
 */
export function issueSignatures(sigs: readonly Signature[]): Signature[] {
  return sigs.filter((s) => s.kind !== 'advisory');
}

/**
 * The contract half of the defect set — {@link issueSignatures} narrowed to
 * {@link CONTRACT_PROFILE}. Any count that grades a supplier (the
 * `distinctIssues` headline, any §7/matrix tally) reads this: a shadow finding
 * records how a payload would fare under DS01.3 and is never a defect against
 * the obligations in force today.
 */
export function contractIssueSignatures(sigs: readonly Signature[]): Signature[] {
  return issueSignatures(sigs).filter((s) => s.profile === CONTRACT_PROFILE);
}

/**
 * The check code a `kind: 'check'` signature was keyed on, or null when it has
 * none — the inverse of {@link sigKey}'s check branch (`profile|req|code`).
 *
 * Read back off the key rather than carried on the Signature, because the wire
 * shape is pinned: the default response body is asserted byte-for-byte, so a new
 * field on every signature is not free. The parse is safe for the reason the key
 * format is: a profile id and a requirement id contain no `|`, and neither does a
 * `tx.*` code — the LAST-RESORT key (`profile|req|detail`) is the only other
 * three-part form, and a detail string is not a code, so the worst case is a
 * value no code lookup matches.
 */
function checkCodeOf(sig: Signature): string | null {
  if (sig.kind !== 'check') return null;
  const parts = sig.key.split('|');
  return parts.length === 3 ? (parts[2] ?? null) : null;
}

/**
 * The row each signature belongs to under the selected lens, written onto the set
 * as {@link Signature.requirementUnderLens}.
 *
 * Returns the input UNTOUCHED under the contract lens — same objects, same key
 * order — so the default response is unchanged. Under another lens every
 * non-advisory signature gains the field, except one that folds onto no row of
 * that package (see {@link Signature.requirementUnderLens}).
 */
export function withRequirementUnderLens(
  sigs: readonly Signature[],
  lens: Profile,
  contract: Profile = CONTRACT_PROFILE,
): Signature[] {
  if (lens === contract) return [...sigs];
  return sigs.map((sig) => {
    const row = rowUnderLens(sig, lens, contract);
    return row === null ? { ...sig } : { ...sig, requirementUnderLens: row };
  });
}

/**
 * The defect signatures that COUNT under the selected lens — what
 * `scoped.distinctIssues` is the length of.
 *
 * Under the contract lens this is {@link contractIssueSignatures}, unchanged.
 * Under the DS01.3 lens it is the union of the draft's own defects and the
 * contract defects the clause map carries onto one of its clauses: both describe
 * a duty the selected package imposes, and counting only one half would either
 * hide the transport failures the draft inherits or count a §3.2 result the draft
 * re-runs for itself. Advisories are excluded here as everywhere else.
 */
export function issueSignaturesUnderLens(
  sigs: readonly Signature[],
  lens: Profile,
  contract: Profile = CONTRACT_PROFILE,
): Signature[] {
  if (lens === contract) return contractIssueSignatures(sigs);
  return issueSignatures(sigs).filter((s) => rowUnderLens(s, lens, contract) !== null);
}

/** The lens row one signature belongs to, or null when it belongs to none. */
function rowUnderLens(sig: Signature, lens: Profile, contract: Profile): string | null {
  if (sig.kind === 'advisory') return null;
  if (sig.profile === lens) return sig.req;
  if (sig.profile === contract) return clauseUnderLens(sig.req, checkCodeOf(sig));
  return null;
}

/**
 * Whether a transmission exhibits the given signature key — the list cross-filter
 * predicate (consumed by the paginated list endpoint, 4h4.5). Advisory keys match
 * here too, and selecting one implies NOTHING about failures: an advisory-only
 * transmission with zero fails is a legitimate hit.
 */
export function txMatchesSig(tx: SignatureTransmission, key: string): boolean {
  return tx.findings.some((f) => isSignable(f) && sigKey(f) === key);
}

/** Epoch ms of an ISO timestamp, for first/last comparison. */
function epoch(iso: string): number {
  return new Date(iso).getTime();
}
