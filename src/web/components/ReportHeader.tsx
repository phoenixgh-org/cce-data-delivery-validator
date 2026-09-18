/**
 * ReportHeader (vamh.1) — the dashboard's one-line header: the report title on
 * the left, the scope controls at the right end.
 *
 * It replaces a two-line header and the separate filter strip below the
 * scorecard. The strip's endpoint sentence ("N passing, N with failures across N
 * verifiable requirements") went with it: the summary cards carry those numbers,
 * and a header that restated them made the same count read twice in two nouns.
 * The schema / auth / days-left meta moved to the collapsed setup bar, beside the
 * endpoint it describes (vamh.2).
 *
 * The window segmented control and the source select are lifted verbatim from
 * FilterBar — same sizes, same --accent active fill, same clock/server icons — so
 * nothing about the controls themselves changed, only where they sit.
 *
 * PRESENTATIONAL only: holds no state and fetches nothing. The Dashboard owns
 * `window`/`source` and passes `sources` plus the handlers down, exactly as it
 * did for FilterBar.
 *
 * The controls sit in their own flex row at the right end rather than being
 * positioned individually, so a further control can be added to their LEFT — the
 * grading lens toggle is expected there — without re-laying out the header. That
 * is where the lens toggle now sits (tfnv.5): "Requirements [UNICEF Q1 2025 |
 * DS01.3 DRAFT]", ahead of the window and source controls, because it selects
 * WHAT is being counted while those two select which traffic is counted.
 *
 * The toggle is hidden entirely when the session registers no shadow lineage —
 * `shadowProfile === null` is the hide signal every shadow surface reads — and
 * both its names come from the profile vocabulary, never from a literal here.
 */
import type { ReactElement } from 'react';

import type { Profile, SourceCount } from '../api';
import { CONTRACT_PROFILE } from '../api';
import { PROFILE_NAME } from '../profiles';
import { Icon } from './ui/Icon';

/** Local window union — api.ts types `window` as a plain string. */
export type WindowValue = '15m' | '1h' | '6h' | 'all';

const WINDOWS: SegOption<WindowValue>[] = [
  { v: '15m', label: '15m' },
  { v: '1h', label: '1h' },
  { v: '6h', label: '6h' },
  { v: 'all', label: 'All' },
];

/** Whether the animation-reduced preference is set (guards the seg transition). */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/* ---- small segmented control ---- */

/** One segment: the value it selects and the word on it. */
interface SegOption<T extends string> {
  v: T;
  label: string;
}

interface SegProps<T extends string> {
  value: T;
  options: readonly SegOption<T>[];
  onChange(v: T): void;
  /**
   * Fill behind the ACTIVE segment. Defaults to `--accent`, the fill every
   * segmented control on the page has always used; the lens toggle passes
   * `--draft` so the plum tint starts at the control that selected it.
   */
  activeFill?: string;
}

function Seg<T extends string>({
  value,
  options,
  onChange,
  activeFill = 'var(--accent)',
}: SegProps<T>): ReactElement {
  const transition = prefersReducedMotion() ? undefined : 'background 120ms, color 120ms';
  return (
    <div
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {options.map((o, i) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--sans)',
              padding: '4px 10px',
              border: 'none',
              cursor: 'pointer',
              background: active ? activeFill : 'var(--surface)',
              color: active ? '#fff' : 'var(--text-muted)',
              fontWeight: active ? 600 : 400,
              borderLeft: i ? '1px solid var(--border)' : 'none',
              transition,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export interface ReportHeaderProps {
  window: WindowValue;
  source: string;
  sources: SourceCount[];
  onWindowChange(w: WindowValue): void;
  onSourceChange(s: string): void;
  /**
   * The requirement package the page is read under (tfnv.5). The Dashboard owns
   * it — the header only renders the choice and raises the change.
   */
  lens?: Profile;
  /** The package in force, as the session serves it. */
  contractProfile?: Profile;
  /**
   * The package previewed beside it, or null when the service registers only
   * one. NULL HIDES THE TOGGLE: with one package there is nothing to choose
   * between, and a control offering a single option is a control that does
   * nothing.
   */
  shadowProfile?: Profile | null;
  /** Raised with the package the reader picked. */
  onLensChange?(p: Profile): void;
}

export function ReportHeader({
  window,
  source,
  sources,
  onWindowChange,
  onSourceChange,
  lens = CONTRACT_PROFILE,
  contractProfile = CONTRACT_PROFILE,
  shadowProfile = null,
  onLensChange,
}: ReportHeaderProps): ReactElement {
  const totalCount = sources.reduce((sum, s) => sum + s.count, 0);
  // The two packages, named from the vocabulary, contract first. Built only when
  // there is a second one to offer.
  const lensOptions: SegOption<Profile>[] =
    shadowProfile === null
      ? []
      : [contractProfile, shadowProfile].map((p) => ({ v: p, label: PROFILE_NAME[p] }));
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '10px 24px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 700 }}>Delivery compliance report</span>
      <span style={{ flex: 1 }} />
      {/* Scope controls, right-aligned and ordered window → source. A third
          control belongs at the head of this row, not around it. */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
        {/* Grading lens (tfnv.5) — the requirement package the whole page is
            read under. The active segment fills plum under the draft lens, the
            page's one reserved signal that the numbers are the draft's. */}
        {lensOptions.length > 0 && onLensChange !== undefined && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Requirements</span>
            <Seg
              value={lens}
              options={lensOptions}
              onChange={onLensChange}
              activeFill={lens === contractProfile ? undefined : 'var(--draft)'}
            />
          </span>
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Icon name="clock" size={13} style={{ color: 'var(--text-faint)' }} />
          <Seg value={window} options={WINDOWS} onChange={onWindowChange} />
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Icon name="server" size={13} style={{ color: 'var(--text-faint)' }} />
          <select
            value={source}
            onChange={(e) => onSourceChange(e.target.value)}
            style={{
              fontFamily: 'var(--sans)',
              fontSize: 11.5,
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'var(--surface)',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            <option value="all">All sources ({totalCount})</option>
            {sources.map((s) => (
              <option key={s.source} value={s.source}>
                {s.sourceLabel} ({s.count})
              </option>
            ))}
          </select>
        </span>
      </div>
    </header>
  );
}
