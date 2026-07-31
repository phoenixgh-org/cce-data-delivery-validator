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
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { FindingView, Severity, Signature, TransmissionView } from '../api';
import type { DisplayStatus } from '../api';
import { Icon } from './ui/Icon';
import { StatusPill } from './ui/StatusPill';

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
 * Derive the row dot tone from the transmission's findings:
 *   any fail            -> fail
 *   pass AND fail mix    -> (covered by the fail branch; "mixed" = some pass + some fail)
 *   all pass             -> pass
 *   none                 -> neutral
 * Per the spec, any fail dominates; a mix of pass+fail reads as "mixed".
 */
function dotTone(findings: FindingView[]): DotTone {
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
 * 8px padding top + ~20px line box (11.5px mono) + 8px padding bottom + 1px
 * bottom border = 37.
 */
const ROW_ESTIMATE_PX = 37;

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
 * number that would drift if the row chrome changes: 10 × 37 = 370px.
 *
 * Height budget above the detail pane, at 16px root padding:
 *   header ~66 + setup bar ~40 + scorecard ~62 + filter bar ~40  ≈ 208
 *   + body padding 16 + card header ~44 + list 370                = 638
 * so the docked detail starts at ~640px and clears the fold on an 800px-tall
 * viewport (~160px of detail visible, above its own 120px min-height) and
 * comfortably so at 1000px (~360px). An active issue chip adds ~33px, still
 * inside the budget. The list keeps its own scrollbar and stays virtualized —
 * this caps the region, it does not page the data.
 */
const LIST_MAX_HEIGHT_PX = ROW_ESTIMATE_PX * LIST_VISIBLE_ROWS;

/** HTTP status tone: 2xx pass, 3xx/4xx mixed, 5xx (or unknown) fail. */
function httpTone(status: number | null): string {
  if (status === null) return 'var(--text-faint)';
  if (status < 300) return 'var(--pass)';
  if (status < 500) return 'var(--mixed)';
  return 'var(--fail)';
}

function TxRow({
  tx,
  selected,
  onSelect,
}: {
  tx: TransmissionView;
  selected: boolean;
  onSelect: () => void;
}): ReactElement {
  const tone = dotTone(tx.findings);
  const outdated = tx.findings.some((f) => f.outdated);
  const failCount = tx.findings.filter((f) => f.severity === 'fail').length;
  const findingCount = tx.findings.length;

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
      {findingCount > 0 ? (
        <span
          style={{
            ...mono,
            fontSize: 10.5,
            color: failCount > 0 ? 'var(--fail)' : 'var(--text-muted)',
            width: 28,
            textAlign: 'right',
          }}
        >
          {findingCount}f
        </span>
      ) : (
        <span
          style={{
            ...mono,
            fontSize: 10.5,
            color: 'var(--text-faint)',
            width: 28,
            textAlign: 'right',
          }}
        >
          ok
        </span>
      )}
    </div>
  );
}

const eyebrow: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  color: 'var(--text-faint)',
};

function FindingItem({
  finding,
  onSelectReq,
}: {
  finding: FindingView;
  onSelectReq: (req: string) => void;
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
            color: 'var(--accent)',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          §{finding.requirement}
        </button>
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
      {finding.pointer !== null && (
        <div style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2 }}>
          pointer: {finding.pointer}
        </div>
      )}
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

function TxDetail({
  tx,
  onSelectReq,
}: {
  tx: TransmissionView;
  onSelectReq: (req: string) => void;
}): ReactElement {
  const inventory = deriveInventory(tx.body);
  const meta: Array<[string, string]> = [
    ['transferId', tx.transfer_id ?? '—'],
    ['schema', tx.schema_version ? `v${tx.schema_version}` : '—'],
    ['bytes', tx.wire_bytes ?? '—'],
    ['type', tx.content_type ?? '—'],
  ];

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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 8,
          marginBottom: 13,
        }}
      >
        {meta.map(([k, v]) => (
          <div key={k} style={{ minWidth: 0 }}>
            <div style={eyebrow}>{k}</div>
            <div style={{ ...mono, fontSize: 11.5, wordBreak: 'break-all' }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ ...eyebrow, marginBottom: 7 }}>Findings · click § to open the requirement</div>
      {tx.findings.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No findings for this transmission.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {tx.findings.map((f, i) => (
            <FindingItem key={i} finding={f} onSelectReq={onSelectReq} />
          ))}
        </div>
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
              color: 'var(--accent)',
              fontWeight: 700,
            }}
          >
            Issue
          </span>
          <span
            title={activeSignature.title}
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
            {activeSignature.title}
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
              <TxDetail tx={selected} onSelectReq={onSelectReq} />
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
