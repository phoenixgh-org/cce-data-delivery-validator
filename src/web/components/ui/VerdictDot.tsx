/**
 * VerdictDot / VerdictPair (by1c.12) — how one transmission's verdict under each
 * registered lineage reads at list-row size.
 *
 * The dashboard now grades a payload twice: against the contract in force and,
 * in the shadow, against the DS01.3 proposal. The row already carries a 6px tone
 * dot that COLOURS the contract verdict (pass/mixed/fail), so these dots are
 * deliberately NEUTRAL ink and fog — a second green/red signal beside the first
 * would read as a second defect count, and a shadow failure is not a defect
 * against any obligation in force. Shape carries the verdict here: hollow passes,
 * filled fails.
 *
 * The words come from src/web/profiles.ts, never from a literal: a lineage's name
 * and its "(contract)" role live in one module so the day CONTRACT_PROFILE flips,
 * every tooltip follows (by1c.11).
 */
import type { CSSProperties, ReactElement } from 'react';
import { CONTRACT_PROFILE, type Profile, type Verdict } from '../../api';
import { PROFILE_NAME } from '../../profiles';

/**
 * A dot's rendered state. `na` is "this lineage does not apply here" — reserved
 * for the matrix (e.g. an Attachment 2 clause under DS01.3) and NOT rendered in
 * list rows in this bite; a lineage that simply never ran is dropped from the
 * pair instead, since an absent dot claims nothing.
 */
export type VerdictDotState = 'pass' | 'fail' | 'na';

/** Diameter of one dot, in px. Small enough to sit inside the row's line box. */
const DOT_PX = 11;

/** Gap between the two dots of a pair, in px. */
const PAIR_GAP_PX = 3;

export interface VerdictDotProps {
  state: VerdictDotState;
  /** Native tooltip; normally set on the pair rather than on a single dot. */
  title?: string;
  style?: CSSProperties;
}

/**
 * One 11px verdict dot: hollow with an ink border for a pass, filled ink for a
 * fail, and hollow with a hatched fill and a fog border for not-applicable.
 */
export function VerdictDot({ state, title, style }: VerdictDotProps): ReactElement {
  const hatch = 'repeating-linear-gradient(45deg, var(--text-faint) 0 1px, transparent 1px 3px)';
  return (
    <span
      title={title}
      aria-hidden="true"
      style={{
        display: 'inline-block',
        flexShrink: 0,
        width: DOT_PX,
        height: DOT_PX,
        borderRadius: 999,
        boxSizing: 'border-box',
        border: `1.5px solid ${state === 'na' ? 'var(--text-faint)' : 'var(--text)'}`,
        background: state === 'fail' ? 'var(--text)' : state === 'na' ? hatch : 'transparent',
        ...style,
      }}
    />
  );
}

/** A count of findings, worded: `2 findings`, `1 finding`. */
function findingsPhrase(count: number): string {
  return `${count} ${count === 1 ? 'finding' : 'findings'}`;
}

/**
 * One lineage's half of the pair tooltip — `2025: pass`, `DS01.3: fail (2
 * findings)`, or the not-graded wording when that lineage never ran.
 *
 * A null verdict is NOT a soft fail (api.ts, `Verdict`): the lineage did not run
 * on this transmission, usually because `meta.schemaVersion` fell outside it, so
 * the wording names the cause rather than implying a grade.
 */
function verdictHalf(profile: Profile, verdict: Verdict | undefined, count?: number): string {
  const name = PROFILE_NAME[profile];
  if (verdict === null || verdict === undefined) {
    return `${name}: not graded (unknown schema version)`;
  }
  if (verdict === 'fail' && count !== undefined && count > 0) {
    return `${name}: fail (${findingsPhrase(count)})`;
  }
  return `${name}: ${verdict}`;
}

export interface VerdictPairInput {
  /** The contract lineage's verdict — `tx.verdicts[CONTRACT_PROFILE]`. */
  contract: Verdict | undefined;
  /** The shadow lineage's verdict — `tx.verdicts[shadowProfile] ?? null`. */
  shadow: Verdict | undefined;
  /**
   * The shadow lineage, or null when the service registers none. Null is the
   * hide signal for every shadow surface (api.ts, `SessionMeta.shadowProfile`);
   * it is also what names the lineage, since a verdict carries no name of its own.
   */
  shadowProfile: Profile | null;
  /**
   * Shadow-lineage fail findings on this transmission, shown in the tooltip's
   * parenthetical. Omitted from the text when zero.
   */
  findingsCount?: number;
}

/**
 * The pair's native tooltip: `2025: pass · DS01.3: fail (2 findings)`.
 *
 * Two narrower cases: with no shadow lineage registered the tooltip is the
 * contract half alone, and when the shadow lineage never ran on this
 * transmission it reads `DS01.3: not graded (unknown schema version)` — the one
 * fact the row cannot otherwise show, since the second dot is dropped.
 */
export function verdictPairTitle({
  contract,
  shadow,
  shadowProfile,
  findingsCount,
}: VerdictPairInput): string {
  const contractHalf = verdictHalf(CONTRACT_PROFILE, contract);
  if (shadowProfile === null) return contractHalf;
  if (shadow === null || shadow === undefined) return verdictHalf(shadowProfile, shadow);
  return `${contractHalf} · ${verdictHalf(shadowProfile, shadow, findingsCount)}`;
}

/**
 * The two verdict dots of a list row, 3px apart under a shared tooltip.
 *
 * A dot is rendered only for a lineage that actually graded the transmission:
 * no shadow lineage registered, or a shadow that never ran, leaves ONE dot. The
 * hatched `na` dot is not used here (see {@link VerdictDotState}).
 */
export function VerdictPair(props: VerdictPairInput): ReactElement {
  const { contract, shadow, shadowProfile } = props;
  return (
    <span
      title={verdictPairTitle(props)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: PAIR_GAP_PX,
      }}
    >
      {(contract === 'pass' || contract === 'fail') && <VerdictDot state={contract} />}
      {shadowProfile !== null && (shadow === 'pass' || shadow === 'fail') && (
        <VerdictDot state={shadow} />
      )}
    </span>
  );
}
