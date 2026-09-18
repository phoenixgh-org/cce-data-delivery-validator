/**
 * The docked detail's findings list (by1c.14, tfnv.7) — the translation, the
 * copy and the row phrasing, with no markup, so every rule below is testable on
 * the Node runner.
 *
 * WHY THIS SHAPE. A transmission is graded twice — against the contract in force
 * and, where its `meta.schemaVersion` reaches the other validator, against the
 * DS01.3 draft — and the pane used to SPLIT those two sets: the contract's
 * findings first, then a "Would also fail under DS01.3 DRAFT" group, with a
 * "· also 5.1.3" suffix marking the contract failures that carried forward. That
 * asked a supplier to hold two numbering systems at once and gave a DS01.3
 * requirement no row to open.
 *
 * The grading lens replaces it (epic tfnv). The reader selects ONE requirement
 * package, and this pane lists that package's findings in that package's
 * numbering:
 *
 *   - Which findings: every non-advisory finding the lens shows somewhere, i.e.
 *     whose {@link clauseUnderLens} is non-null. Under the contract lens that is
 *     exactly the contract lineage, as it always was; under the draft lens it is
 *     the DS01.3 findings plus the contract findings the clause map carries
 *     forward — §3.2 excepted, since Annex 4 re-runs that clause and files its
 *     own result.
 *   - Under which id: the lens's. A translated row keeps its stored 2025 id in
 *     {@link FindingRow.storedId} so the pane can name where the number came from.
 *
 * TWO ROW SHAPES, one list. A FAILURE of the lens's own lineage keeps the
 * phrasing the shadow group had — the `required` collapse, the generalized
 * pointer, the title off the matching signature, the bespoke `transferredAt`
 * line — because that phrasing exists to make a schema run readable and it is
 * still a schema run. Everything else is a {@link FindingRow}: the finding as the
 * pane has always rendered it, with its severity pill and its own detail.
 *
 * Every package name comes from {@link PROFILE_NAME}; nothing here writes
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
import { clauseUnderLens, tightenedUnderLens } from './clauseMap';
import { PROFILE_NAME } from './profiles';
import { findingSignatureKey, generalizePath } from './signatureKey';

/** Title of the collapsed `required` row — the defect is the payload's shape. */
const SCHEMA_ROW_TITLE = 'schema';

/** What both row shapes carry: where the lens files the row, and how it is tagged. */
interface RowIdentity {
  /** The clause id under the selected lens — what the row shows and links to. */
  id: string;
  /**
   * Whether the lens's clause TIGHTENED what conformance means. False under the
   * contract lens, which is the package a tightening would be measured against.
   */
  tightened: boolean;
}

/** A finding rendered as the pane has always rendered one: pill, id, detail. */
export interface FindingRow extends RowIdentity {
  kind: 'finding';
  /**
   * The finding's STORED requirement id when the lens translated it, else null.
   * Findings are stored on 2025 numbering (bd memory
   * `requirement-numbering-2025-retained`) and translated at read time, so a row
   * under the draft lens says §5.1.6 where the database says §1.4 — the pane
   * names the other id rather than hiding the translation.
   */
  storedId: string | null;
  finding: FindingView;
}

/**
 * A FAILURE of the lens's own lineage, phrased for reading rather than for
 * grading. Rendered as `{id} {title} — {detail}`, the dash omitted when
 * {@link ClauseRow.dash} is false (the bespoke `transferredAt` phrasing reads as
 * one clause, not as a label and a value).
 */
export interface ClauseRow extends RowIdentity {
  kind: 'clause';
  /** Signature key of the folded defect — the cross-filter the row's button sets. */
  key: string;
  /** Body-face label; empty when no signature matched and the detail carries the row. */
  title: string;
  /** Monospace tail, or null. */
  detail: string | null;
  /** Whether an em dash separates title from detail. */
  dash: boolean;
  /** The pointer shown under the row, or null — see {@link RowPointer}. */
  pointer: string | null;
  /** The concrete path the raw-payload inspector opens at, or null. */
  locate: string | null;
  /** The signature this row cross-filters to, or null when none matched. */
  sig: Signature | null;
}

/** One row of the docked detail's single findings list. */
export type DetailRow = FindingRow | ClauseRow;

/**
 * The JSON Pointer a clause row shows, and the one its `pointer:` button opens
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
 * finding row does. `pointer` null renders no line at all, again the same.
 */
export interface RowPointer {
  /** The pointer as text under the row, generalized for a collapsed row. */
  pointer: string | null;
  /** The concrete path the inspector scrolls to, or null when there is none. */
  locate: string | null;
}

/** {@link RowPointer} for one finding — `collapses` is the `required` fold. */
export function rowPointer(f: FindingView, collapses: boolean): RowPointer {
  const own = f.instancePath ?? f.pointer;
  if (own === null || own === '') return { pointer: f.pointer, locate: null };
  return { pointer: collapses ? generalizePath(own) : own, locate: own };
}

/** What {@link detailRows} needs beyond the findings themselves. */
export interface DetailRowContext {
  /** The session's signatures — the title and click target of a clause row. */
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
  row: ClauseRow;
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
export function collapseRequired(sources: readonly RowSource[]): ClauseRow[] {
  const out: ClauseRow[] = [];
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
 * The docked detail's findings list under the selected package.
 *
 * Advisories are not the caller's to pass (TxDetail splits them off first) and
 * are dropped here as well, so no row can ever be one.
 *
 * ORDER: the findings the lens translates, in the order the transmission carries
 * them, then the lens lineage's own failures. Under the contract lens the second
 * set is empty and the list is exactly what the pane rendered before the lens —
 * the same rows, the same ids, without the "· also" suffix.
 */
export function detailRows(
  findings: readonly FindingView[],
  lens: Profile,
  contractProfile: Profile = CONTRACT_PROFILE,
  ctx: DetailRowContext = {},
): DetailRow[] {
  const graded = findings.filter((f) => !isAdvisory(f));
  const draftLens = lens !== contractProfile;
  /** A failure of the lens's OWN lineage: the rows that keep the schema phrasing. */
  const phrased = (f: FindingView): boolean =>
    draftLens && f.profile === lens && f.severity === 'fail';

  const rows: DetailRow[] = [];
  for (const f of graded) {
    if (phrased(f)) continue;
    const id = clauseUnderLens(f, lens, contractProfile);
    if (id === null) continue;
    rows.push({
      kind: 'finding',
      id,
      storedId: id === f.requirement ? null : f.requirement,
      tightened: draftLens && tightenedUnderLens(id),
      finding: f,
    });
  }

  const signatures = ctx.signatures ?? [];
  const offset = transferredAtPhrase(ctx.body);
  const sources: RowSource[] = graded.filter(phrased).map((f) => {
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
    const { pointer, locate } = rowPointer(f, collapses);
    const base = {
      kind: 'clause' as const,
      id: f.requirement,
      tightened: tightenedUnderLens(f.requirement),
      key,
      pointer,
      locate,
      sig,
    };
    const row: ClauseRow = bespoke
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

  return [...rows, ...collapseRequired(sources)];
}

/** A clause row as one line of text — the form the tests pin. */
export function clauseRowText(row: ClauseRow): string {
  const head = row.title === '' ? row.id : `${row.id} ${row.title}`;
  if (row.detail === null || row.detail === '') return head;
  return row.dash ? `${head} — ${row.detail}` : `${head} ${row.detail}`;
}

/** The findings list's heading and whatever sits on its right. */
export interface DetailGroupCopy {
  /** The eyebrow above the list. */
  heading: string;
  /** The right-hand note: the § hint, or the empty case stated. */
  note: string;
}

/** The hint that has always sat in the findings eyebrow. */
const REQ_HINT = 'click § to open the requirement';

/**
 * The list's copy.
 *
 * The heading names the package the list is numbered in, because that is the
 * question a reader of two packages has: not "are these findings" but "findings
 * against what". The hint sits on the right, where "none — passes" replaces it
 * when the selected package found nothing to report.
 */
export function detailGroupCopy(lens: Profile, rowCount: number): DetailGroupCopy {
  return {
    heading: `Findings · ${PROFILE_NAME[lens]}`,
    note: rowCount === 0 ? 'none — passes' : REQ_HINT,
  };
}
