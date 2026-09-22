/**
 * The ADVISORY badge (398e) — the one badge that says "this row is an advisory",
 * shared by the compliance column's advisory row and the transmission detail's
 * advisory row.
 *
 * WHY IT EXISTS AS A COMPONENT. Both cards carry the mark, they are read minutes
 * apart on the same screen, and an advisory is the one category on this dashboard
 * whose whole job is to not look like a verdict. Two copies of the mark would
 * eventually disagree about what an advisory looks like, which is the drift
 * Tag.tsx was written to prevent for TIGHTENED.
 *
 * WHY IT IS PILL-SHAPED. Every other row in both cards opens with a StatusPill,
 * so a row with an empty leading slot reads as a different, unexplained kind of
 * thing rather than as a row with nothing to grade. It therefore takes the pill's
 * geometry (`PILL_SHELL`: mono 11px, weight 600, pill radius) and not the 10px
 * uppercase Tag, so the leading column is one column of one shape.
 *
 * WHY THE ACCENT, AND WHY NOT A StatusKind. The colour is the indigo accent pair
 * the compliance column already used for this mark — `--accent-text` on
 * `--accent-weak` — which `sigTone()` in ComplianceCard.tsx argues for at length:
 * the advisory surface takes accent and neutrals and never a status colour, the
 * --mixed amber least of all, because that amber means warning/outdated
 * everywhere else here.
 *
 * The tone is NOT registered as a sixth `StatusKind` in statusMaps.ts, though the
 * colours would have fitted there. That module is the VERDICT vocabulary: its
 * kinds are reachable only through `STATUS_META`, which is keyed by the real
 * `DisplayStatus` union, so an advisory kind would be an entry no status can ever
 * select — a colour family for a thing that has no verdict (DESIGN §7.1) sitting
 * in the table that exists to map verdicts. Sharing the SHAPE and keeping the
 * tone out of the status tables is what says pill-shaped, not graded.
 */
import type { ReactElement } from 'react';
import { PILL_SHELL } from './StatusPill';

/** A pill-shaped `advisory` badge in the accent tone. Takes no props. */
export function AdvisoryBadge(): ReactElement {
  return (
    <span
      style={{
        ...PILL_SHELL,
        color: 'var(--accent-text)',
        background: 'var(--accent-weak)',
      }}
    >
      advisory
    </span>
  );
}
