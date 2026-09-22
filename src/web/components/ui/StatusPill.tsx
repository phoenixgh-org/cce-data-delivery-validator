/**
 * Pill-shaped status badge for the redesigned dashboard (108.2). Mono, 11px,
 * weight 600. Colour is driven by the DisplayStatus -> StatusMeta map; the
 * "dead" kind (non-gradeable / self-attested / n/a / deferred) renders as
 * --text-faint text on a transparent bg with a 1px --border, with no status
 * colour. An optional leading dot echoes the foreground colour.
 */
import type { CSSProperties, ReactElement } from 'react';
import type { DisplayStatus } from '../../api';
import { STATUS_KIND_COLORS, STATUS_META } from './statusMaps';

/**
 * The pill's GEOMETRY, with no colour in it — exported so a badge that is NOT a
 * verdict can take the same shape without becoming one (398e; `AdvisoryBadge` in
 * AdvisoryBadge.tsx is the only such badge today).
 *
 * It lives here rather than being retyped by each badge for the reason Tag.tsx
 * gives for existing at all: a shape copied into a second caller drifts into two
 * sizes of the same badge, and these are read side by side in one column where a
 * pixel of difference shows.
 */
export const PILL_SHELL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.02em',
  fontFamily: 'var(--mono)',
  whiteSpace: 'nowrap',
};

export interface StatusPillProps {
  status: DisplayStatus;
  /** Render a leading colour dot before the label. */
  dot?: boolean;
  style?: CSSProperties;
}

export function StatusPill({ status, dot, style }: StatusPillProps): ReactElement {
  const meta = STATUS_META[status];
  const c = STATUS_KIND_COLORS[meta.kind];
  return (
    <span
      style={{
        ...PILL_SHELL,
        color: c.fg,
        background: c.bg,
        border: meta.kind === 'dead' ? '1px solid var(--border)' : 'none',
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: c.fg,
            display: 'inline-block',
          }}
        />
      )}
      {meta.label}
    </span>
  );
}
