/**
 * AdvisoriesCard (pwd, bite bva slice B) — the dashboard's own surface for the
 * Advisories category, sitting between the filter strip and the two verdict
 * panes.
 *
 * WHAT MAKES IT A NON-VERDICT SURFACE. Three things, deliberately, because a
 * supplier at 100 % conformance must be able to carry advisories with nothing on
 * the page reading as a failure or a defect:
 *
 *   1. It is OUTSIDE both verdict panes. The compliance pane grades the 27 §7
 *      requirements and the transmissions pane grades individual deliveries;
 *      this card belongs to neither and grades nothing. It renders NO StatusPill,
 *      no `§` cross-link (an advisory has no requirement to open), and no
 *      pass/fail tally.
 *   2. It is OUT OF THE STATUS PALETTE. --pass/--fail/--mixed are not used here
 *      at all. In particular NOT --mixed: that amber already means "warning /
 *      outdated" everywhere else on this dashboard (the `pass-outdated` pill, the
 *      OUTDATED SCHEMA tag, soft signature bars, flagged payload lines, the warn
 *      meta cells), so borrowing it would say "a lesser defect" in the one place
 *      that must not say defect at all. The surface takes --accent instead — the
 *      dashboard's informational, non-status colour, which appears in no verdict
 *      — over neutral --surface/--surface-3 chrome.
 *   3. Its COPY says so in words, not only in colour: {@link ADVISORY_COPY}
 *      leads with the non-verdict claim and then with the payload-size argument,
 *      and is pinned against defect vocabulary by advisories.test.ts.
 *
 * It renders NOTHING when the scope holds no advisories — a permanent "no
 * advisories" strip would be noise on every session, and this category is worth
 * a supplier's attention only when there is something in it.
 *
 * Presentational and derived: the fold is the pure {@link foldAdvisories} over
 * the transmissions the dashboard ALREADY fetches (the scope-aware summary
 * read), so there is no new read path and no session-level aggregation endpoint.
 */
import { useMemo, type CSSProperties, type ReactElement } from 'react';

import type { TransmissionView } from '../api';
import {
  ADVISORY_COPY,
  describeSpread,
  describeTally,
  foldAdvisories,
  type AdvisoryGroup,
} from '../advisories';
import { Icon } from './ui/Icon';

export interface AdvisoriesCardProps {
  /**
   * The scoped transmissions from the SUMMARY read (not the paginated list page)
   * — the whole current scope, which is what makes "seen in N of M" honest.
   */
  transmissions: TransmissionView[];
}

const mono: CSSProperties = { fontFamily: 'var(--mono)' };

const eyebrow: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  color: 'var(--text-faint)',
};

/** One folded advisory. Flat and quiet: a label, the spread, and the observation. */
function AdvisoryRow({ group, total }: { group: AdvisoryGroup; total: number }): ReactElement {
  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        background: 'var(--surface-3)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{group.label}</span>
        <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)' }}>{group.id}</span>
        <span style={{ flex: 1 }} />
        <span style={{ ...mono, fontSize: 11, color: 'var(--text-muted)' }}>
          {describeSpread(group, total)}
        </span>
      </div>
      {/* A folded group's detail is one transmission's wording, so it may not
          speak for the rest — say which one it is whenever it stands for more
          than a single occurrence. */}
      {group.count > 1 && (
        <div style={{ ...eyebrow, marginTop: 5 }}>{ADVISORY_COPY.latestEyebrow}</div>
      )}
      {group.latestDetail !== null && (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 3 }}>
          {group.latestDetail}
        </div>
      )}
      {group.latestPointer !== null && (
        <div style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2 }}>
          pointer: {group.latestPointer}
        </div>
      )}
    </div>
  );
}

export function AdvisoriesCard({ transmissions }: AdvisoriesCardProps): ReactElement | null {
  const groups = useMemo(() => foldAdvisories(transmissions), [transmissions]);

  if (groups.length === 0) return null;

  return (
    <div style={{ padding: '16px 16px 0', background: 'var(--canvas)' }}>
      <section
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          // The one strong colour on the card, and it is the accent — never a
          // status tone. See the header for why amber in particular is wrong.
          borderLeft: '3px solid var(--accent)',
          borderRadius: 8,
          boxShadow: 'var(--shadow)',
          padding: '12px 16px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <Icon
            name="info"
            size={13}
            style={{ color: 'var(--accent-text)', alignSelf: 'center' }}
          />
          <span style={{ fontSize: 13, fontWeight: 700 }}>{ADVISORY_COPY.title}</span>
          <span style={{ ...mono, fontSize: 11, color: 'var(--text-faint)' }}>
            · {describeTally(groups)}
          </span>
        </div>
        <p
          style={{
            margin: '5px 0 10px',
            fontSize: 11.5,
            lineHeight: 1.55,
            color: 'var(--text-muted)',
            maxWidth: 720,
          }}
        >
          {ADVISORY_COPY.blurb}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {groups.map((g) => (
            <AdvisoryRow key={g.key} group={g} total={transmissions.length} />
          ))}
        </div>
      </section>
    </div>
  );
}
