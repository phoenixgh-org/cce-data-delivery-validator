/**
 * Tag (tfnv.7) — the small uppercase pill that marks a requirement row or a
 * finding row as something other than plain: TIGHTENED in the docked detail
 * today, and the compliance card's TIGHTENED and NEW rows next (tfnv.6).
 *
 * It exists as a component, rather than as a style object copied into each
 * caller, so the two cards cannot drift into two sizes of the same badge. It is
 * deliberately minimal: a label, and the two colours that say which kind of mark
 * it is. Anything more — an icon, a tooltip variant, a tone table — belongs to
 * the caller that needs it.
 *
 * The default colours are the LENS TINT (the plum reserved for the grading lens,
 * src/web/styles.css), because every mark it carries today describes the DS01.3
 * draft rather than the obligations in force.
 */
import type { ReactElement } from 'react';

export interface TagProps {
  /** The word on the pill. Rendered as given; the style uppercases it. */
  label: string;
  /** Native tooltip, where the word alone does not carry the claim. */
  title?: string;
  /** Ink colour. Defaults to the lens tint. */
  color?: string;
  /** Ground colour. Defaults to the lens tint's ground. */
  background?: string;
}

/** A 10px uppercase pill: `TIGHTENED`, `NEW`. */
export function Tag({
  label,
  title,
  color = 'var(--draft)',
  background = 'var(--draft-bg)',
}: TagProps): ReactElement {
  return (
    <span
      title={title}
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '.05em',
        lineHeight: 1.4,
        padding: '1px 6px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color,
        background,
      }}
    >
      {label}
    </span>
  );
}
