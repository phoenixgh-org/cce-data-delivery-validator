/**
 * TransmissionsCard (108.6) — the right-hand pane of the redesigned dashboard,
 * replacing the old Transmissions.tsx drill-down list. Renders a reverse-chron
 * list of transmissions (the API returns them newest-first, so we DO NOT
 * re-sort — unlike the prototype, whose mock data was oldest-first and so
 * called `.reverse()`) plus a detail panel for the selected row.
 *
 * Props match Dashboard.tsx's TransmissionsPaneProps verbatim. Selection is
 * lifted state (selectedTx); a finding's §req link cross-navigates to that
 * requirement in the compliance pane via onSelectReq. Pure presentational.
 *
 * Reference: design_handoff_validator_redesign/redesign/proto-dashboard.jsx
 * (TxRow / TxDetail / TransmissionsCard) + README §2 "TransmissionsCard".
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { FindingView, Profile, Severity, Signature, TransmissionView } from '../api';
import type { DisplayStatus } from '../api';
import { CONTRACT_PROFILE, isAdvisory } from '../api';
import { ADVISORY_COPY, advisoryLabel, splitFindings } from '../advisories';
import {
  detailGroupCopy,
  groupDetailFindings,
  shadowRowText,
  type ShadowRow,
} from '../detailGroups';
import { PROFILE_NAME } from '../profiles';
import { Icon } from './ui/Icon';
import { StatusPill } from './ui/StatusPill';
import { VERDICT_COL_PX, VerdictPair, verdictColumns } from './ui/VerdictDot';

// The verdict columns are declared beside the dots that fill them (by1c.34) and
// re-exported here, where the list header and its colocated test read them.
export { verdictColumns };

/** Props mirror Dashboard.tsx's TransmissionsPaneProps (lines 186-194) verbatim. */
export interface TransmissionsCardProps {
  transmissions: TransmissionView[];
  /** Selected transmission shown in detail; default = newest (108.6). */
  selectedTx: string | null;
  /** Select a transmission row (108.6). */
  onSelectTx: (id: string) => void;
  /** Cross-link: a finding's §req opens that requirement in the compliance pane (108.6). */
  onSelectReq: (req: string) => void;
  /** Whether the list is scoped to failures-only (4h4.9 owns the state); drives the failures-only checkbox. */
  failuresOnly?: boolean;
  /** Flip the failures-only filter (4h4.9 owns the state; raised by the checkbox). */
  onToggleFailuresOnly?: () => void;
  /** The active signature cross-filter (or null) — title source for the issue chip. */
  activeSignature?: Signature | null;
  /** Clear the active signature cross-filter (the issue chip's Clear button). */
  onClearSignature?: () => void;
  /** Count of currently-rendered (visible) list rows for the "showing {visible} of {scoped}" header. */
  visibleCount?: number;
  /** Post-all-filters denominator (the list response's plain-number `scoped`). */
  scopedTotal?: number;
  /**
   * Infinite-scroll seam (4h4.13). The card raises `onLoadMore` when the
   * virtualizer's last rendered row nears the end of the accumulated list AND
   * `hasMore` is true AND `isLoadingMore` is false. Dashboard owns the cursor:
   * it appends the next page and updates `hasMore`. Omitted ⇒ no pagination.
   */
  onLoadMore?: () => void;
  /** Whether another cursor page exists (`nextCursor != null`); gates `onLoadMore`. */
  hasMore?: boolean;
  /** Whether a load-more page fetch is in flight; gates `onLoadMore` (no double-fire). */
  isLoadingMore?: boolean;
  /**
   * The lineage graded in the shadow beside the contract, or null when the
   * service registers none (by1c.12). NULL IS THE HIDE SIGNAL: it drops the
   * DS01.3 header column and the row's second verdict dot. Passed down from the
   * session read rather than re-derived from the findings, so a session that
   * simply has no shadow findings yet still renders the column.
   */
  shadowProfile: Profile | null;
  /**
   * The session's signatures (by1c.14). The docked detail's shadow rows name
   * their defect from the matching signature's title and cross-filter the list
   * by its key, so the card needs the same array the compliance column reads.
   */
  signatures: Signature[];
  /** Cross-filter the list by a signature — the shadow rows' click (by1c.14). */
  onSelectSignature: (sig: Signature) => void;
}

/** Row status-dot tone derived from a transmission's findings (not HTTP). */
type DotTone = 'pass' | 'mixed' | 'fail' | 'neutral';

const DOT_COLOR: Record<DotTone, string> = {
  pass: 'var(--pass)',
  mixed: 'var(--mixed)',
  fail: 'var(--fail)',
  neutral: 'var(--neutral)',
};

/**
 * The findings that GRADE a transmission under the contract in force — the only
 * ones the row's verdict surfaces may read (by1c.8).
 *
 * Since bd by1c.6 a transmission also carries findings from the DS01.3 shadow
 * run. Those describe a different lineage's verdict, so a payload that conforms
 * today would otherwise show a red dot and a fail count for obligations that are
 * not yet in force. The shadow verdict gets its own column in bd by1c.12; here
 * the filter simply keeps it out of the contract one.
 */
function contractFindings(findings: FindingView[]): FindingView[] {
  return findings.filter((f) => f.profile === CONTRACT_PROFILE);
}

/**
 * Derive the row dot tone from the transmission's CONTRACT findings:
 *   any fail            -> fail
 *   pass AND fail mix    -> (covered by the fail branch; "mixed" = some pass + some fail)
 *   all pass             -> pass
 *   none                 -> neutral
 * Per the spec, any fail dominates; a mix of pass+fail reads as "mixed".
 */
function dotTone(all: FindingView[]): DotTone {
  const findings = contractFindings(all);
  if (findings.length === 0) return 'neutral';
  const hasFail = findings.some((f) => f.severity === 'fail');
  const hasPass = findings.some((f) => f.severity === 'pass');
  if (hasFail) return hasPass ? 'mixed' : 'fail';
  if (hasPass) return 'pass';
  // info-only (no pass, no fail) — nothing graded either way.
  return 'neutral';
}

/**
 * Finding severity -> a DisplayStatus the shared StatusPill understands.
 * StatusPill keys off DisplayStatus, not the §8 Severity union, so we bridge:
 * pass/fail map straight through; info -> 'untested' (neutral kind) so it
 * renders in the muted neutral palette rather than a dead/dimmed tone.
 */
const SEVERITY_TO_STATUS: Record<Severity, DisplayStatus> = {
  pass: 'pass',
  fail: 'fail',
  info: 'untested',
};

/** Short, monospace clock from an ISO timestamp (HH:MM:SS, local). */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false });
}

/** Compact relative "ago" string for the detail header. */
function relativeAgo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const secs = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** A short, mono-friendly transmission id for the `t-XXXX` header. */
function shortId(id: string): string {
  // Show the trailing chunk (uuids/serials are most distinctive at the end);
  // fall back to the whole id if it's already short.
  return id.length > 8 ? id.slice(-8) : id;
}

const mono: CSSProperties = { fontFamily: 'var(--mono)' };

/**
 * Estimated height of one TxRow, in px — the virtualizer's `estimateSize` AND
 * the basis of the list-region height cap below. Rows are not fixed-height (the
 * chrome wraps at narrow widths), so `measureElement` corrects the real heights;
 * this is only the pre-measure estimate. It tracks TxRow's chrome:
 * 8px padding top + a 17.25px line box + 8px padding bottom + 1px bottom border
 * ≈ 34.
 *
 * The line box is the tallest span in TxRow (fontSize 11.5) times the inherited
 * `line-height: 1.5` from `:root` (src/web/styles.css) — 17.25px, not the ~20px
 * this comment used to claim. TxRow is a flex row with `alignItems: center`, so
 * that single line box IS the content height (5bs.7).
 */
const ROW_ESTIMATE_PX = 34;

/** How many rows the list region shows before it scrolls (5bs.6). */
const LIST_VISIBLE_ROWS = 10;

/**
 * Height cap for the scrolling list region (5bs.6).
 *
 * The list used to be sized proportionally (`flex: 1 1 56%`), which is what the
 * design handoff specifies — but the handoff's prototype shell is viewport-
 * locked (`height: 100%`), so 56% of the card was 56% of a bounded box. Our
 * dashboard shell is `minHeight: 100vh` and grows with the compliance pane's
 * content, so a proportional list grew without bound and pushed the DOCKED
 * DETAIL PANE below the fold — reinstating the scroll-past-the-list problem the
 * master-detail redesign removed.
 *
 * So cap in rows, derived from ROW_ESTIMATE_PX rather than a hardcoded pixel
 * number that would drift if the row chrome changes: 10 × 34 = 340px.
 *
 * Height budget above the detail pane, at 16px root padding:
 *   header ~66 + setup bar ~40 + scorecard ~62 + filter bar ~40  ≈ 208
 *   + body padding 16 + card header ~44 + verdict column header 26 + list 340
 *                                                                 = 634
 * so the docked detail starts at ~636px. The verdict column header (by1c.12) is
 * the strip of lineage labels rendered immediately above this region: 5px padding
 * top and bottom + a 10px eyebrow at the inherited line-height 1.5 (15px) + a 1px
 * bottom border = 26px.
 *
 * That still clears the fold on an 800px-tall viewport (~164px of detail visible,
 * above its own 120px min-height) and comfortably so at 1000px (~364px). An
 * active issue chip adds ~33px, leaving ~131px — still inside the budget, but the
 * margin is now thin enough that the next strip added above the list has to be
 * measured rather than assumed. The list keeps its own scrollbar and stays
 * virtualized — this caps the region, it does not page the data.
 */
const LIST_MAX_HEIGHT_PX = ROW_ESTIMATE_PX * LIST_VISIBLE_ROWS;

/** HTTP status tone: 2xx pass, 3xx/4xx mixed, 5xx (or unknown) fail. */
function httpTone(status: number | null): string {
  if (status === null) return 'var(--text-faint)';
  if (status < 300) return 'var(--pass)';
  if (status < 500) return 'var(--mixed)';
  return 'var(--fail)';
}

/**
 * The eyebrow above the active cross-filter chip (agj.18).
 *
 * The chip is driven by whatever {@link Signature} the compliance column picked,
 * and since agj.15 that can be an advisory (`kind: 'advisory'`, keyed
 * `adv|<adv.id>`) — reachable for real since agj.16 put advisory rows in the
 * column. A hardcoded "Issue" would then label an advisory a defect, which is
 * the one thing the category forbids: an advisory is raised against a payload
 * that broke no rule (DESIGN §7.1; `src/ingest/stages/semantic/advisory.ts`).
 * So the label follows the KIND, not the position in the UI.
 */
export function signatureEyebrow(sig: Pick<Signature, 'kind'>): string {
  return sig.kind === 'advisory' ? 'Advisory' : 'Issue';
}

/** The far-right findings cell's rendered decision: text, color, and tooltip. */
export interface FindingsCell {
  text: string;
  color: string;
  title: string;
}

/**
 * Decide the transmission row's far-right cell from its findings alone (7hz).
 *
 * It used to show the TOTAL finding count (`{n}f`), tinted red on any failure
 * and muted otherwise, with a separate faint `ok` for zero findings — three
 * visual states for what is really a binary question. A user reading `11f` in
 * different colors on different rows had no way to tell "11 failed" from "11
 * total, none failed" apart. So: no fail-severity findings (zero findings, or
 * findings that are all pass/info) collapses to one affirmative green OK, and
 * only a genuine failure switches the cell to the FAIL count (not the total).
 *
 * ADVISORIES ARE EXCLUDED OUTRIGHT (pwd/bva) — from the fail count, which they
 * could never have joined, AND from the total, which they could. This cell is
 * the row's verdict cell; an advisory is not a verdict, and letting one inflate
 * "N findings, none failed" would give a 100 %-conformant transmission a number
 * to explain. They are rendered in the detail pane's own Advisories block
 * instead. A transmission carrying advisories and nothing else therefore reads
 * "No findings" here, which is true of the graded ones.
 *
 * SHADOW FINDINGS ARE EXCLUDED TOO (by1c.8), by the same argument one step over:
 * this is the row's CONTRACT verdict cell, and a DS01.3 shadow failure is not a
 * verdict against the obligations in force. It gets its own column in by1c.12,
 * which replaces this cell; the filter is applied here so nothing leaks in the
 * meantime.
 */
export function findingsCell(findings: FindingView[]): FindingsCell {
  const graded = contractFindings(findings).filter((f) => !isAdvisory(f));
  const findingCount = graded.length;
  const failCount = graded.filter((f) => f.severity === 'fail').length;
  const plural = (n: number): string => (n === 1 ? 'finding' : 'findings');

  if (failCount === 0) {
    const title =
      findingCount === 0 ? 'No findings' : `${findingCount} ${plural(findingCount)}, none failed`;
    return { text: 'OK', color: 'var(--pass)', title };
  }

  return {
    text: `${failCount}f`,
    color: 'var(--fail)',
    title: `${failCount} of ${findingCount} ${plural(findingCount)} failed`,
  };
}

/**
 * How many findings the SHADOW lineage failed this transmission on — the count
 * in the verdict pair's tooltip parenthetical AND the count on the detail pane's
 * "Would also fail under DS01.3" header, which is the same question asked twice
 * and must not come back with two numbers (by1c.39).
 *
 * Advisories are excluded for the reason {@link findingsCell} gives: an advisory
 * is not a verdict and must never inflate a number a supplier has to explain.
 * Zero when no shadow lineage is registered, and zero when one is but never ran
 * on this transmission — in neither case is there a shadow failure to report.
 */
export function shadowFailCount(findings: FindingView[], shadowProfile: Profile | null): number {
  if (shadowProfile === null) return 0;
  return findings.filter(
    (f) => f.profile === shadowProfile && f.severity === 'fail' && !isAdvisory(f),
  ).length;
}

/**
 * The cross-filter chip's title (by1c.12) — prefixed `DS01.3 · ` when the active
 * signature belongs to a lineage other than the contract in force.
 *
 * Without the prefix a shadow cross-filter is indistinguishable from a defect
 * against the obligations in force, which is the one confusion the shadow
 * surfaces exist to prevent. The test is "not the contract profile" rather than
 * "is ds013", so a third lineage names itself correctly; an advisory signature
 * carries NO profile (api.ts, `Signature.profile`) and grades against no
 * lineage, so it takes no prefix.
 */
export function chipTitle(sig: Pick<Signature, 'title' | 'profile'>): string {
  const { profile } = sig;
  if (profile === null || profile === CONTRACT_PROFILE) return sig.title;
  return `${PROFILE_NAME[profile]} · ${sig.title}`;
}

function TxRow({
  tx,
  selected,
  onSelect,
  shadowProfile,
}: {
  tx: TransmissionView;
  selected: boolean;
  onSelect: () => void;
  shadowProfile: Profile | null;
}): ReactElement {
  const tone = dotTone(tx.findings);
  const outdated = tx.findings.some((f) => f.outdated);
  const findings = findingsCell(tx.findings);
  const reports = reportCount(tx.body);
  const reportsTitle = reportCountTitle(reports, tx.parse_ok);

  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        cursor: 'pointer',
        borderBottom: '1px solid var(--border)',
        background: selected ? 'var(--surface)' : 'transparent',
        borderLeft: selected ? '2px solid var(--text)' : '2px solid transparent',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: DOT_COLOR[tone],
          flexShrink: 0,
        }}
      />
      <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-muted)', width: 64 }}>
        {shortTime(tx.received_at)}
      </span>
      <span
        title={tx.sourceLabel}
        style={{
          ...mono,
          fontSize: 10,
          color: 'var(--text-faint)',
          width: 30,
          letterSpacing: '.03em',
          whiteSpace: 'nowrap',
        }}
      >
        {tx.sourceCode || '—'}
      </span>
      <span style={{ ...mono, fontSize: 11.5, color: httpTone(tx.http_status), width: 40 }}>
        {tx.http_status ?? '—'}
      </span>
      <span
        style={{
          ...mono,
          fontSize: 11,
          color: outdated ? 'var(--mixed)' : 'var(--text-faint)',
          whiteSpace: 'nowrap',
        }}
      >
        v{tx.schema_version ?? '—'}
        {outdated ? ' ⚠' : ''}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ ...mono, fontSize: 11, color: 'var(--text-faint)' }}>
        {tx.wire_bytes ?? '—'} bytes
      </span>
      {/* How many reports this POST carried (frk) — next to the byte count
          because both size the delivery. It rides the flex spacer above rather
          than taking a fixed width: the label is 8–10 characters and the row
          already ends in fixed-width cells, so a nowrap span here costs the
          spacer a little slack and nothing else. `—` when the payload did not
          parse; never `0`. */}
      <span
        title={reportsTitle}
        style={{ ...mono, fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}
      >
        {reportCountLabel(reports)}
      </span>
      <span
        title={findings.title}
        style={{
          ...mono,
          fontSize: 10.5,
          color: findings.color,
          width: 28,
          textAlign: 'right',
        }}
      >
        {findings.text}
      </span>
      {/* Verdict dots (by1c.12) — one per registered lineage, each right-aligned
          in its own VERDICT_COL_PX cell so it sits under the header label that
          names its lineage (by1c.34). Neutral by design: the 6px tone dot at the
          head of the row already colours the contract verdict. The slot is 11px
          tall, so it sits inside the existing line box and ROW_ESTIMATE_PX holds. */}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          width: VERDICT_COL_PX * verdictColumns(shadowProfile).length,
          flexShrink: 0,
        }}
      >
        <VerdictPair
          contract={tx.verdicts[CONTRACT_PROFILE]}
          shadow={shadowProfile === null ? null : (tx.verdicts[shadowProfile] ?? null)}
          shadowProfile={shadowProfile}
          findingsCount={shadowFailCount(tx.findings, shadowProfile)}
        />
      </span>
    </div>
  );
}

const eyebrow: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  color: 'var(--text-faint)',
};

/**
 * The `pointer: …` line under a finding, an advisory or a shadow row — a button
 * that opens the raw-payload inspector at that JSON Pointer when one is
 * locatable, and plain text when it is not. Shared by {@link FindingItem},
 * {@link AdvisoryItem} and {@link ShadowFindingRow} so the drill-down cannot work
 * in one and quietly rot in the others (by1c.40).
 *
 * Two pointers, because what a row SHOWS and what it OPENS are not always the
 * same string: a collapsed shadow row shows the generalized path it folds
 * (`/data/*`) and opens the first concrete one. For a finding they are its own
 * `pointer` and its `instancePath` — Ajv's path into the payload, where
 * `pointer` is the same value normalized to null at the root.
 */
function PointerLine({
  pointer,
  locatable,
  onLocate,
}: {
  /** The pointer as text. Null renders nothing. */
  pointer: string | null;
  /** The path the inspector scrolls to, or null when nothing is locatable. */
  locatable: string | null;
  onLocate?: (pointer: string) => void;
}): ReactElement | null {
  if (pointer === null) return null;
  if (!onLocate || locatable === null || locatable === '') {
    return (
      <div style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2 }}>
        pointer: {pointer}
      </div>
    );
  }
  return (
    <button
      type="button"
      title="Show this location in the raw payload"
      onClick={() => onLocate(locatable)}
      style={{
        ...mono,
        display: 'block',
        fontSize: 10.5,
        color: 'var(--text-muted)',
        background: 'none',
        border: 'none',
        padding: 0,
        marginTop: 2,
        cursor: 'pointer',
        textAlign: 'left',
        textDecoration: 'underline',
      }}
    >
      pointer: {pointer}
    </button>
  );
}

/**
 * One ADVISORY in the transmission detail (pwd/bva) — deliberately NOT a
 * {@link FindingItem}.
 *
 * FindingItem renders every finding as `§{requirement}` and cross-links it to a
 * row of the §7 matrix. An advisory's `requirement` is its own `adv.*` id, which
 * is not a clause of anything and has no matrix row to open, so rendering one
 * through FindingItem would print `§adv.null_padding` and link nowhere. It also
 * carries no verdict, so there is no StatusPill here either.
 *
 * The tone is the accent, never a status colour and never the --mixed amber that
 * means warning/outdated elsewhere on this dashboard — `sigTone()` in
 * ComplianceCard.tsx carries the full reasoning and applies the same rule to the
 * advisory rows in the compliance column. The pointer drill-down is kept: it is the one
 * piece of FindingItem that applies unchanged, and it is how a supplier sees
 * what the observation is about.
 */
function AdvisoryItem({
  finding,
  onLocate,
}: {
  finding: FindingView;
  onLocate?: (pointer: string) => void;
}): ReactElement {
  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.5,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: '2px solid var(--accent)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 7,
          flexWrap: 'wrap',
          marginBottom: finding.detail ? 3 : 0,
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>
          {advisoryLabel(finding.requirement)}
        </span>
        <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)' }}>
          {finding.requirement}
        </span>
      </div>
      {finding.detail && <div style={{ color: 'var(--text-muted)' }}>{finding.detail}</div>}
      <PointerLine
        pointer={finding.pointer}
        locatable={finding.instancePath ?? finding.pointer}
        onLocate={onLocate}
      />
    </div>
  );
}

/**
 * The "· also 5.1.3" mark on a contract finding that fails under the shadow
 * lineage too (by1c.14) — the clause it re-tags to, plus the words for its
 * tooltip, which the caller builds so no lineage is named from a literal here.
 */
export interface AlsoFails {
  clause: string;
  hint: string;
}

function FindingItem({
  finding,
  alsoFails,
  onSelectReq,
  onLocate,
}: {
  finding: FindingView;
  /** The shadow clause this finding also fails under, or null (by1c.14). */
  alsoFails?: AlsoFails | null;
  onSelectReq: (req: string) => void;
  /** Open the raw-payload inspector at this finding's JSON Pointer (5bs.3). */
  onLocate?: (pointer: string) => void;
}): ReactElement {
  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.5,
        background: finding.outdated ? 'var(--mixed-bg)' : 'var(--surface)',
        border: `1px solid ${finding.outdated ? 'var(--mixed)' : 'var(--border)'}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          flexWrap: 'wrap',
          marginBottom: finding.detail ? 3 : 0,
        }}
      >
        <StatusPill status={SEVERITY_TO_STATUS[finding.severity]} />
        <button
          type="button"
          onClick={() => onSelectReq(finding.requirement)}
          style={{
            ...mono,
            fontSize: 11,
            color: 'var(--accent-text)',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          §{finding.requirement}
        </button>
        {alsoFails != null && (
          <span
            title={alsoFails.hint}
            style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)' }}
          >
            · also {alsoFails.clause}
          </span>
        )}
        {finding.outdated && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--mixed)',
            }}
          >
            <Icon name="alert" size={11} /> OUTDATED SCHEMA
          </span>
        )}
      </div>
      {finding.detail && <div style={{ color: 'var(--text-muted)' }}>{finding.detail}</div>}
      <PointerLine
        pointer={finding.pointer}
        locatable={finding.instancePath ?? finding.pointer}
        onLocate={onLocate}
      />
    </div>
  );
}

/**
 * One row of the "Would also fail under DS01.3" group (by1c.14).
 *
 * Two affordances, both of which a shadow failure had before this group existed
 * and by1c.40 restored: the row's text is a button on the same `?signatureKey=`
 * cross-filter the compliance signatures use — "which other transmissions would
 * this affect?", the question a supplier reads this group to answer — and the
 * `pointer:` line beneath it opens the raw-payload inspector where the defect is.
 *
 * The shape is {@link FindingItem}'s for the same reason: the container is a
 * div, and the cross-filter button and the PointerLine button are SIBLINGS
 * inside it. Making the whole row one button, with the pointer line nested,
 * would nest a button in a button — invalid, and the inner click is swallowed.
 *
 * The row is quieter than a FindingItem on purpose: nothing here grades the
 * contract in force, and a row that looked like a verdict would say otherwise.
 */
function ShadowFindingRow({
  row,
  hint,
  onSelectSignature,
  onLocate,
}: {
  row: ShadowRow;
  /** Tooltip for the clickable row — built by the caller, which knows the lineage. */
  hint: string;
  onSelectSignature: (sig: Signature) => void;
  /** Open the raw-payload inspector at this row's JSON Pointer (5bs.3). */
  onLocate?: (pointer: string) => void;
}): ReactElement {
  const body = (
    <>
      <span style={{ ...mono, fontSize: 11, color: 'var(--text-muted)' }}>{row.req}</span>
      {row.title !== '' && <span style={{ color: 'var(--text)' }}>{row.title}</span>}
      {row.detail !== null && row.detail !== '' && (
        <>
          {row.dash && <span style={{ color: 'var(--text-faint)' }}>—</span>}
          <span style={{ ...mono, fontSize: 11, color: 'var(--text-muted)' }}>{row.detail}</span>
        </>
      )}
    </>
  );
  const shell: CSSProperties = {
    padding: '6px 10px',
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.5,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
  };
  const line: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    flexWrap: 'wrap',
    width: '100%',
    textAlign: 'left',
  };
  const sig = row.sig;
  return (
    <div style={shell}>
      {/* A finding of a transmission in scope always folded into one of the
          session's signatures — the server rolls them from these same findings —
          so the no-signature branch is unreachable in practice. It renders the
          text without a button rather than nothing, so a lookup that somehow
          misses costs the cross-filter, not the row. */}
      {sig === null ? (
        <div style={line}>{body}</div>
      ) : (
        <button
          type="button"
          title={hint}
          onClick={() => onSelectSignature(sig)}
          style={{
            ...line,
            font: 'inherit',
            color: 'inherit',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          {body}
        </button>
      )}
      <PointerLine pointer={row.pointer} locatable={row.locate} onLocate={onLocate} />
    </div>
  );
}

/**
 * Best-effort Object inventory derived from the parsed body. The
 * TransmissionView has no dedicated object list, so we infer chips ONLY from a
 * recognizably-enumerable body shape:
 *   - an array            -> a single `array · {n}` chip
 *   - a top-level object   -> one `{key} · {n}` chip per property whose value is
 *                             an array (n = length), e.g. records collections.
 * If the body is null, a scalar, or an object with no array-valued properties,
 * we DERIVE NOTHING and the caller omits the section entirely — we never
 * fabricate counts for a shape we don't recognize.
 */
function deriveInventory(body: unknown): string[] {
  if (Array.isArray(body)) {
    return [`array · ${body.length}`];
  }
  if (body !== null && typeof body === 'object') {
    const chips: string[] = [];
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        chips.push(`${key} · ${value.length}`);
      }
    }
    return chips;
  }
  return [];
}

/** One meta-grid cell; `warn` renders it in the amber tone with an alert glyph. */
interface MetaCell {
  key: string;
  value: string;
  warn?: boolean;
}

/**
 * The `compression` meta cell (5bs.2) — derived from the request
 * `Content-Encoding` the pipeline recorded.
 *
 * The tone MIRRORS src/ingest/stages/encoding.ts so the cell never contradicts
 * the §1.6 finding sitting next to it:
 *   - absent header            -> `none`      (stage 5 no-ops; nothing to grade)
 *   - `identity` (any casing)   -> the raw value, untoned — legal and explicitly
 *                                 a no-op for stage 5, so warning it would be a
 *                                 false alarm; but we do NOT flatten it to
 *                                 `none` either, because the supplier did send a
 *                                 header and that is worth seeing.
 *   - `gzip` (any casing)       -> `gzip`      (the one decodable encoding)
 *   - anything else             -> THE RAW VALUE, warning-toned. This is the
 *                                 §1.6 signal; coercing it to `none` would hide
 *                                 exactly the thing the cell exists to show. An
 *                                 empty-but-present header renders `(empty)`,
 *                                 which stage 5 also fails.
 * The verdict itself stays with the §1.6 finding — the cell only makes the value
 * visible and visibly odd.
 */
function compressionCell(contentEncoding: string | null): MetaCell {
  if (contentEncoding === null) return { key: 'compression', value: 'none' };
  const token = contentEncoding.trim().toLowerCase();
  if (token === '') return { key: 'compression', value: '(empty)', warn: true };
  if (token === 'identity') return { key: 'compression', value: contentEncoding.trim() };
  if (token === 'gzip') return { key: 'compression', value: 'gzip' };
  return { key: 'compression', value: contentEncoding.trim(), warn: true };
}

/** A non-empty `transferType` string off an object-shaped node, else null. */
function readTransferType(node: unknown): string | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const value = (node as Record<string, unknown>).transferType;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The `type` meta cell's value (j1s): what KIND of transmission this was —
 * `rtm`, `ems`, or `mixed` — derived from the parsed body.
 *
 * WHERE THE FIELD LIVES. In cce-interop the type is `meta.transferType`, ONE
 * per transmission (enum `rtm`|`ems`), and the reports under `data[]` carry no
 * type of their own — the root if/then/else picks the report `$ref` off the
 * meta value. Verified against the vendored 0.8.0/0.8.1 and the authoring
 * 0.8.2/0.8.3: no version has ever put a type on a report. So for a CONFORMANT
 * payload this cell always reads the single meta value and `mixed` is
 * unreachable.
 *
 * WHY `mixed` EXISTS ANYWAY. Report objects are `additionalProperties: true`,
 * and this panel renders what a supplier ACTUALLY sent, conformant or not — a
 * transmission whose reports carry their own `transferType` disagreeing with
 * each other or with `meta` is exactly the kind of thing the detail pane is
 * for, and collapsing it to one value would hide it.
 *
 * THE RULE: collect every type CLAIMED anywhere in the payload — the meta one
 * plus any a report states for itself. One distinct value (the conformant case)
 * renders it; more than one renders `mixed`. A report that states nothing
 * claims nothing, so an all-untyped `data[]` under `meta.transferType: "ems"`
 * is plain `ems`. The verdict stays with the findings; this cell only makes the
 * value visible.
 *
 * Comparison is case-insensitive (`RTM` and `rtm` are one type, not two) but
 * the value is DISPLAYED as sent, like the compression cell — a supplier who
 * sent the wrong casing should see it.
 *
 * Degrades to `—` rather than throwing: `body` is null whenever the pipeline
 * halted before the parse stage (or nothing was retained), and the type is
 * simply not known then.
 */
export function deriveTransmissionType(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return '—';
  const root = body as Record<string, unknown>;

  // token -> the value AS SENT for that token, first claim wins.
  const claimed = new Map<string, string>();
  const claim = (type: string | null): void => {
    if (type !== null && !claimed.has(type.toLowerCase())) claimed.set(type.toLowerCase(), type);
  };

  claim(readTransferType(root.meta));
  if (Array.isArray(root.data)) for (const report of root.data) claim(readTransferType(report));

  // Nothing claimed -> unknown; one claim -> it, as sent; two or more -> mixed.
  const [first, second] = claimed.values();
  if (first === undefined) return '—';
  return second === undefined ? first : 'mixed';
}

/**
 * How many REPORTS a transmission carried — `data[]`'s length — or null when
 * that is not knowable (frk).
 *
 * `data` is an array by schema: "Array of data reports for one or more pieces of
 * cold-chain equipment", `minItems: 1`. One report per POST is the common case
 * but nothing in the format says it must be, and a supplier batching several CCEs
 * into one transmission should see that acknowledged rather than have the
 * dashboard imply a single report.
 *
 * NULL IS NOT ZERO, and the distinction is the whole point of the return type.
 * The count can only come from the PARSED body, which is absent whenever the
 * pipeline halted before the parse stage or the payload did not parse at all. A
 * transmission that failed to parse still carried whatever it carried; rendering
 * `0 reports` would be a false statement about what was sent, so callers render
 * an em-dash for null. A body whose `data` is missing or not an array is the same
 * case: the count is unknown, not zero.
 */
export function reportCount(body: unknown): number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) ? data.length : null;
}

/** The detail grid's `reports` value: the bare count, or `—` when unknown. */
function fmtReportCount(n: number | null): string {
  return n === null ? '—' : String(n);
}

/**
 * The list row's report count, which carries its own unit because the row has no
 * eyebrow to name the column: `1 report`, `2 reports`, `—` when unknown.
 */
export function reportCountLabel(n: number | null): string {
  if (n === null) return '—';
  return `${n} report${n === 1 ? '' : 's'}`;
}

/**
 * The list row's report-count tooltip: the count when it is known, and WHY it is
 * not when it is not (8js8).
 *
 * `reportCount()` returns null for two different reasons, and the tooltip used to
 * state only one of them — "the payload did not parse" — which is a causal claim
 * that is false for every row persisted by a halt UPSTREAM of the parse stage.
 * The size 413, the encoding stage's own 400s and the enabled-auth 401 all store
 * a transmission row with `body` null and `raw_body` set, and nothing ever
 * attempted to parse those bytes; they may be perfectly good JSON. Asserting a
 * parse failure beside a §1.4 "too large" finding contradicts the row's own
 * verdict, and the exercise suite drives those rejects as standard cases, so
 * such rows are routine rather than exotic.
 *
 * `parse_ok` is the field that separates the two: `false` means the parse stage
 * ran and the payload did not parse; null means the stage never ran. The same
 * discipline frk's acceptance turned on — do not make a false statement about
 * what was sent — applies to the explanation of why the count is unknown.
 */
export function reportCountTitle(reports: number | null, parseOk: boolean | null): string {
  if (reports !== null) return `${reportCountLabel(reports)} in this transmission`;
  return parseOk === false
    ? 'Report count unknown — the payload did not parse, so data[] could not be read'
    : 'Report count unknown — the pipeline halted before the payload was parsed, so data[] was never read';
}

/** The fields the meta grid reads — a structural subset of TransmissionView. */
type MetaSource = Pick<
  TransmissionView,
  'transfer_id' | 'schema_version' | 'wire_bytes' | 'content_encoding' | 'body'
>;

/**
 * The meta grid's cells IN RENDER ORDER (j1s, frk). Six value cells over
 * {@link META_GRID_COLUMNS} columns, with the raw-payload control on a row of
 * its own below them:
 *
 *   transferId · schema      · type
 *   reports    · bytes       · compression
 *   raw payload (spans all three columns)
 *
 * Top row is WHAT WAS SENT (its id, the schema it claims, the kind of data);
 * second row is HOW MUCH AND HOW IT ARRIVED (report count, size, encoding).
 *
 * `reports` sits beside `bytes` rather than beside `type` because both answer
 * "how big was this delivery" — one in reports, one in bytes — and a batching
 * supplier reads them together.
 *
 * `type` used to be the request `Content-Type`, which sat oddly next to the
 * §1.2 finding that already grades it; it now names the transmission type from
 * the payload — see {@link deriveTransmissionType}.
 */
export function metaCells(tx: MetaSource): MetaCell[] {
  return [
    { key: 'transferId', value: tx.transfer_id ?? '—' },
    { key: 'schema', value: tx.schema_version ? `v${tx.schema_version}` : '—' },
    { key: 'type', value: deriveTransmissionType(tx.body) },
    { key: 'reports', value: fmtReportCount(reportCount(tx.body)) },
    { key: 'bytes', value: tx.wire_bytes ?? '—' },
    compressionCell(tx.content_encoding),
  ];
}

/**
 * Column count of the detail meta grid. The six {@link metaCells} value cells
 * over three columns = two even rows; the row split is the layout decision j1s
 * made, so it lives here rather than inline in the style.
 *
 * The raw-payload control is NOT one of those six. It used to be the sixth cell
 * of a five-cell grid, but frk's `reports` cell made the value cells six, and a
 * seventh cell would leave a one-wide orphan on a third row. The control now
 * spans all three columns on its own row (`gridColumn: '1 / -1'` in TxDetail),
 * which reads as the full-width affordance it is rather than as another value.
 */
export const META_GRID_COLUMNS = 3;

/**
 * Height cap for the raw-payload scroll region (5bs.3).
 *
 * The inspector lives INSIDE the docked detail pane, which already owns
 * `overflowY: auto` (flex '1 1 44%', minHeight 120), so adding content here
 * cannot change the pane's own footprint and the fold budget documented on
 * LIST_MAX_HEIGHT_PX is untouched. This second cap keeps a large payload from
 * monopolising the pane's scroll: the JSON scrolls inside its own region so the
 * findings above it stay reachable without paging past the whole body.
 */
const RAW_MAX_HEIGHT_PX = 220;

/**
 * Ceiling on how many payload lines we turn into DOM nodes. Each line is its own
 * element (that is what makes per-JSON-Pointer highlighting possible), so an
 * unbounded body would mean tens of thousands of nodes. Past this we render the
 * head of the payload and SAY the view is clipped — a display cap, unrelated to
 * the stored-copy completeness reported by {@link describeStoredCopy}.
 */
const MAX_RENDERED_LINES = 2000;

/** Escape an object key into an RFC 6901 pointer token (`~` → `~0`, `/` → `~1`). */
function pointerToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** One pretty-printed line plus the JSON Pointer of the value it opens/closes. */
interface JsonLine {
  text: string;
  path: string;
}

/**
 * Hand-rolled pretty printer (no JSON-viewer dependency). The joined `text` of
 * the returned lines is byte-identical to `JSON.stringify(value, null, 2)` —
 * verified by fuzzing 200k random values — but each line additionally carries
 * the JSON Pointer of the value that begins (or ends) on it, which is what lets
 * a schema finding's `instancePath` highlight and scroll to its own line.
 *
 * A container contributes its path to BOTH its opening and closing line;
 * callers highlight a subtree by matching `path === pointer ||
 * path.startsWith(pointer + '/')`, which selects a contiguous run.
 */
function renderJsonLines(value: unknown): JsonLine[] {
  const lines: JsonLine[] = [];
  const push = (depth: number, text: string, path: string): void => {
    lines.push({ text: '  '.repeat(depth) + text, path });
  };

  const walk = (v: unknown, depth: number, path: string, prefix: string, suffix: string): void => {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        push(depth, `${prefix}[]${suffix}`, path);
        return;
      }
      push(depth, `${prefix}[`, path);
      v.forEach((item, i) => {
        walk(item, depth + 1, `${path}/${i}`, '', i === v.length - 1 ? '' : ',');
      });
      push(depth, `]${suffix}`, path);
      return;
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(
        ([, x]) => x !== undefined,
      );
      if (entries.length === 0) {
        push(depth, `${prefix}{}${suffix}`, path);
        return;
      }
      push(depth, `${prefix}{`, path);
      entries.forEach(([k, val], i) => {
        walk(
          val,
          depth + 1,
          `${path}/${pointerToken(k)}`,
          `${JSON.stringify(k)}: `,
          i === entries.length - 1 ? '' : ',',
        );
      });
      push(depth, `}${suffix}`, path);
      return;
    }
    // `JSON.stringify` returns undefined for undefined/function/symbol; in an
    // array position those serialize as null (object keys are filtered above).
    push(depth, `${prefix}${JSON.stringify(v) ?? 'null'}${suffix}`, path);
  };

  walk(value, 0, '', '', '');
  return lines;
}

const utf8 = new TextEncoder();

/** UTF-8 byte length of a string — the unit `wire_bytes` is counted in. */
function utf8ByteLength(s: string): number {
  return utf8.encode(s).length;
}

/** Thousands-separated byte count. */
function fmtBytes(n: number): string {
  return n.toLocaleString();
}

/** A one-line honesty note about the stored copy; `warn` = it is not the whole body. */
interface StoredCopyNote {
  text: string;
  warn: boolean;
}

/**
 * §1.6 finding codes (src/ingest/stages/encoding.ts) that mean stage 5 REJECTED
 * the `Content-Encoding` and halted 400 with NO DECODED BODY KEPT — only the
 * single-layer-gzip success path calls `setDecodedBody`. That is the whole of
 * what the three share: they differ on how far decoding got (bug xiz), so say
 * nothing about mechanism without consulting `rejectionCode()` below —
 * `tx.undecodable_body` ran gunzip over the wire bytes and it threw, and
 * `tx.double_encoded` decompressed them successfully and rejected the OUTPUT.
 * A row is still persisted on those paths (DESIGN §8), so the copy it carries
 * is the raw wire body — not payload.
 */
const ENCODING_REJECTED_CODES = new Set([
  'tx.unsupported_encoding',
  'tx.undecodable_body',
  'tx.double_encoded',
]);

/** Leading chars of `raw_body` sampled when testing for binary-read-as-text. */
const MOJIBAKE_SAMPLE_CHARS = 4096;

/** Share of U+FFFD in that sample at/above which the copy reads as binary. */
const MOJIBAKE_RATIO = 0.05;

/**
 * True when the head of `s` is dense in U+FFFD — the signature of binary bytes
 * (e.g. still-gzipped ones) run through `toString('utf8')`. Sampled, not
 * counted whole: `raw_body` can be several MiB and this runs on every render of
 * the detail pane.
 */
function replacementDense(s: string): boolean {
  const sample = s.slice(0, MOJIBAKE_SAMPLE_CHARS);
  if (sample.length === 0) return false;
  let hits = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample.charCodeAt(i) === 0xfffd) {
      hits += 1;
    }
  }
  return hits / sample.length >= MOJIBAKE_RATIO;
}

/** What the row lets us conclude about whether its stored copy was decoded. */
type DecodeState = 'decoded' | 'rejected' | 'unconfirmed';

/**
 * The §1.6 rejection code this row carries, or null if it carries none.
 *
 * WHICH of the three it is decides what the note may say about how the body was
 * handled (bug xiz): the three paths in src/ingest/stages/encoding.ts differ on
 * whether a byte was ever read, so a single mechanism sentence cannot be true of
 * all of them. Only `tx.unsupported_encoding` refuses the token unread.
 */
function rejectionCode(tx: TransmissionView): string | null {
  const hit = tx.findings.find((f) => f.code !== null && ENCODING_REJECTED_CODES.has(f.code));
  return hit?.code ?? null;
}

/**
 * Decide, from the row alone, whether the stored copy is decoded payload.
 *
 * The dashboard never sees stage 5's outcome directly, so it must be inferred
 * (bug vul — a set `Content-Encoding` is NOT evidence of a decode; only the one
 * single-layer-gzip success path in src/ingest/stages/encoding.ts ever calls
 * `setDecodedBody`, and every other path halts 400 with the compressed bytes
 * still in `ctx.rawBody`):
 *
 *   - a parsed `body` proves it — compressed bytes never parse as JSON, so
 *     whatever was stored had already been decompressed;
 *   - a §1.6 rejection finding disproves it — no rejection path keeps a decoded
 *     body (only the success path calls `setDecodedBody`, even where gunzip did
 *     run), so the copy is the wire body;
 *   - otherwise (decoded but unparseable, say) the copy is presumed decoded
 *     UNLESS it reads as binary, which we cannot resolve either way and must
 *     therefore not present as payload.
 */
function decodeState(tx: TransmissionView, storedText: string): DecodeState {
  if (tx.body !== null && tx.body !== undefined) return 'decoded';
  if (rejectionCode(tx) !== null) return 'rejected';
  return replacementDense(storedText) ? 'unconfirmed' : 'decoded';
}

/**
 * Say honestly how the stored `raw_body` relates to what was actually on the
 * wire (5bs.3 "disclose truncation").
 *
 * `raw_body` is a drill-down COPY, not the authoritative artifact (DESIGN §8):
 * src/ingest/route.ts `storedRawBody()` stores the gzip-DECODED text when stage
 * 5 decoded one, decodes as UTF-8 (invalid byte sequences become U+FFFD, which
 * can make the copy LONGER), and strips NUL because Postgres `text` rejects
 * 0x00. The wire facts are preserved elsewhere (`content_hash`, `wire_bytes`,
 * `content_encoding`).
 *
 * We assert no byte cap. None is implemented — the decision was no write-side
 * cap (beads 1z9), and the two transport ceilings (DESIGN §12) bound the stored
 * copy only loosely, so this disclosure must never describe `raw_body` as
 * size-bounded; it compares against `wire_bytes` for exactly that reason. We
 * report only what the row itself supports:
 *   - encoded + decoded     -> both sizes stated; no comparison is meaningful.
 *   - encoded + refused     -> the copy is the wire body as sent; whether those
 *                              bytes are mojibake or a merely MISLABELLED plain
 *                              body is stated only when the row shows it (3b3).
 *   - encoded, decode unproven -> said so; the copy reads as binary.
 *   - copy shorter than wire -> shortened; explicitly NOT the complete payload.
 *   - copy longer than wire  -> undecodable bytes were substituted.
 *   - equal                 -> stated as complete, so a silent note is not
 *                              mistaken for a missing check.
 */
function describeStoredCopy(tx: TransmissionView): StoredCopyNote | null {
  if (tx.raw_body === null) return null;
  const stored = utf8ByteLength(tx.raw_body);
  const encoding = tx.content_encoding === null ? null : tx.content_encoding.trim();
  const encoded = encoding !== null && encoding !== '' && encoding.toLowerCase() !== 'identity';
  const wire = tx.wire_bytes === null ? null : Number(tx.wire_bytes);
  const wireKnown = wire !== null && Number.isFinite(wire);
  const wireText = wireKnown ? fmtBytes(wire) : 'an unrecorded number of';

  if (encoded) {
    const state = decodeState(tx, tx.raw_body);
    if (state === 'rejected') {
      // "Not decoded" is true on every path that reaches here. What those bytes
      // ARE is not: stage 5 refuses a non-gzip token before reading a single body
      // byte (src/ingest/stages/encoding.ts), so the commonest producer of this
      // branch is a supplier who MISLABELLED an ordinary UTF-8 body — nothing was
      // substituted and the copy below is perfectly readable. Say which case this
      // is only where the row proves it (bug 3b3): a copy that reads as binary, or
      // one that outgrew the wire, is mojibake; one that matches the wire size and
      // does not read as binary went through untouched.
      const binary = replacementDense(tx.raw_body);
      const grew = wireKnown && stored > wire;
      const intact = wireKnown && stored === wire && !binary;
      // The intact case also has to say WHY the copy is not payload, and that
      // mechanism differs per rejection code (bug xiz) — only the unsupported
      // token is refused before a byte is read; `tx.undecodable_body` ran
      // gunzipSync over these very bytes and failed, and `tx.double_encoded`
      // decompressed them and rejected the OUTPUT for being gzip again. The
      // MISLABELLED reading fits the first two (the body was not really
      // ${encoding}-encoded) but not the third, which was encoded twice over.
      const code = rejectionCode(tx);
      const intactTail =
        code === 'tx.double_encoded'
          ? `Every wire byte is present and none reads as undecodable, but the body ` +
            `decompressed to ANOTHER gzip member and was refused as double-encoded, so ` +
            `nothing below is graded payload.`
          : code === 'tx.undecodable_body'
            ? `Every wire byte is present and none reads as undecodable, so the body appears ` +
              `to have been MISLABELLED rather than actually ${encoding}-encoded — ` +
              `decompression was attempted over these very bytes and failed. Nothing below ` +
              `is graded payload.`
            : `Every wire byte is present and none reads as undecodable, so the body appears ` +
              `to have been MISLABELLED rather than actually ${encoding}-encoded. It was ` +
              `refused unread either way, so nothing below is graded payload.`;
      const tail = binary
        ? `Undecodable bytes were substituted and NUL bytes stripped, and the copy reads as ` +
          `binary — this is NOT readable payload.`
        : grew
          ? `The copy is larger than the wire body, so undecodable bytes were substituted; ` +
            `read it as the wire body, not as payload.`
          : intact
            ? intactTail
            : `NUL bytes are stripped when the copy is stored; whether the rest is readable ` +
              `payload is not something this row settles, so read it as the wire body.`;
      return {
        text:
          `Not decoded: the ${encoding} encoding was rejected and no decoded body was kept, ` +
          `so this copy is the bytes as sent, read as text — ` +
          `${fmtBytes(stored)} bytes stored from ${wireText} bytes on the wire. ${tail}`,
        warn: true,
      };
    }
    if (state === 'unconfirmed') {
      return {
        text:
          `Decoding unconfirmed: ${fmtBytes(stored)} bytes stored from ${wireText} ` +
          `${encoding} bytes on the wire, but the copy reads as binary (dense in ` +
          `replacement characters), so it cannot be shown as decoded payload.`,
        warn: true,
      };
    }
    return {
      text:
        `Shown decoded: ${fmtBytes(stored)} bytes of payload from ` +
        `${wireText} ${encoding} bytes on the wire. ` +
        `NUL bytes are stripped when the copy is stored.`,
      warn: false,
    };
  }
  if (!wireKnown) {
    return {
      text:
        `${fmtBytes(stored)} bytes stored. The wire size was not recorded, so this copy ` +
        `cannot be confirmed complete.`,
      warn: true,
    };
  }
  if (stored < wire) {
    return {
      text:
        `Shortened: ${fmtBytes(stored)} of ${fmtBytes(wire)} wire bytes are stored. NUL ` +
        `bytes are stripped when the copy is stored; whatever the cause, this is NOT the ` +
        `complete payload.`,
      warn: true,
    };
  }
  if (stored > wire) {
    return {
      text:
        `Altered: ${fmtBytes(stored)} bytes stored from ${fmtBytes(wire)} wire bytes — the ` +
        `body was not valid UTF-8, so undecodable bytes were substituted. This is not the ` +
        `payload as sent.`,
      warn: true,
    };
  }
  return { text: `Complete: all ${fmtBytes(wire)} wire bytes are stored.`, warn: false };
}

/**
 * The JSON Pointers whose payload lines the inspector HIGHLIGHTS — schema errors
 * use Ajv's `instancePath`, other findings fall back to the normalized `pointer`.
 * `''` is the root pointer and would select the whole document, so it is dropped.
 *
 * ADVISORIES ARE EXCLUDED (pwd/bva). The highlight paints the matching lines in
 * --mixed-bg with a --mixed inset rule — the warning tone this dashboard uses
 * for outdated schemas and odd encodings — so flagging an advisory's pointer
 * would mark a 100 %-conformant payload as though something in it were wrong.
 * The drill-down still works: the `pointer:` button scrolls by `data-path`, not
 * by membership of this set.
 */
export function flaggedPointers(findings: readonly FindingView[]): Set<string> {
  const set = new Set<string>();
  for (const f of findings) {
    if (isAdvisory(f)) continue;
    const p = f.instancePath ?? f.pointer;
    if (p !== null && p !== '') set.add(p);
  }
  return set;
}

/** A request to scroll the inspector to a pointer; `seq` re-fires a repeat click. */
interface LocateRequest {
  pointer: string;
  seq: number;
}

/**
 * What the stored payload IS, in three words — `parsed JSON`, raw bytes that
 * failed to parse, or nothing retained at all.
 *
 * Extracted (9q4) because the expand control now lives in TxDetail's meta grid
 * while the region stays at the bottom of the pane: two components need this
 * string and neither may recompute it, or the header and the section could
 * disagree about what is down there.
 */
function rawPayloadSummary(tx: TransmissionView): string {
  if (tx.body !== null && tx.body !== undefined) return 'parsed JSON';
  if (tx.raw_body !== null) return 'raw bytes — payload did not parse';
  return 'not retained';
}

/**
 * Collapsible raw-payload inspector (5bs.3) — the bottom section of TxDetail.
 *
 * Shows the pretty-printed parsed `body` when there is one, and FALLS BACK to
 * the stored `raw_body` text when parsing failed and `body` is null. That
 * failure case is the whole reason the section exists (DESIGN §8, §10), so it
 * must never render nothing while bytes are on hand.
 *
 * The PRIMARY expand control now lives in TxDetail's meta grid (9q4); this
 * section keeps a heading row that doubles as a local collapse affordance for
 * whoever is already scrolled down here. The summary text moved to the header
 * control and is deliberately NOT repeated here — see the meta-grid cell.
 */
function RawPayload({
  tx,
  open,
  onToggle,
  locate,
  revealSeq,
}: {
  tx: TransmissionView;
  open: boolean;
  onToggle: () => void;
  locate: LocateRequest | null;
  /**
   * Bumped when the header control OPENS the section, to scroll this region
   * into view. The header sits above the findings and the region stays below
   * them, so without this the click has no visible effect (9q4).
   */
  revealSeq: number;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const hasParsed = tx.body !== null && tx.body !== undefined;
  const note = useMemo(() => describeStoredCopy(tx), [tx]);

  // Only serialize while the section is open — a closed inspector costs nothing.
  const all = useMemo(
    () => (open && hasParsed ? renderJsonLines(tx.body) : null),
    [open, hasParsed, tx.body],
  );
  const lines = all === null ? null : all.slice(0, MAX_RENDERED_LINES);
  const clipped = all !== null && all.length > MAX_RENDERED_LINES;

  // Pointers this transmission's findings flag for highlighting (advisories are
  // deliberately not among them) — see flaggedPointers.
  const pointers = useMemo(() => flaggedPointers(tx.findings), [tx.findings]);

  const isFlagged = useCallback(
    (path: string): boolean => {
      for (const p of pointers) {
        if (path === p || path.startsWith(`${p}/`)) return true;
      }
      return false;
    },
    [pointers],
  );

  // Scroll the region (not the page) to the requested pointer's first line.
  // `seq` is in the deps so clicking the same pointer twice re-scrolls.
  const seq = locate?.seq;
  const pointer = locate?.pointer;
  useEffect(() => {
    if (!open || pointer === undefined) return;
    const container = scrollRef.current;
    if (container === null) return;
    const target = container.querySelector<HTMLElement>(`[data-path="${CSS.escape(pointer)}"]`);
    if (target === null) return;
    container.scrollTop = Math.max(0, target.offsetTop - 24);
  }, [open, pointer, seq]);

  // Bring the region into the pane's viewport when the HEADER control opened it
  // (9q4). Runs after the payload has rendered, so `block: 'nearest'` on the
  // whole section puts its top edge at the top of the scrollport rather than
  // merely nudging the heading into view. `nearest` also means we never scroll
  // when the region is already visible.
  //
  // `revealSeq` is the ONLY dependency, and that is the whole mechanism (bcb):
  // it is bumped in exactly one place — the header control, and only when that
  // control is the one opening the section. Keying on `open` as well would fire
  // this on every later false->true transition once the header had been used
  // once, since `revealSeq` never returns to 0 — hijacking the section's own
  // heading row and onLocate, which are already on screen and do their own
  // inner scroll respectively. `open` is guaranteed true here without being
  // read: the same click that bumps `revealSeq` sets it.
  useEffect(() => {
    if (revealSeq === 0) return;
    rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [revealSeq]);

  return (
    <div ref={rootRef} id="raw-payload-region">
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          margin: '13px 0 0',
          cursor: 'pointer',
        }}
      >
        <Icon
          name={open ? 'chevronDown' : 'chevron'}
          size={11}
          style={{ color: 'var(--text-faint)' }}
        />
        <span style={eyebrow}>Raw payload</span>
      </div>

      {open && (
        <div style={{ marginTop: 6 }}>
          {note !== null && (
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.45,
                marginBottom: 5,
                color: note.warn ? 'var(--mixed)' : 'var(--text-faint)',
                fontWeight: note.warn ? 600 : 400,
              }}
            >
              {note.warn ? (
                <>
                  <Icon name="alert" size={10} /> {note.text}
                </>
              ) : (
                note.text
              )}
            </div>
          )}
          {lines !== null ? (
            <div
              ref={scrollRef}
              style={{
                position: 'relative',
                maxHeight: RAW_MAX_HEIGHT_PX,
                overflow: 'auto',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '7px 9px',
              }}
            >
              {lines.map((line, i) => {
                const flagged = isFlagged(line.path);
                return (
                  <div
                    key={i}
                    data-path={line.path}
                    style={{
                      ...mono,
                      fontSize: 11,
                      lineHeight: 1.45,
                      whiteSpace: 'pre',
                      background: flagged ? 'var(--mixed-bg)' : 'transparent',
                      boxShadow: flagged ? 'inset 2px 0 0 var(--mixed)' : undefined,
                      color: flagged ? 'var(--text)' : 'var(--text-muted)',
                    }}
                  >
                    {line.text}
                  </div>
                );
              })}
              {clipped && (
                <div
                  style={{
                    ...mono,
                    fontSize: 10.5,
                    marginTop: 4,
                    color: 'var(--mixed)',
                    fontWeight: 600,
                  }}
                >
                  … view clipped at {MAX_RENDERED_LINES.toLocaleString()} of{' '}
                  {all.length.toLocaleString()} lines
                </div>
              )}
            </div>
          ) : tx.raw_body !== null ? (
            // Parse failed (or the body is otherwise absent) — show the stored
            // bytes verbatim. This is the case the inspector exists for.
            <pre
              style={{
                ...mono,
                fontSize: 11,
                lineHeight: 1.45,
                margin: 0,
                maxHeight: RAW_MAX_HEIGHT_PX,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '7px 9px',
                color: 'var(--text-muted)',
              }}
            >
              {tx.raw_body}
            </pre>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              No payload was retained for this transmission.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TxDetail({
  tx,
  onSelectReq,
  shadowProfile,
  signatures,
  onSelectSignature,
}: {
  tx: TransmissionView;
  onSelectReq: (req: string) => void;
  /** The shadow lineage, or null — the hide signal for the whole shadow group. */
  shadowProfile: Profile | null;
  /** The session's signatures: the title and cross-filter target of a shadow row. */
  signatures: readonly Signature[];
  /** Cross-filter the list by a signature (the shadow rows' click). */
  onSelectSignature: (sig: Signature) => void;
}): ReactElement {
  const inventory = deriveInventory(tx.body);
  const rawSummary = rawPayloadSummary(tx);
  const meta = metaCells(tx);
  // Advisories get their own block below the findings (pwd/bva) — they carry no
  // verdict and no §7 requirement, so they must not sit in a list the user reads
  // as this transmission's grades. The split is explicit rather than relying on
  // advisories sorting to the tail of tx.findings, which is incidental.
  const { verdicts, advisories } = splitFindings(tx.findings);
  // The graded findings split by lineage (by1c.14): the contract's grade the
  // transmission, the shadow's say what a DS01.3 run would have made of it. With
  // no shadow lineage the second group is empty and the first is the whole list,
  // so the pane reads exactly as it did before.
  const { contract, shadow } = groupDetailFindings(verdicts, shadowProfile, {
    signatures,
    body: tx.body,
  });
  const copy = detailGroupCopy(shadowProfile, contract.length);
  const shadowName = shadowProfile === null ? null : PROFILE_NAME[shadowProfile];
  const rowHint = shadowName === null ? '' : `Filter the list by this ${shadowName} issue`;

  // Raw-payload inspector state. Open/closed PERSISTS across row selections (so
  // payloads can be compared row to row); the pending scroll target does not.
  const [rawOpen, setRawOpen] = useState(false);
  const [locate, setLocate] = useState<LocateRequest | null>(null);
  const [revealSeq, setRevealSeq] = useState(0);
  const seqRef = useRef(0);
  useEffect(() => {
    setLocate(null);
  }, [tx.id]);

  // A finding's JSON Pointer opens the inspector and scrolls to that line.
  const onLocate = useCallback((p: string) => {
    seqRef.current += 1;
    setRawOpen(true);
    setLocate({ pointer: p, seq: seqRef.current });
  }, []);

  // Toggle from the header control. Opening from up here also asks the region
  // to scroll itself into view (9q4): the region intentionally stays below the
  // findings, so otherwise the click would appear to do nothing. Closing does
  // not scroll — the user is looking at the header, not the region.
  const toggleRawFromHeader = useCallback(() => {
    if (!rawOpen) setRevealSeq((n) => n + 1);
    setRawOpen(!rawOpen);
  }, [rawOpen]);

  return (
    <div style={{ padding: '14px 16px 18px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 10,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ ...mono, fontWeight: 700, fontSize: 13 }}>t-{shortId(tx.id)}</span>
        <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-muted)' }}>
          {tx.sourceLabel} · HTTP {tx.http_status ?? '—'} · {relativeAgo(tx.received_at)}
        </span>
      </div>

      {/*
        Six value cells over three columns — two even rows (j1s, frk):

          transferId · schema      · type
          reports    · bytes       · compression
          raw payload ─────────────────────────

        The six come from metaCells() in that order. The raw-payload expander
        used to be the sixth cell of a five-cell grid; frk's `reports` cell made
        the value cells six, so a seventh would leave a one-wide orphan. It now
        takes a row of its own spanning all three columns, which is truer to what
        it is — a full-width affordance, not another value — and it still sits
        immediately after `compression`, because that cell is already the "what
        shape were the bytes in" signal and "and here are the bytes" is the same
        question one step further in (9q4).
      */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${META_GRID_COLUMNS}, 1fr)`,
          gap: 8,
          marginBottom: 13,
        }}
      >
        {meta.map((cell) => (
          <div key={cell.key} style={{ minWidth: 0 }}>
            <div style={eyebrow}>{cell.key}</div>
            <div
              title={cell.warn ? 'Unexpected Content-Encoding — see the §1.6 finding' : undefined}
              style={{
                ...mono,
                fontSize: 11.5,
                wordBreak: 'break-all',
                color: cell.warn ? 'var(--mixed)' : undefined,
                fontWeight: cell.warn ? 700 : undefined,
              }}
            >
              {cell.warn ? (
                <>
                  <Icon name="alert" size={10} /> {cell.value}
                </>
              ) : (
                cell.value
              )}
            </div>
          </div>
        ))}

        {/*
          The expand control, shaped like a meta cell so the grid stays even.

          The summary text ('parsed JSON' / 'raw bytes …' / 'not retained')
          TRAVELS WITH THE CONTROL rather than staying beside the section
          heading: it is what tells you whether opening is worth it, and that
          decision is now made from up here. Repeating it below would be the
          duplication the shared rawPayloadSummary() exists to prevent.

          It reflects state as well as toggling it — chevron direction plus a
          full-strength text tone when open — because with the region off-screen
          below the findings the control is often the only visible evidence that
          the inspector is already open.
        */}
        <button
          type="button"
          aria-expanded={rawOpen}
          aria-controls="raw-payload-region"
          title={rawOpen ? 'Collapse the raw payload' : 'Show the raw payload below the findings'}
          onClick={toggleRawFromHeader}
          style={{
            gridColumn: '1 / -1',
            minWidth: 0,
            background: 'none',
            border: 'none',
            padding: 0,
            margin: 0,
            textAlign: 'left',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          <span style={eyebrow}>raw payload</span>
          <span
            style={{
              ...mono,
              fontSize: 11.5,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              minWidth: 0,
              color: rawOpen ? 'var(--text)' : 'var(--text-muted)',
              fontWeight: rawOpen ? 600 : undefined,
            }}
          >
            <Icon name={rawOpen ? 'chevronDown' : 'chevron'} size={11} style={{ flexShrink: 0 }} />
            <span
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={rawSummary}
            >
              {rawSummary}
            </span>
          </span>
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 7,
        }}
      >
        <span style={eyebrow}>{copy.contractHeading}</span>
        {copy.contractNote !== null && <span style={eyebrow}>{copy.contractNote}</span>}
      </div>
      {contract.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {contract.map((row, i) => (
            <FindingItem
              key={i}
              finding={row.finding}
              alsoFails={
                row.alsoFails === null || shadowName === null
                  ? null
                  : {
                      clause: row.alsoFails,
                      hint: `Also fails under ${shadowName} ${row.alsoFails}`,
                    }
              }
              onSelectReq={onSelectReq}
              onLocate={onLocate}
            />
          ))}
        </div>
      )}
      {/* With a shadow lineage the empty case is stated on the header's right
          ("none — passes"), so only the no-shadow pane keeps the sentence. */}
      {contract.length === 0 && shadowProfile === null && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No findings for this transmission.
        </div>
      )}

      {/* "Would also fail under DS01.3" (by1c.14) — rendered ONLY when the shadow
          run failed on its own. A contract failure that re-tags forward is marked
          in place above instead, so nothing appears twice.

          The count is the number of shadow FAILURES, which is the number the
          row's verdict tooltip shows for the same transmission — one question,
          one answer (by1c.39). It is deliberately not the number of rows: rows
          collapse several missing properties at one path into one line, so a
          count of rows would read as a second, smaller total sitting directly
          under the first. */}
      {shadow.length > 0 && copy.shadowHeading !== null && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 10,
              margin: '13px 0 7px',
            }}
          >
            <span style={eyebrow}>{copy.shadowHeading}</span>
            <span style={eyebrow}>{shadowFailCount(tx.findings, shadowProfile)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {shadow.map((row) => (
              <ShadowFindingRow
                key={`${row.key}|${shadowRowText(row)}`}
                row={row}
                hint={rowHint}
                onSelectSignature={onSelectSignature}
                onLocate={onLocate}
              />
            ))}
          </div>
        </>
      )}

      {/* Advisories (pwd/bva) — a separate block with its own heading, below the
          findings and outside them, so nothing here reads as one of this
          transmission's verdicts. Absent entirely when there are none. */}
      {advisories.length > 0 && (
        <>
          <div style={{ ...eyebrow, margin: '13px 0 7px' }}>
            {ADVISORY_COPY.transmissionEyebrow}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {advisories.map((f, i) => (
              <AdvisoryItem key={i} finding={f} onLocate={onLocate} />
            ))}
          </div>
        </>
      )}

      {inventory.length > 0 && (
        <>
          <div style={{ ...eyebrow, margin: '13px 0 6px' }}>Object inventory</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {inventory.map((o) => (
              <span
                key={o}
                style={{
                  ...mono,
                  fontSize: 11,
                  padding: '2px 7px',
                  borderRadius: 4,
                  background: 'var(--surface-3)',
                  color: 'var(--text-muted)',
                }}
              >
                {o}
              </span>
            ))}
          </div>
        </>
      )}

      <RawPayload
        tx={tx}
        open={rawOpen}
        onToggle={() => setRawOpen((o) => !o)}
        locate={locate}
        revealSeq={revealSeq}
      />
    </div>
  );
}

export function TransmissionsCard({
  transmissions,
  selectedTx,
  onSelectTx,
  onSelectReq,
  failuresOnly,
  onToggleFailuresOnly,
  activeSignature,
  onClearSignature,
  visibleCount,
  scopedTotal,
  onLoadMore,
  hasMore,
  isLoadingMore,
  shadowProfile,
  signatures,
  onSelectSignature,
}: TransmissionsCardProps): ReactElement {
  // Default to the newest (first) transmission when nothing is selected or the
  // selection no longer exists. The API returns newest-first, so [0] is newest.
  // Dashboard owns selection reconciliation; we only resolve the row to dock.
  const selected = transmissions.find((t) => t.id === selectedTx) ?? transmissions[0] ?? null;
  // Header denominator: prefer the post-filter scoped total from the list
  // response; fall back to the page length when the seam isn't supplied.
  const visible = visibleCount ?? transmissions.length;
  const scoped = scopedTotal ?? transmissions.length;

  // Virtualization (4h4.13): the scrolling list region is the scroll element.
  // We render only the visible window of rows, absolutely positioned inside a
  // full-height spacer, so a list of thousands stays smooth. Rows are NOT
  // fixed-height (the chrome wraps), so estimateSize + measureElement keep the
  // measured heights honest. Header/issue-bar/detail stay outside this and are
  // never virtualized.
  const listRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: transmissions.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
    getItemKey: (index) => transmissions[index]?.id ?? index,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  // Infinite scroll: when the last rendered row nears the end of the
  // accumulated list, raise onLoadMore so Dashboard appends the next cursor
  // page. Guard on hasMore + !isLoadingMore so we never double-fire a page that
  // is already in flight (or past the last page). Reads the LAST virtual item
  // rather than a scroll handler so it stays correct under measurement.
  const lastIndex = virtualItems[virtualItems.length - 1]?.index;
  useEffect(() => {
    if (!onLoadMore || !hasMore || isLoadingMore) return;
    if (lastIndex === undefined) return;
    if (lastIndex >= transmissions.length - 5) onLoadMore();
  }, [lastIndex, transmissions.length, onLoadMore, hasMore, isLoadingMore]);

  return (
    <div
      style={{
        flex: '1 1 44%',
        background: 'var(--surface-tx)',
        border: '1px solid var(--border-strong)',
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: 'var(--shadow)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>Transmissions</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          · showing {visible} of {scoped}
        </span>
        <span style={{ flex: 1 }} />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={failuresOnly ?? false}
            onChange={() => onToggleFailuresOnly?.()}
          />
          Failures only
        </label>
      </div>

      {activeSignature && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 16px',
            background: 'var(--accent-weak)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '.05em',
              color: 'var(--accent-text)',
              fontWeight: 700,
            }}
          >
            {signatureEyebrow(activeSignature)}
          </span>
          <span
            title={chipTitle(activeSignature)}
            style={{
              fontSize: 12,
              color: 'var(--text)',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {chipTitle(activeSignature)}
          </span>
          <button
            type="button"
            onClick={() => onClearSignature?.()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: 'var(--text-muted)',
              background: 'var(--surface)',
              border: '1px solid var(--border-strong)',
              borderRadius: 6,
              padding: '2px 7px',
              cursor: 'pointer',
            }}
          >
            <Icon name="x" size={11} /> Clear
          </button>
        </div>
      )}

      {transmissions.length === 0 ? (
        <div style={{ padding: '34px 24px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 300, margin: '0 auto' }}>
            No transmissions match the current filters. Widen the time window or clear a filter.
          </div>
        </div>
      ) : (
        <>
          {/* Verdict column header (by1c.12) — the only column labels the list
              carries, sized and right-aligned to match the dot slot at the end of
              each row. The DS01.3 column is absent when no shadow lineage is
              registered, which is the same condition that drops the second dot. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '5px 16px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span style={{ flex: 1 }} />
            {verdictColumns(shadowProfile).map((profile) => (
              <span
                key={profile}
                style={{ ...eyebrow, ...mono, width: VERDICT_COL_PX, textAlign: 'right' }}
              >
                {PROFILE_NAME[profile]}
              </span>
            ))}
          </div>

          {/* Scrolling list region — API returns newest-first; no re-sort.
              Row-virtualized (4h4.13): only the visible window renders, each row
              absolutely positioned inside a full-height spacer so the region's
              size + scrollbar stay correct. measureElement keeps non-fixed row
              heights honest.

              Sizing (5bs.6): `0 1 auto` + LIST_MAX_HEIGHT_PX — the region is as
              tall as its content up to ~LIST_VISIBLE_ROWS rows, then scrolls,
              and may still shrink below that on a short card so the docked
              detail keeps its min-height. A short list no longer strands the
              detail pane at the bottom of a half-empty region. */}
          <div
            ref={listRef}
            style={{
              overflowY: 'auto',
              flex: '0 1 auto',
              maxHeight: LIST_MAX_HEIGHT_PX,
              minHeight: 0,
            }}
          >
            <div
              style={{
                height: rowVirtualizer.getTotalSize(),
                position: 'relative',
                width: '100%',
              }}
            >
              {virtualItems.map((vi) => {
                const t = transmissions[vi.index];
                if (!t) return null;
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <TxRow
                      tx={t}
                      selected={selected !== null && selected.id === t.id}
                      onSelect={() => onSelectTx(t.id)}
                      shadowProfile={shadowProfile}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {/* Pinned detail region — selecting a row only swaps this; list never reflows. */}
          <div
            style={{
              flex: '1 1 44%',
              minHeight: 120,
              overflowY: 'auto',
              background: 'var(--detail)',
              borderTop: '2px solid var(--border-strong)',
            }}
          >
            {selected ? (
              <TxDetail
                tx={selected}
                onSelectReq={onSelectReq}
                shadowProfile={shadowProfile}
                signatures={signatures}
                onSelectSignature={onSelectSignature}
              />
            ) : (
              <div
                style={{
                  padding: '28px 16px',
                  textAlign: 'center',
                  fontSize: 12,
                  color: 'var(--text-faint)',
                }}
              >
                Select a transmission to see its findings.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
