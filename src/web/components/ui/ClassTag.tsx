/**
 * Plain-language verifiability tag for the redesigned dashboard (108.2). This
 * replaces the §7 glyph legend: it renders a ComplianceClass as an uppercase
 * mono label, tooltipped with the class blurb. Gradeable classes (verified /
 * heuristic) use --text-muted; the rest are de-emphasized in --text-faint.
 */
import type { CSSProperties, ReactElement } from 'react';
import type { ComplianceClass } from '../../api';
import { CLASS_META } from './statusMaps';

export interface ClassTagProps {
  cls: ComplianceClass;
  /** Slightly fade the tag (e.g. inside an already-dimmed row). */
  muted?: boolean;
  style?: CSSProperties;
}

export function ClassTag({ cls, muted, style }: ClassTagProps): ReactElement {
  const meta = CLASS_META[cls];
  return (
    <span
      title={meta.blurb}
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        fontFamily: 'var(--mono)',
        color: meta.gradeable ? 'var(--text-muted)' : 'var(--text-faint)',
        opacity: muted ? 0.85 : 1,
        ...style,
      }}
    >
      {meta.label}
    </span>
  );
}
