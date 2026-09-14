/**
 * FilterBar (4h4.8) — the scoped filter strip that drives the scorecard,
 * compliance summary, trend, and list together (README §Screens → scale rework).
 *
 * PRESENTATIONAL only: holds no state and fetches nothing. The Dashboard scope
 * state (4h4.9) owns `window`/`source` and passes `sources`/`scoped` + handlers
 * down. Ported from design_handoff_scale_at_volume/redesign/proto-dashboard.jsx
 * (`Seg`/`FilterBar`/`WINDOWS`), remapped to the LANDED api.ts types:
 *  - one `SourceCount[]` (count is INLINE per source — no srcCounts map / srcCode
 *    helper); each option value is the RAW source key (`""` for the unknown
 *    bucket), with an `"all"` sentinel. "All sources (N)" sums sources[].count.
 *  - the right readout reads the `ScopeTotals` object.
 */
import type { ReactElement } from 'react';
import type { Profile, ShadowProvenance, SourceCount, ScopeTotals } from '../api';
import { gradingLegend } from '../profiles';
import { Icon } from './ui/Icon';

/** Local window union — api.ts types `window` as a plain string. */
export type WindowValue = '15m' | '1h' | '6h' | 'all';

interface WindowOption {
  v: WindowValue;
  label: string;
}

const WINDOWS: WindowOption[] = [
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
interface SegProps {
  value: WindowValue;
  options: WindowOption[];
  onChange(v: WindowValue): void;
}

function Seg({ value, options, onChange }: SegProps): ReactElement {
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
              background: active ? 'var(--accent)' : 'var(--surface)',
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

/* ---- scoped filter bar (drives both cards + trend) ---- */
export interface FilterBarProps {
  window: WindowValue;
  source: string;
  sources: SourceCount[];
  scoped: ScopeTotals;
  onWindowChange(w: WindowValue): void;
  onSourceChange(s: string): void;
  /**
   * The lineage graded in the shadow, or null when the service registers only
   * one (by1c.11). NULL IS THE HIDE SIGNAL — the legend then names the contract
   * alone. Passed down rather than re-derived from finding sets, so a session
   * with no shadow findings yet still reads correctly.
   */
  shadowProfile: Profile | null;
  /** The shadow lineage's vendored bytes, for the legend's draft date. */
  shadow: ShadowProvenance | null;
}

/**
 * The legend's tooltip (by1c.11, verbatim). It says which lineage the numbers a
 * supplier is graded on come from, and where the shadow lineage's answers show
 * up instead — the shadow is previewed, never scored.
 */
export const GRADING_LEGEND_TITLE =
  'The matrix and pass rate grade against the 2025 requirements. DS01.3 is graded in the ' +
  'shadow and shown in the readiness strip, the second verdict column and the transmission ' +
  'detail.';

export function FilterBar({
  window,
  source,
  sources,
  scoped,
  onWindowChange,
  onSourceChange,
  shadowProfile,
  shadow,
}: FilterBarProps): ReactElement {
  // Read-only text: no control, no state, no hover. The bar already wraps, so at
  // narrow widths the legend drops to its own line rather than crushing the
  // scope readout.
  const legend = gradingLegend(shadowProfile, shadow);
  const totalCount = sources.reduce((sum, s) => sum + s.count, 0);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '9px 24px',
        background: 'var(--surface-3)',
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap',
      }}
    >
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
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
        <strong style={{ color: 'var(--text)' }}>{scoped.scoped}</strong> tx
        {' · '}
        <span style={{ color: scoped.withFailures ? 'var(--fail)' : 'var(--text-muted)' }}>
          {scoped.withFailures} with failures
        </span>
        {' · '}
        <span style={{ color: scoped.distinctIssues ? 'var(--mixed)' : 'var(--text-muted)' }}>
          {scoped.distinctIssues} distinct issue{scoped.distinctIssues === 1 ? '' : 's'}
        </span>
      </span>
      <span
        title={GRADING_LEGEND_TITLE}
        style={{
          marginLeft: 'auto',
          fontSize: 11.5,
          fontFamily: 'var(--sans)',
          color: 'var(--text-muted)',
        }}
      >
        Grading: <strong style={{ color: 'var(--text)' }}>{legend.contract}</strong>
        {legend.shadow !== null && (
          <>
            {' · shadow: '}
            {legend.shadow.name}{' '}
            <span style={{ fontFamily: 'var(--mono)' }}>{legend.shadow.detail}</span>
          </>
        )}
      </span>
    </div>
  );
}
