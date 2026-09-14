/**
 * ReadinessStrip (by1c.13) — how much of a supplier's ALREADY-CONFORMANT traffic
 * would survive the DS01.3 proposal, and what stands in the way.
 *
 * The scorecard's headline grades the contract in force. This strip sits under
 * it and answers a different question: of the transmissions that pass today, how
 * many would still pass if the draft became the contract. Everything it shows is
 * read off `readiness` (src/api/verdicts.ts), which is folded over the
 * contract-PASSING transmissions in the current scope — so a transmission that
 * already fails the contract contributes no reason here, and `failuresOnly` in
 * the list has no effect on these numbers.
 *
 * Three rules keep the strip from ever making a claim it cannot support:
 *
 *  1. NO SHADOW LINEAGE, NO STRIP. `session.shadowProfile === null` is the hide
 *     signal for every shadow surface (api.ts) and `readiness === null` is the
 *     same condition seen from the other side.
 *  2. NO CONTRACT-PASSING TRAFFIC, NO STRIP. "0 of 0 would still pass" is a
 *     readiness claim about nothing; the strip stays out of the way until there
 *     is conformant traffic to be ready with.
 *  3. THE WORDS COME FROM src/web/profiles.ts. "DS01.3" is read from
 *     PROFILE_NAME, never written as a literal here, and the strip never calls
 *     either lineage old, new, stale, current or latest (by1c.11): a supplier
 *     bound to a 2025 LTA is conformant, and this strip is a preview, not a
 *     verdict against anything in force.
 *
 * A reason row is a cross-filter button carrying the shadow Signature straight
 * to the Dashboard's existing `onSelectSignature`, exactly as ComplianceCard's
 * SigRow does — the list filters, the chip picks up its "DS01.3 · " prefix from
 * the signature's own profile (by1c.12), and the docked detail follows. Hence
 * the active row wearing the same `--accent-weak` fill: it is the same selection.
 */
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { Profile, Readiness, Signature } from '../api';
import { PROFILE_NAME } from '../profiles';
import { Icon } from './ui/Icon';

/** Reason rows shown before the "+N more reasons" toggle is used. */
const MAX_COLLAPSED_REASONS = 3;

/** Skeleton placeholder rows — the height of {@link MAX_COLLAPSED_REASONS} reasons. */
export const SKELETON_ROWS = MAX_COLLAPSED_REASONS;

/** Height of one reason row, in px. The skeleton rows match it so nothing shifts. */
const REASON_ROW_PX = 32;

/** The dim qualifier beside the strip's title, on every variant that has a title. */
const EYEBROW = 'shadow-graded';

/** Stable empty list, so the reset effect below does not fire on every render. */
const NO_REASONS: readonly Signature[] = [];

/**
 * What the strip says, decided before anything renders.
 *
 * `skeleton` is the summary-not-loaded variant. It is prop-driven (`readiness`
 * undefined) rather than reached through the Dashboard's phase machine, which
 * today renders a whole-page "Loading…" on first load.
 */
export type ReadinessCopy =
  | { kind: 'hidden' }
  | { kind: 'skeleton'; title: string; eyebrow: string }
  | { kind: 'collapsed'; line: string }
  | { kind: 'header'; title: string; eyebrow: string; count: number; rest: string };

/**
 * The strip's text, and whether there is a strip at all.
 *
 * `readiness` is `undefined` while the summary read is in flight, `null` when the
 * service registers no shadow lineage. The two are not the same absence: one is
 * a skeleton, the other is nothing at all.
 */
export function readinessCopy(
  readiness: Readiness | null | undefined,
  shadowProfile: Profile | null,
): ReadinessCopy {
  if (shadowProfile === null) return { kind: 'hidden' };
  const title = `${PROFILE_NAME[shadowProfile]} readiness`;
  if (readiness === undefined) return { kind: 'skeleton', title, eyebrow: EYEBROW };
  if (readiness === null) return { kind: 'hidden' };
  const { passingContract, passingBoth } = readiness;
  if (passingContract === 0) return { kind: 'hidden' };
  if (passingBoth === passingContract) {
    return {
      kind: 'collapsed',
      line: `${title} · all ${passingContract} passing tx would still pass`,
    };
  }
  return {
    kind: 'header',
    title,
    eyebrow: EYEBROW,
    count: passingBoth,
    rest: ` of ${passingContract} passing tx would still pass`,
  };
}

/**
 * The reasons on screen, and how many the toggle is holding back.
 *
 * The server hands `readiness.reasons` over txCount descending (verdicts.ts:
 * `.sort((a, b) => b.txCount - a.txCount || …)`), so the first three are the most
 * widespread and no re-sort happens here.
 */
export function visibleReasons(
  reasons: readonly Signature[],
  expanded: boolean,
): { shown: readonly Signature[]; hiddenCount: number } {
  if (expanded) return { shown: reasons, hiddenCount: 0 };
  return {
    shown: reasons.slice(0, MAX_COLLAPSED_REASONS),
    hiddenCount: Math.max(0, reasons.length - MAX_COLLAPSED_REASONS),
  };
}

/**
 * The expand/collapse affordance's label, or null when every reason already fits.
 * Takes the TOTAL because the collapse-back label has to exist after
 * {@link visibleReasons} has reported a hidden count of zero.
 */
export function reasonsToggleLabel(total: number, expanded: boolean): string | null {
  if (total <= MAX_COLLAPSED_REASONS) return null;
  return expanded ? 'fewer reasons ◂' : `+${total - MAX_COLLAPSED_REASONS} more reasons ▸`;
}

export interface ReadinessStripProps {
  /**
   * The scope's readiness numbers: `undefined` while the summary read is in
   * flight (skeleton), `null` when no shadow lineage is registered (hidden).
   */
  readiness: Readiness | null | undefined;
  /** The shadow lineage, or null — the hide signal, and what names the strip. */
  shadowProfile: Profile | null;
  /** The list's active cross-filter, so the matching reason row reads as picked. */
  activeSignatureKey: string | null;
  /** The Dashboard's existing signature cross-filter. */
  onSelectSignature: (sig: Signature) => void;
}

/** Shared outer block — the inset surface both the skeleton and the strip sit in. */
function Inset({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      style={{
        marginTop: 10,
        padding: '6px 8px',
        background: 'var(--surface-3)',
        border: '1px solid var(--accent-weak)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {children}
    </div>
  );
}

/** The title and its dim qualifier, shared by the skeleton and the full strip. */
function StripTitle({ title, eyebrow }: { title: string; eyebrow: string }): ReactElement {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{eyebrow}</span>
    </span>
  );
}

/**
 * One reason: a shadow signature standing between the two counts. The whole row
 * is the button, so the click target matches the row a supplier is reading.
 */
function ReasonRow({
  sig,
  active,
  onPick,
}: {
  sig: Signature;
  active: boolean;
  onPick: (sig: Signature) => void;
}): ReactElement {
  return (
    <button
      onClick={() => onPick(sig)}
      title="View these transmissions"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 50px',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        minHeight: REASON_ROW_PX,
        textAlign: 'left',
        padding: '4px 6px',
        borderRadius: 6,
        cursor: 'pointer',
        border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
        background: active ? 'var(--accent-weak)' : 'transparent',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 12,
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {sig.title}
        </span>
        <span
          style={{
            display: 'block',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--text-faint)',
          }}
        >
          {sig.req}
        </span>
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 4,
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          color: 'var(--text-muted)',
        }}
      >
        {sig.txCount}
        <Icon name="arrowRight" size={12} />
      </span>
    </button>
  );
}

/**
 * The readiness strip, or null when one of the three hide rules applies.
 *
 * The expand state is local because it is a view preference over one list, not
 * something any other surface reads. It resets when the reasons array identity
 * changes — a scope change re-fetches and re-renders in place (3ta), and leaving
 * the strip expanded over a different set of reasons would silently widen what
 * the next reader sees.
 */
export function ReadinessStrip({
  readiness,
  shadowProfile,
  activeSignatureKey,
  onSelectSignature,
}: ReadinessStripProps): ReactElement | null {
  const reasons = readiness?.reasons ?? NO_REASONS;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [reasons]);

  const copy = readinessCopy(readiness, shadowProfile);
  if (copy.kind === 'hidden') return null;

  if (copy.kind === 'skeleton') {
    return (
      <Inset>
        <StripTitle title={copy.title} eyebrow={copy.eyebrow} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <span
              key={i}
              aria-hidden="true"
              style={{
                height: REASON_ROW_PX,
                borderRadius: 6,
                background: 'var(--border)',
                opacity: 0.45,
              }}
            />
          ))}
        </div>
      </Inset>
    );
  }

  if (copy.kind === 'collapsed') {
    return (
      <Inset>
        <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{copy.line}</span>
      </Inset>
    );
  }

  const { shown, hiddenCount } = visibleReasons(reasons, expanded);
  const toggle = reasonsToggleLabel(reasons.length, expanded);
  return (
    <Inset>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <StripTitle title={copy.title} eyebrow={copy.eyebrow} />
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          <strong style={{ fontWeight: 700, color: 'var(--text)' }}>{copy.count}</strong>
          {copy.rest}
        </span>
      </div>
      {shown.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
          {shown.map((sig) => (
            <ReasonRow
              key={sig.key}
              sig={sig}
              active={sig.key === activeSignatureKey}
              onPick={onSelectSignature}
            />
          ))}
        </div>
      )}
      {toggle !== null && (
        <button
          onClick={() => setExpanded((v) => !v)}
          title={hiddenCount > 0 ? 'Show every reason' : 'Show the top reasons only'}
          style={{
            alignSelf: 'flex-start',
            marginTop: 4,
            padding: '2px 6px',
            fontSize: 11,
            color: 'var(--accent-text)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {toggle}
        </button>
      )}
    </Inset>
  );
}
