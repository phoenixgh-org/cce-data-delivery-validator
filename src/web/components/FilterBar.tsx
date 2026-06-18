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
import type { SourceCount, ScopeTotals } from '../api';
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
}

export function FilterBar({
  window,
  source,
  sources,
  scoped,
  onWindowChange,
  onSourceChange,
}: FilterBarProps): ReactElement {
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
    </div>
  );
}
