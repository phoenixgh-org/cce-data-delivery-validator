/**
 * LensBanner (tfnv.5) — the persistent strip under the setup bar saying that the
 * page in front of the reader is graded against the DS01.3 draft.
 *
 * WHY IT IS PERSISTENT. The grading lens switches the ENTIRE report between two
 * requirement packages: the obligations in force and the unpublished DS01.3
 * proposal. Every number below it changes meaning with that switch, and the only
 * other marks of it are a segmented control in the header and a plum hairline
 * round the page's five cards — easy to miss on a page that otherwise looks the
 * same, and
 * costly to miss, because a supplier who reads draft failures as contract
 * failures will work on obligations nobody has placed on them yet. So the banner
 * states the package, dates the bytes it came from, and offers the way back.
 *
 * WHAT IT NEVER SAYS. The draft is not "the new requirements" and the contract
 * package is not "the old" ones — the vocabulary is binding (src/web/profiles.ts)
 * and every name here is composed from {@link PROFILE_NAME}. "DRAFT" is allowed
 * because it names what the bytes ARE: an unpublished proposal.
 *
 * PRESENTATIONAL only: no state, no fetch. The Dashboard owns the lens, mounts
 * this only while a non-contract package is selected, and takes the flip back.
 */
import type { ReactElement } from 'react';

import type { Profile, ShadowProvenance } from '../api';
import { PROFILE_NAME, formatDraftDateLong } from '../profiles';

export interface LensBannerProps {
  /** The package being read — the one the banner names. */
  lens: Profile;
  /** The package in force, named by the way-back button. */
  contractProfile: Profile;
  /**
   * The lens package's vendored bytes, as the session serves them. `draftDate`
   * present is what licenses dating the sentence (api.ts, `ShadowProvenance`);
   * absent — a published entry, or a session that served no shadow provenance at
   * all — the clause is dropped rather than guessed at.
   */
  shadow: ShadowProvenance | null;
  /** Raised with the contract package when the way-back button is pressed. */
  onLensChange(p: Profile): void;
}

/**
 * The package name with a trailing draft marker removed: `"DS01.3 DRAFT"` →
 * `"DS01.3"`.
 *
 * The banner's sentence supplies the word "draft" itself ("the DS01.3 preview
 * draft"), so a name that already carries the marker would say it twice (tfnv.1):
 * the vocabulary names this lineage "DS01.3 DRAFT", and "the DS01.3 DRAFT preview
 * draft" reads as a stutter. A lineage whose name says nothing about draft-ness
 * passes through unchanged, because the draft-ness is a fact about the bytes
 * rather than about the name.
 */
function packageNoun(profile: Profile): string {
  return PROFILE_NAME[profile].replace(/\s+draft$/i, '');
}

/**
 * The sentence under the eyebrow. Dated when the entry is an unpublished
 * proposal; otherwise the bare statement — a published package has a version
 * rather than a date, and the banner's job there is only to say which package is
 * being read.
 */
export function lensBannerSentence(lens: Profile, shadow: ShadowProvenance | null): string {
  const noun = packageNoun(lens);
  const draftDate = shadow?.draftDate;
  if (draftDate === undefined) return `Graded against the ${noun} draft.`;
  return `Graded against the ${noun} preview draft (not yet published), as of ${formatDraftDateLong(draftDate)}.`;
}

export function LensBanner({
  lens,
  contractProfile,
  shadow,
  onLensChange,
}: LensBannerProps): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 24px',
        background: 'var(--draft-bg)',
        borderBottom: '1px solid var(--draft-border)',
        color: 'var(--draft)',
        fontSize: 11.5,
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
        }}
      >
        {PROFILE_NAME[lens]}
      </span>
      <span>{lensBannerSentence(lens, shadow)}</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={() => onLensChange(contractProfile)}
        style={{
          fontFamily: 'var(--sans)',
          fontSize: 11.5,
          fontWeight: 600,
          color: 'var(--draft)',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      >
        {`Back to ${PROFILE_NAME[contractProfile]} ▸`}
      </button>
    </div>
  );
}
