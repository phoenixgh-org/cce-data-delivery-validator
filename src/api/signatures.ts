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
 */

import { ADVISORY_PREFIX, isAdvisoryId } from '../ingest/stages/semantic/advisory.js';

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
 * a literal namespace where a requirement id would sit, which is unambiguous —
 * every §7 id is `MAJOR.MINOR` digits, so no requirement key can collide.
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
 *   - schema error:  req|keyword|generalizedInstancePath|param
 *   - check code:    req|code
 *   - last resort:   req|detail
 */
export function sigKey(f: SignatureFinding): string {
  // Advisories first: they carry the adv.* id in `requirement`, which would
  // otherwise key them off a requirement that does not exist.
  if (isAdvisoryFinding(f)) return ADVISORY_KEY_PREFIX + advisoryIdOf(f);
  if (f.keyword) {
    return (
      f.requirement + '|' + f.keyword + '|' + generalizePath(f.instancePath) + '|' + (f.param || '')
    );
  }
  if (f.code) return f.requirement + '|' + f.code;
  return f.requirement + '|' + (f.detail || '');
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
    title: string;
    kind: SignatureKind;
    sev: Severity;
    count: number;
    sources: Set<string>;
    txIds: string[];
    first: string;
    last: string;
    examplePointer: string | null;
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
          title: sigTitle(f),
          kind: adv ? 'advisory' : f.keyword ? 'schema' : 'check',
          sev: f.severity,
          count: 0,
          sources: new Set<string>(),
          txIds: [],
          first: tx.received_at,
          last: tx.received_at,
          examplePointer: f.pointer ?? null,
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
      title: g.title,
      kind: g.kind,
      sev: g.sev,
      count: g.count,
      txCount: g.txIds.length,
      sourceCount: g.sources.size,
      first: g.first,
      last: g.last,
      examplePointer: g.examplePointer,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Filter an already-computed signature set down to one requirement. NEVER returns
 * advisory signatures: requirement grouping in ComplianceCard is a verdict
 * surface, and an advisory has no verdict. (`req` is '' for advisories, so the
 * equality alone excludes them; the explicit `kind` guard says so on purpose.)
 */
export function signaturesForReq(sigs: readonly Signature[], reqId: string): Signature[] {
  return sigs.filter((s) => s.kind !== 'advisory' && s.req === reqId);
}

/**
 * The defect half of a computed signature set — everything EXCEPT advisories.
 * Any count that grades a supplier (the `distinctIssues` headline, any §7/matrix
 * tally) reads this, never `computeSignatures(...).length`.
 */
export function issueSignatures(sigs: readonly Signature[]): Signature[] {
  return sigs.filter((s) => s.kind !== 'advisory');
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
