/**
 * ComplianceCard (108.5) — the redesigned §7 compliance summary that replaces
 * the flat Matrix table (README §Screens 2 → ComplianceCard).
 *
 * RENDER-ONLY: this renders the exact `summary` the API returns. It groups rows
 * by verifiability (`classes[0]`) and derives nothing — no reclassification, no
 * status recompute. The five groups, their order, gradeable flags, and collapse
 * defaults mirror the prototype's engine.js GROUPS.
 *
 * Props match `CompliancePaneProps` in Dashboard.tsx verbatim; the parent owns
 * all the state (filter, open row, collapse map, selected tx).
 */
import type { CSSProperties, ReactElement } from 'react';
import { useEffect } from 'react';
import type { ComplianceClass, ComplianceRow, Severity, TransmissionView } from '../api';
import { StatusPill } from './ui/StatusPill';
import { Icon } from './ui/Icon';
import { CLASS_META } from './ui/statusMaps';
import { getRequirementReference } from './requirementReference';

/* ------------------------------------------------------------------ *
 * Props — EXACT copy of Dashboard.tsx CompliancePaneProps + CollapsedGroups.
 * ------------------------------------------------------------------ */

/** Per-verifiability-class collapse map for the non-gradeable groups. */
type CollapsedGroups = Partial<Record<ComplianceClass, boolean>>;

export interface CompliancePaneProps {
  summary: ComplianceRow[];
  /**
   * All captured transmissions. Used ONLY to derive the per-requirement
   * "From transmissions" chips frontend-side (a finding→tx navigation linkage);
   * the compliance summary/rollup is never recomputed from these.
   */
  transmissions: TransmissionView[];
  /** Newest tx selected in the right pane — drives "From transmissions" chips. */
  selectedTx: string | null;
  /** Pick a transmission from a requirement's contributing chip. */
  onSelectTx: (id: string) => void;
  /** Which requirement row is open (drill-down + finding→req cross-link). */
  expandedReq: string | null;
  /** Toggle the open requirement row. */
  onToggleReq: (req: string | null) => void;
  /** "Show what we can't grade" filter — wired to the header checkbox. */
  showNonGradeable: boolean;
  /** Setter for the filter checkbox. */
  onShowNonGradeableChange: (next: boolean) => void;
  /** Collapse state for the non-gradeable groups. */
  collapsedGroups: CollapsedGroups;
  /** Toggle a non-gradeable group's collapse. */
  onToggleGroup: (cls: ComplianceClass) => void;
}

/* ------------------------------------------------------------------ *
 * Group definitions — the 5 prototype GROUPS, in order. Each group owns a set
 * of real ComplianceClass values (matched against row.classes[0]); the group's
 * presentational label/blurb/gradeable flag are pulled from CLASS_META on its
 * representative class so we don't restate copy that already lives in 108.2.
 *
 *   verified      → Verified            (gradeable)
 *   heuristic     → Heuristic           (gradeable)
 *   attestation   → Self-attested       (collapsible, expanded by default)
 *   active-only   → Needs active testing(collapsible, collapsed by default)
 *   none|enforced → Permissive          (collapsible, collapsed by default)
 *
 * `enforced` (and any future enforced-as-primary class) folds into Permissive,
 * per the bite context — the prototype has no separate Enforced group.
 * ------------------------------------------------------------------ */

interface GroupDef {
  /** The class whose CLASS_META supplies this group's label/blurb/gradeable. */
  rep: ComplianceClass;
  /** Real classes (matched on classes[0]) that fall into this group. */
  members: ComplianceClass[];
  /** Default collapsed state for the non-gradeable collapsible groups. */
  defaultCollapsed: boolean;
}

const GROUPS: GroupDef[] = [
  { rep: 'verified', members: ['verified'], defaultCollapsed: false },
  { rep: 'heuristic', members: ['heuristic'], defaultCollapsed: false },
  { rep: 'attestation', members: ['attestation'], defaultCollapsed: false },
  { rep: 'active-only', members: ['active-only'], defaultCollapsed: true },
  { rep: 'none', members: ['none', 'enforced'], defaultCollapsed: true },
];

/** Effective collapse state: the parent's value if set, else the group default. */
function isCollapsed(group: GroupDef, collapsedGroups: CollapsedGroups): boolean {
  const v = collapsedGroups[group.rep];
  return v === undefined ? group.defaultCollapsed : v;
}

/** Find the group whose members include the given row's primary class. */
function groupForRow(row: ComplianceRow): GroupDef | undefined {
  const primary = row.classes[0];
  if (primary === undefined) return undefined;
  return GROUPS.find((g) => g.members.includes(primary));
}

/* ------------------------------------------------------------------ *
 * Row — a single requirement, expandable into its detail panel.
 * ------------------------------------------------------------------ */

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const mono = 'var(--mono)';

/**
 * A short, mono-friendly transmission id for the `t-XXXX` chip label — kept in
 * sync with TransmissionsCard's `shortId` (trailing 8 chars) so chip labels
 * match the right pane the click selects.
 */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

function ReqRow({
  row,
  dead,
  expanded,
  onToggle,
  transmissions,
  selectedTx,
  onSelectTx,
}: {
  row: ComplianceRow;
  dead: boolean;
  expanded: boolean;
  onToggle: () => void;
  transmissions: TransmissionView[];
  selectedTx: string | null;
  onSelectTx: (id: string) => void;
}): ReactElement {
  const ref = getRequirementReference(row.requirement);
  const text = ref?.text ?? row.summary;
  const guidance = ref?.guidance;

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 13,
    padding: '9px 16px',
    cursor: 'pointer',
    opacity: dead ? 0.5 : 1,
    borderBottom: '1px solid var(--border)',
    background: expanded ? 'var(--detail)' : 'transparent',
    transition: prefersReducedMotion ? undefined : 'background 120ms ease',
  };

  return (
    <div data-req={row.requirement}>
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={rowStyle}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 11.5,
            color: 'var(--text-faint)',
            width: 30,
            flexShrink: 0,
          }}
        >
          {row.requirement}
        </span>
        <span style={{ flex: 1, fontSize: 13 }}>
          {row.summary}
          <Icon
            name="info"
            size={11}
            style={{ color: 'var(--text-faint)', marginLeft: 6, verticalAlign: 'middle' }}
          />
        </span>
        {!dead && (
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: 'var(--text-faint)',
              width: 58,
              textAlign: 'right',
              flexShrink: 0,
            }}
          >
            {row.counts.fail > 0 && (
              <span style={{ color: 'var(--fail)' }}>{row.counts.fail}f </span>
            )}
            {row.counts.pass > 0 && (
              <span style={{ color: 'var(--pass)' }}>{row.counts.pass}p</span>
            )}
            {row.counts.pass + row.counts.fail === 0 && '—'}
          </span>
        )}
        <span style={{ width: 88, textAlign: 'right', flexShrink: 0 }}>
          {dead ? <StatusPill status={row.status} /> : <StatusPill status={row.status} dot />}
        </span>
      </div>
      {expanded && (
        <div
          style={{
            background: 'var(--detail)',
            borderBottom: '1px solid var(--border)',
            padding: '12px 16px 15px 60px',
          }}
        >
          <div style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: 640 }}>{text}</div>
          {guidance && (
            <div
              style={{
                marginTop: 10,
                fontSize: 11.5,
                lineHeight: 1.65,
                color: 'var(--text-muted)',
                maxWidth: 640,
                paddingLeft: 12,
                borderLeft: '2px solid var(--detail-accent)',
              }}
            >
              <strong style={{ fontWeight: 600, color: 'var(--text)' }}>How we check it. </strong>
              {guidance}
            </div>
          )}
          {renderContributingChips({
            requirement: row.requirement,
            transmissions,
            selectedTx,
            onSelectTx,
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Renders the "From transmissions" chip section for a requirement drill-down.
 *
 * The compliance `summary` is a rolled-up view with no tx ids, but the linkage
 * exists elsewhere: each `TransmissionView.findings[]` references a `requirement`.
 * We derive the finding→tx navigation linkage frontend-side here (NOT a summary
 * recompute): walk every transmission's findings and emit one chip per finding
 * whose `requirement` matches this row, newest-first like the prototype's
 * `.reverse()`. Clicking a chip selects that tx in the right pane via
 * `onSelectTx`; the chip matching `selectedTx` is marked active. Requirements
 * with no contributing finding render no section at all.
 */
function renderContributingChips({
  requirement,
  transmissions,
  selectedTx,
  onSelectTx,
}: {
  requirement: string;
  transmissions: TransmissionView[];
  selectedTx: string | null;
  onSelectTx: (id: string) => void;
}): ReactElement | null {
  const chips: { id: string; sev: Severity }[] = [];
  for (const tx of transmissions) {
    for (const f of tx.findings) {
      if (f.requirement === requirement) chips.push({ id: tx.id, sev: f.severity });
    }
  }
  chips.reverse(); // newest-first, matching the prototype

  if (chips.length === 0) return null;

  return (
    <div style={{ marginTop: 11 }}>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          color: 'var(--text-faint)',
          marginBottom: 5,
        }}
      >
        From transmissions
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {chips.map((c, i) => {
          const active = selectedTx === c.id;
          return (
            <button
              key={`${c.id}·${c.sev}·${i}`}
              onClick={() => onSelectTx(c.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontFamily: mono,
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                cursor: 'pointer',
                border: active ? '2px solid var(--text)' : '1px solid var(--border-strong)',
                background: 'var(--surface)',
                color: active ? 'var(--text)' : 'var(--text-muted)',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background:
                    c.sev === 'fail'
                      ? 'var(--fail)'
                      : c.sev === 'info'
                        ? 'var(--neutral)'
                        : 'var(--pass)',
                }}
              />
              t-{shortId(c.id)} · {c.sev}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card.
 * ------------------------------------------------------------------ */

export function ComplianceCard({
  summary,
  transmissions,
  selectedTx,
  onSelectTx,
  expandedReq,
  onToggleReq,
  showNonGradeable,
  onShowNonGradeableChange,
  collapsedGroups,
  onToggleGroup,
}: CompliancePaneProps): ReactElement {
  /*
   * Cross-link reveal (gfx): when a finding §req sets `expandedReq` to a row in a
   * group that's collapsed or filtered out, the row never renders and the click
   * dead-ends. Here we make the target row's group visible: enable the filter if
   * the group is non-gradeable and hidden, and un-collapse it if collapsed.
   *
   * Deps are deliberately ONLY `expandedReq` + `summary`: we read the current
   * `collapsedGroups`/`showNonGradeable` to decide whether a toggle is needed,
   * but we don't want the effect to re-fire when those change (the toggles below
   * would otherwise risk a loop / fight a user re-collapsing the group). The
   * guards ensure each setter fires at most once per cross-link.
   */
  useEffect(() => {
    if (expandedReq === null) return;
    const row = summary.find((r) => r.requirement === expandedReq);
    if (row === undefined) return;
    const group = groupForRow(row);
    if (group === undefined) return;

    const gradeable = CLASS_META[group.rep].gradeable;
    if (gradeable) return; // gradeable groups are always visible — nothing to do

    if (!showNonGradeable) onShowNonGradeableChange(true);
    if (isCollapsed(group, collapsedGroups)) onToggleGroup(group.rep);
  }, [expandedReq, summary]);

  /*
   * Scroll the target row into view — SEPARATE from the reveal effect above so it
   * runs AFTER the un-collapse/un-filter setters have re-rendered the row into the
   * DOM. Keyed on `expandedReq` plus the current `showNonGradeable`/`collapsedGroups`
   * so that when a collapsed/filtered cross-link target becomes visible, this fires
   * again with the row now present (the reveal effect deliberately omits those deps
   * to avoid re-firing the toggles, so the scroll cannot live there). A rAF defers
   * past layout to guarantee the row is mounted; it's cancelled on cleanup.
   */
  useEffect(() => {
    if (expandedReq === null) return;
    if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;

    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-req="${CSS.escape(expandedReq)}"]`);
      el?.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [expandedReq, showNonGradeable, collapsedGroups]);

  return (
    <div
      style={{
        flex: '1 1 57%',
        background: 'var(--surface)',
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
          gap: 10,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>Compliance summary</span>
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
            checked={showNonGradeable}
            onChange={(e) => onShowNonGradeableChange(e.target.checked)}
          />
          Show what we can&apos;t grade
        </label>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {GROUPS.map((group) => {
          const meta = CLASS_META[group.rep];
          const gradeable = meta.gradeable;
          // Filter off → groups 3-5 (the non-gradeable ones) are removed entirely.
          if (!gradeable && !showNonGradeable) return null;

          const rows = summary.filter((r) => {
            const primary = r.classes[0];
            return primary !== undefined && group.members.includes(primary);
          });
          if (rows.length === 0) return null;

          const collapsed = !gradeable && isCollapsed(group, collapsedGroups);

          return (
            <div key={group.rep}>
              <div
                onClick={gradeable ? undefined : () => onToggleGroup(group.rep)}
                role={gradeable ? undefined : 'button'}
                tabIndex={gradeable ? undefined : 0}
                aria-expanded={gradeable ? undefined : !collapsed}
                onKeyDown={
                  gradeable
                    ? undefined
                    : (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onToggleGroup(group.rep);
                        }
                      }
                }
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  padding: '10px 16px 8px',
                  background: gradeable ? 'transparent' : 'var(--surface-3)',
                  borderTop: '1px solid var(--border)',
                  borderBottom: gradeable ? '2px solid var(--text)' : '1px solid var(--border)',
                  cursor: gradeable ? 'default' : 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                }}
              >
                {!gradeable && (
                  <Icon
                    name={collapsed ? 'chevron' : 'chevronDown'}
                    size={12}
                    style={{ color: 'var(--text-faint)' }}
                  />
                )}
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: gradeable ? 'var(--text)' : 'var(--text-muted)',
                  }}
                >
                  {meta.label}
                </span>
                <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-faint)' }}>
                  {rows.length}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 11.5,
                    color: 'var(--text-faint)',
                    textAlign: 'right',
                  }}
                >
                  {meta.blurb}
                </span>
              </div>
              {!collapsed &&
                rows.map((row) => (
                  <ReqRow
                    key={row.requirement}
                    row={row}
                    dead={!gradeable}
                    expanded={expandedReq === row.requirement}
                    onToggle={() =>
                      onToggleReq(expandedReq === row.requirement ? null : row.requirement)
                    }
                    transmissions={transmissions}
                    selectedTx={selectedTx}
                    onSelectTx={onSelectTx}
                  />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
