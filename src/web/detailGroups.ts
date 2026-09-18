/**
 * The docked detail's finding groups (by1c.14) — the grouping, the copy and the
 * row phrasing, with no markup, so every rule below is testable on the Node
 * runner.
 *
 * WHY: since by1c.6 a transmission carries findings from two lineages, and the
 * detail pane listed them in one undifferentiated block. A supplier reading that
 * block cannot tell which findings grade the contract they are bound to and
 * which describe a proposal. So the pane now reads:
 *
 *   1. `Findings · UNICEF Q1 2025` — the findings that grade, i.e. the contract
 *      lineage's. A contract failure that is also a DS01.3 failure is marked in
 *      place with the shadow clause it re-tags to ("· also 5.1.3") and is NOT
 *      repeated below; one defect, one row.
 *   2. `Would also fail under DS01.3 DRAFT` — what the shadow run found on its
 *      own, rendered only when it found something.
 *   3. Advisories — unchanged, after both.
 *
 * Every lineage name comes from {@link PROFILE_NAME}; nothing here writes
 * "UNICEF Q1 2025" or "DS01.3 DRAFT" as a literal, so the day the contract moves
 * the words follow the registry's flip point rather than this file.
 */
import {
  CONTRACT_PROFILE,
  isAdvisory,
  type FindingView,
  type Profile,
  type Signature,
} from './api';
import { FORWARD } from './clauseMap';
import { PROFILE_NAME } from './profiles';
import { findingSignatureKey, generalizePath } from './signatureKey';

/**
 * The 2025 ids that are NOT re-tagged forward into the shadow verdict — mirror
 * `RE_RUN_UNDER_SHADOW` in src/api/verdicts.ts:79, whose `verdict()` rule
 * (src/api/verdicts.ts:142) is what this suffix reports on.
 *
 * Only §3.2 qualifies: transport and semantic checks are emitted once under 2025
 * numbering and re-tagged for the shadow profile, so a 2025 failure on one of
 * them is a DS01.3 failure too. §3.2's counterpart (5.3.2) is genuinely re-run by
 * the shadow validator, which writes its own `ds013` findings — marking a 2025
 * schema failure "also 5.3.2" would claim a result the shadow run did not
 * produce.
 */
const RE_RUN_UNDER_SHADOW: ReadonlySet<string> = new Set(['3.2']);

/** Title of the collapsed `required` row — the defect is the payload's shape. */
const SCHEMA_ROW_TITLE = 'schema';

/**
 * The DS01.3 clause a contract finding ALSO fails under, or null.
 *
 * Null for everything that is not a graded contract failure, for §3.2 (see
 * {@link RE_RUN_UNDER_SHADOW}), for a requirement outside the clause map, and
 * for every session with no shadow lineage — where the whole shadow vocabulary
 * is hidden and the detail pane reads exactly as it did before this bite.
 *
 * Null too when the shadow lineage never ran on this transmission (by1c.41).
 * `verdict()` in src/api/verdicts.ts:153 refuses to grade a transmission that
 * carries no finding of the shadow lineage at all — a transport halt files its
 * §1.3 or §1.6 failure and halts the pipeline before the schema stage, so no
 * shadow finding is ever written — and the dot on the list row therefore reads
 * "not graded". A suffix here would assert the shadow result the verdict engine
 * has just declined to assert.
 */
export function alsoFailsClause(
  f: FindingView,
  shadowProfile: Profile | null,
  shadowRan: boolean,
): string | null {
  if (shadowProfile === null) return null;
  if (!shadowRan) return null;
  if (f.profile !== CONTRACT_PROFILE) return null;
  if (f.severity !== 'fail') return null;
  if (isAdvisory(f)) return null;
  if (RE_RUN_UNDER_SHADOW.has(f.requirement)) return null;
  return FORWARD[f.requirement] ?? null;
}

/** One row of group 1: a contract finding, plus the clause it also fails under. */
export interface ContractRow {
  finding: FindingView;
  /** The DS01.3 clause for the "· also 5.1.3" suffix, or null for no suffix. */
  alsoFails: string | null;
}

/**
 * The JSON Pointer a shadow row shows, and the one its `pointer:` button opens
 * the raw-payload inspector at (by1c.40).
 *
 * Two values, because a collapsed row folds several findings at different record
 * indexes into one defect. What the row SHOWS is the generalized path —
 * `/data/*`, the path the collapse buckets on — because the defect is the shape
 * of every record, not of record 0. What it OPENS is the first folded finding's
 * own concrete path, because that is a line the inspector can scroll to: a
 * generalized path matches no `data-path` and the click would do nothing.
 *
 * A row that folds nothing shows and opens the same pointer, exactly as a
 * FindingItem does. `pointer` null renders no line at all, again like a
 * FindingItem.
 */
export interface ShadowRowPointer {
  /** The pointer as text under the row, generalized for a collapsed row. */
  pointer: string | null;
  /** The concrete path the inspector scrolls to, or null when there is none. */
  locate: string | null;
}

/** {@link ShadowRowPointer} for one finding — `collapses` is the `required` fold. */
export function shadowRowPointer(f: FindingView, collapses: boolean): ShadowRowPointer {
  const own = f.instancePath ?? f.pointer;
  if (own === null || own === '') return { pointer: f.pointer, locate: null };
  return { pointer: collapses ? generalizePath(own) : own, locate: own };
}

/**
 * One row of group 2 — a shadow-lineage failure, phrased for reading rather than
 * for grading. Rendered as `{req} {title} — {detail}`, the dash omitted when
 * {@link ShadowRow.dash} is false (the bespoke `transferredAt` phrasing reads as
 * one clause, not as a label and a value).
 */
export interface ShadowRow {
  /** Signature key of the folded defect — the cross-filter the row's button sets. */
  key: string;
  /** The DS01.3 clause id the finding was filed under (5.3.2 / 5.3.3). */
  req: string;
  /** Body-face label; empty when no signature matched and the detail carries the row. */
  title: string;
  /** Monospace tail, or null. */
  detail: string | null;
  /** Whether an em dash separates title from detail. */
  dash: boolean;
  /** The pointer shown under the row, or null — see {@link ShadowRowPointer}. */
  pointer: string | null;
  /** The concrete path the raw-payload inspector opens at, or null. */
  locate: string | null;
  /** The signature this row cross-filters to, or null when none matched. */
  sig: Signature | null;
}

/** Both groups of the docked detail, in render order. */
export interface DetailGroups {
  contract: ContractRow[];
  shadow: ShadowRow[];
}

/** What {@link groupDetailFindings} needs beyond the findings themselves. */
export interface DetailGroupContext {
  /** The session's signatures — the title and click target of a shadow row. */
  signatures?: readonly Signature[];
  /** The transmission's parsed body — the source of the `transferredAt` offset. */
  body?: unknown;
}

/**
 * The UTC-offset phrase for a `transferredAt` row: `"+03:00 → needs Z"`.
 *
 * DS01.3 5.3.3 narrows `meta.transferredAt` to UTC RFC 3339, so the actionable
 * fact is the offset the payload sent, not the regex it missed. The offset is
 * read off the body rather than out of the finding's message because the message
 * quotes the pattern, and a supplier needs to see their own value. Null when the
 * body carries no `meta.transferredAt` with a trailing offset — the caller then
 * falls back to the signature's own title rather than inventing one.
 */
export function transferredAtPhrase(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const meta = (body as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object') return null;
  const value = (meta as { transferredAt?: unknown }).transferredAt;
  if (typeof value !== 'string') return null;
  const match = /([+-]\d{2}:\d{2})$/.exec(value);
  return match === null ? null : `${match[1]} → needs Z`;
}

/** A built row plus what {@link collapseRequired} needs to fold it. */
export interface RowSource {
  row: ShadowRow;
  /** The `required`-collapse bucket, or null when the row does not collapse. */
  bucket: string | null;
  /** The missing property name this row contributed, when it collapses. */
  param: string | null;
}

/**
 * Collapse `required` failures that share one generalized instance path into a
 * single row: `5.3.2 schema — LSER, LMOD required`.
 *
 * One record missing three properties is one thing to fix, and the same omission
 * repeated across a hundred records is still one thing to fix — which is why the
 * path is generalized (`/data/0` and `/data/7` both become `/data/*`) before
 * bucketing. Paths that differ stay separate rows, because they are separate
 * omissions. A bucket of one collapses too: the phrasing is the same question
 * answered the same way, and switching form at two would read as two kinds of
 * defect.
 */
export function collapseRequired(sources: readonly RowSource[]): ShadowRow[] {
  const out: ShadowRow[] = [];
  const at = new Map<string, number>();
  const names = new Map<string, string[]>();
  for (const src of sources) {
    if (src.bucket === null) {
      out.push(src.row);
      continue;
    }
    const seen = at.get(src.bucket);
    const collected = names.get(src.bucket) ?? [];
    if (src.param !== null && !collected.includes(src.param)) collected.push(src.param);
    names.set(src.bucket, collected);
    if (seen === undefined) {
      at.set(src.bucket, out.length);
      out.push({ ...src.row, title: SCHEMA_ROW_TITLE, detail: null, dash: true });
    }
  }
  for (const [bucket, index] of at) {
    const row = out[index];
    const collected = names.get(bucket) ?? [];
    if (row === undefined || collected.length === 0) continue;
    out[index] = { ...row, detail: `${collected.join(', ')} required` };
  }
  return out;
}

/**
 * Split a transmission's graded findings into the two groups the detail pane
 * renders. Advisories are not the caller's to pass (TxDetail splits them off
 * first) and are dropped here as well, so neither group can ever show one.
 *
 * With no shadow lineage the second group is empty and no suffix is computed:
 * the pane then renders exactly what it rendered before this bite.
 */
export function groupDetailFindings(
  findings: readonly FindingView[],
  shadowProfile: Profile | null,
  ctx: DetailGroupContext = {},
): DetailGroups {
  const graded = findings.filter((f) => !isAdvisory(f));
  // Whether the shadow validator ran on this transmission at all — the presence
  // of ANY finding of that lineage, which is the test `verdict()` makes at
  // src/api/verdicts.ts:153. A clean shadow run still writes one `pass` finding,
  // so a lineage that ran is always detectable; nothing here infers it from the
  // session's `shadowProfile`, which only says a shadow lineage is registered.
  const shadowRan = shadowProfile !== null && findings.some((f) => f.profile === shadowProfile);
  const contract: ContractRow[] = graded
    .filter((f) => f.profile === CONTRACT_PROFILE)
    .map((f) => ({ finding: f, alsoFails: alsoFailsClause(f, shadowProfile, shadowRan) }));

  if (shadowProfile === null) return { contract, shadow: [] };

  const signatures = ctx.signatures ?? [];
  const offset = transferredAtPhrase(ctx.body);
  const sources: RowSource[] = graded
    .filter((f) => f.profile === shadowProfile && f.severity === 'fail')
    .map((f) => {
      const key = findingSignatureKey(f);
      // A finding of a transmission in scope always folded into one of the
      // session's signatures — the server rolls them from these same findings —
      // so the null branch is unreachable in practice. It is handled rather than
      // asserted: a row with no button still tells the supplier what failed,
      // where a thrown lookup would blank the whole detail pane.
      const sig = signatures.find((s) => s.key === key) ?? null;
      const bespoke =
        f.keyword === 'pattern' && f.instancePath === '/meta/transferredAt' && offset !== null;
      const collapses = !bespoke && f.keyword === 'required';
      const { pointer, locate } = shadowRowPointer(f, collapses);
      const base = { key, req: f.requirement, pointer, locate, sig };
      const row: ShadowRow = bespoke
        ? { ...base, title: 'transferredAt', detail: offset, dash: false }
        : sig === null
          ? { ...base, title: '', detail: f.detail, dash: false }
          : { ...base, title: sig.title, detail: f.detail, dash: true };
      return {
        row,
        bucket: collapses ? `${f.requirement}|${generalizePath(f.instancePath)}` : null,
        param: f.param,
      };
    });

  return { contract, shadow: collapseRequired(sources) };
}

/** A shadow row as one line of text — the form the tests pin. */
export function shadowRowText(row: ShadowRow): string {
  const head = row.title === '' ? row.req : `${row.req} ${row.title}`;
  if (row.detail === null || row.detail === '') return head;
  return row.dash ? `${head} — ${row.detail}` : `${head} ${row.detail}`;
}

/** The two group headers, each with whatever sits on its right. */
export interface DetailGroupCopy {
  /** Group 1's heading. */
  contractHeading: string;
  /** Group 1's right-hand note, or null when there is none. */
  contractNote: string | null;
  /** Group 2's heading, or null when there is no shadow lineage. */
  shadowHeading: string | null;
}

/** The hint that has always sat in the findings eyebrow. */
const REQ_HINT = 'click § to open the requirement';

/**
 * The group headers.
 *
 * With no shadow lineage there is one group and nothing to distinguish it from,
 * so the eyebrow stays the single line it has always been. With a shadow lineage
 * the heading names the lineage that grades — the point of the split — and the
 * hint moves to the right, where "none — passes" replaces it when the contract
 * found nothing to report.
 */
export function detailGroupCopy(
  shadowProfile: Profile | null,
  contractCount: number,
): DetailGroupCopy {
  if (shadowProfile === null) {
    return {
      contractHeading: `Findings · ${REQ_HINT}`,
      contractNote: null,
      shadowHeading: null,
    };
  }
  return {
    contractHeading: `Findings · ${PROFILE_NAME[CONTRACT_PROFILE]}`,
    contractNote: contractCount === 0 ? 'none — passes' : REQ_HINT,
    shadowHeading: `Would also fail under ${PROFILE_NAME[shadowProfile]}`,
  };
}
