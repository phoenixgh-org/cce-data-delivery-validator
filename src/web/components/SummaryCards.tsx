/**
 * SummaryCards (vamh.3) — the two summary cards that sit above the two-pane
 * body, one per column.
 *
 * They replace the scorecard strip's headline row. The strip put three big
 * numbers counting REQUIREMENTS directly above a ribbon counting TRANSMISSIONS,
 * both labelled "with failures", and nothing on it named either noun — so the
 * requirement counts were read as transmission counts (owner, 2026-09-17). The
 * fix is not new numbers but a home for each: the REQUIREMENTS card carries the
 * rollup, the TRANSMISSIONS card carries the scope totals, and each card sits on
 * the surface colour of the pane it summarises so the pairing is visible before
 * the labels are read.
 *
 * SERVED, NOT DERIVED. Every numeral comes from `rollup` (src/api/scope.ts
 * `Rollup`) or `scoped` (`ScopeTotals`) exactly as served — there is no client
 * recompute here, and adding one would let this surface disagree with the panes
 * beneath it. The copy around the numerals is literal in this file rather than
 * composed from the data, so a reader of the component sees the sentence the
 * supplier sees.
 *
 * The p98 disclosure is INLINE here (closes 6o0u). Reports that named no
 * appliance are excluded from the unit count, and until now the only sign of
 * them was the units tooltip: a reader who did not hover saw "3 CCE units" with
 * nothing to say other reports had been dropped from it. The clause states the
 * count on the page and appears only when it is nonzero, because "0 reports
 * named no appliance" is noise on every healthy session. {@link unitsTitle}
 * stays as the units figure's title attribute — it carries the identifier rule
 * and the DESIGN §7 caveat that this counts what was received, not the fleet.
 *
 * PRESENTATIONAL only: no state, no fetch, no handlers. The cards match the pane
 * cards' chrome (1px --border-strong, 8px radius, --shadow) and the panes' own
 * flex bases, so each card's edges line up with the pane below it.
 */
import type { ReactElement, ReactNode } from 'react';

import type { Rollup, ScopeTotals } from '../api';
// The gutter and the two flex bases are the panes' own (src/web/layout.ts): the
// cards and the panes read one source, so a pane change moves the card row with
// it instead of silently misaligning it (vamh.8).
import { PANE_GUTTER, REQUIREMENTS_PANE_FLEX, TRANSMISSIONS_PANE_FLEX } from '../layout';
import { unitsTitle } from '../scopeCopy';

/** One numeral and its label, as the retired scorecard strip rendered them. */
interface FigureSpec {
  value: number;
  label: string;
  color: string;
}

/** A number in the card's sentence: the sentence is dim, the numbers are not. */
function Num({ children }: { children: ReactNode }): ReactElement {
  return <strong style={{ fontWeight: 700, color: 'var(--text)' }}>{children}</strong>;
}

function Figures({ figures }: { figures: readonly FigureSpec[] }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 9 }}>
      {figures.map((f) => (
        <div
          key={f.label}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
        >
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 26,
              fontWeight: 700,
              color: f.color,
              lineHeight: 1,
            }}
          >
            {f.value}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{f.label}</span>
        </div>
      ))}
    </div>
  );
}

interface CardProps {
  eyebrow: string;
  background: string;
  flex: string;
  sentence: ReactNode;
  figures: readonly FigureSpec[];
}

function Card({ eyebrow, background, flex, sentence, figures }: CardProps): ReactElement {
  return (
    <div
      style={{
        flex,
        minWidth: 0,
        background,
        border: '1px solid var(--border-strong)',
        borderRadius: 8,
        boxShadow: 'var(--shadow)',
        padding: '11px 16px 13px',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}
      >
        {eyebrow}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 3 }}>
        {sentence}
      </div>
      <Figures figures={figures} />
    </div>
  );
}

export interface SummaryCardsProps {
  /** Scope-relative requirement rollup, as served. */
  rollup: Rollup;
  /** Scope totals for the transmissions side, as served. */
  scoped: ScopeTotals;
}

export function SummaryCards({ rollup, scoped }: SummaryCardsProps): ReactElement {
  const { units, unidentifiedReports } = scoped;
  return (
    <div
      style={{
        display: 'flex',
        gap: PANE_GUTTER,
        padding: `${PANE_GUTTER}px ${PANE_GUTTER}px 0`,
        background: 'var(--canvas)',
      }}
    >
      <Card
        eyebrow="REQUIREMENTS"
        background="var(--surface)"
        flex={REQUIREMENTS_PANE_FLEX}
        sentence={
          <>
            <Num>{`${rollup.gradeable} of ${rollup.total}`}</Num>
            {' verifiable from your traffic · the rest are self-attested or need active testing'}
          </>
        }
        figures={[
          { value: rollup.passing, label: 'passing', color: 'var(--pass)' },
          { value: rollup.failing, label: 'with failures', color: 'var(--fail)' },
          { value: rollup.untested, label: 'untested', color: 'var(--neutral)' },
        ]}
      />
      <Card
        eyebrow="TRANSMISSIONS"
        background="var(--surface-tx)"
        flex={TRANSMISSIONS_PANE_FLEX}
        sentence={
          <>
            {'received in this scope, from '}
            <span title={unitsTitle(unidentifiedReports)}>
              <Num>{units}</Num>
              {` CCE unit${units === 1 ? '' : 's'}`}
            </span>
            {unidentifiedReports > 0 && (
              <>
                {' · '}
                <Num>{unidentifiedReports}</Num>
                {` report${unidentifiedReports === 1 ? '' : 's'} named no appliance`}
              </>
            )}
          </>
        }
        figures={[
          { value: scoped.scoped, label: 'received', color: 'var(--text)' },
          { value: scoped.withFailures, label: 'with failures', color: 'var(--fail)' },
          { value: scoped.distinctIssues, label: 'distinct issues', color: 'var(--mixed)' },
        ]}
      />
    </div>
  );
}
