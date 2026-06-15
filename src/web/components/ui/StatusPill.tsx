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
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.02em',
        color: c.fg,
        background: c.bg,
        border: meta.kind === 'dead' ? '1px solid var(--border)' : 'none',
        fontFamily: 'var(--mono)',
        whiteSpace: 'nowrap',
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
