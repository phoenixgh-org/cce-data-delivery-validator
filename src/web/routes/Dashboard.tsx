/**
 * Dashboard route `/d/:uuid`. Fetches the session via GET /api/sessions/:uuid
 * and renders the redesigned two-pane shell (README §Screens 2): header →
 * collapsible Setup bar/panel → scorecard strip → [ComplianceCard |
 * TransmissionsCard]. This shell owns the loading + 404 (unknown/expired uuid)
 * + error states, the 5s background poll, and the lifted cross-link/UI state.
 *
 * Data flow is UNCHANGED from the prior layout: the `load` callback, the
 * initial-load effect, and the visibility-aware 5s poll are preserved verbatim.
 * Only the `phase === 'ready'` render is the redesign.
 *
 * NOTE (108.5/108.6/108.7/108.8): CompliancePane and TransmissionsPane below
 * are PLACEHOLDERS that wrap the existing Matrix/Transmissions components inside
 * the new card chrome. They will be extracted into ComplianceCard.tsx /
 * TransmissionsCard.tsx, which is where the lifted state below (expandedReq,
 * selectedTx, showNonGradeable, collapsedGroups, the delete modal) gets fully
 * consumed. The state is owned + plumbed here now as the forward contract.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  getSession,
  type ComplianceClass,
  type ComplianceRow,
  type SessionResponse,
  type TransmissionView,
} from '../api';
import { Matrix } from '../components/Matrix';
import { Setup } from '../components/Setup';
import { Transmissions } from '../components/Transmissions';
import { Icon } from '../components/ui/Icon';

type State =
  | { phase: 'loading' }
  | { phase: 'not-found' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: SessionResponse };

/**
 * Background auto-refresh cadence (qkc). The dashboard silently refetches the
 * session on this interval so newly-arrived transmissions appear without a
 * manual reload. SSE-based push is tracked separately (to8) as a lower-latency
 * replacement; polling is the no-backend-change baseline.
 */
const POLL_INTERVAL_MS = 5000;

/** Fixed schema version surfaced in the header/scorecard copy (README §2). */
const SCHEMA_VERSION = '0.8.1';

const MS_PER_DAY = 86_400_000;

/** Whole days remaining until `expiresAt`; ceil so a sub-day remainder reads as 1. */
function daysLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / MS_PER_DAY));
}

/** Shorten a uuid for display: `8f3c1d2a…3d10` (first 8 · ellipsis · last 4). */
function shortUuid(uuid: string): string {
  if (uuid.length <= 13) return uuid;
  return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}

/** A requirement is gradeable when its primary class is verified or heuristic. */
function isGradeable(cls: ComplianceClass | undefined): boolean {
  return cls === 'verified' || cls === 'heuristic';
}

interface Rollup {
  total: number;
  gradeable: number;
  passing: number;
  failing: number;
  untested: number;
}

/**
 * Gradeable rollup — EXACT spec from redesign/engine.js `rollup()`. Counts
 * passing/failing/untested over GRADEABLE rows only (primary class verified or
 * heuristic); self-attested/active/permissive/enforced rows are never counted.
 * `failing` folds `mixed` in with `fail` (a row with any failure is "failing").
 */
function computeRollup(summary: ComplianceRow[]): Rollup {
  const grade = summary.filter((r) => isGradeable(r.classes[0]));
  return {
    total: summary.length,
    gradeable: grade.length,
    passing: grade.filter((r) => r.status === 'pass').length,
    failing: grade.filter((r) => r.status === 'fail' || r.status === 'mixed').length,
    untested: grade.filter((r) => r.status === 'untested').length,
  };
}

/** Per-verifiability-class collapse map for the non-gradeable groups. */
type CollapsedGroups = Partial<Record<ComplianceClass, boolean>>;

/* ------------------------------------------------------------------ *
 * Placeholder panes — wrap the existing Matrix/Transmissions inside the
 * redesign card chrome. 108.5/108.6 replace the internals (and consume the
 * deferred props plumbed here); for now only what is implementable is used.
 * ------------------------------------------------------------------ */

interface CompliancePaneProps {
  summary: ComplianceRow[];
  /** Newest tx selected in the right pane — drives "From transmissions" chips (108.5). */
  selectedTx: string | null;
  /** Pick a transmission from a requirement's contributing chip (108.5/108.6). */
  onSelectTx: (id: string) => void;
  /** Which requirement row is open (108.5 drill-down + finding→req cross-link). */
  expandedReq: string | null;
  /** Toggle the open requirement row (108.5). */
  onToggleReq: (req: string | null) => void;
  /** "Show what we can't grade" filter — wired to the header checkbox now. */
  showNonGradeable: boolean;
  /** Setter for the filter checkbox (used now). */
  onShowNonGradeableChange: (next: boolean) => void;
  /** Collapse state for the non-gradeable groups (108.5). */
  collapsedGroups: CollapsedGroups;
  /** Toggle a non-gradeable group's collapse (108.5). */
  onToggleGroup: (cls: ComplianceClass) => void;
}

/**
 * ComplianceCard placeholder. Renders the existing Matrix inside the card
 * chrome. `showNonGradeable` + `onShowNonGradeableChange` ARE wired to the
 * header checkbox now (no visible effect on Matrix yet — 108.5 wires the
 * grouped view). The remaining props (selectedTx, onSelectTx, expandedReq,
 * onToggleReq, collapsedGroups, onToggleGroup) are the forward contract for
 * 108.5/108.6 and intentionally NOT destructured here to avoid no-unused-vars.
 */
function CompliancePane({
  summary,
  showNonGradeable,
  onShowNonGradeableChange,
}: CompliancePaneProps) {
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
          Show what we can't grade
        </label>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '0 16px' }}>
        <Matrix summary={summary} />
      </div>
    </div>
  );
}

interface TransmissionsPaneProps {
  transmissions: TransmissionView[];
  /** Selected transmission shown in detail; default = newest (108.6). */
  selectedTx: string | null;
  /** Select a transmission row (108.6). */
  onSelectTx: (id: string) => void;
  /** Cross-link: a finding's §req opens that requirement in the compliance pane (108.6). */
  onSelectReq: (req: string) => void;
}

/**
 * TransmissionsCard placeholder. Renders the existing Transmissions inside the
 * --surface-tx card chrome. selectedTx/onSelectTx/onSelectReq are the forward
 * contract for 108.6 (the existing list has no selection model yet) and are NOT
 * destructured here to avoid no-unused-vars.
 */
function TransmissionsPane({ transmissions }: TransmissionsPaneProps) {
  return (
    <div
      style={{
        flex: '1 1 43%',
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
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>Transmissions</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          · {transmissions.length} recent
        </span>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '0 16px' }}>
        <Transmissions transmissions={transmissions} />
      </div>
    </div>
  );
}

export function Dashboard() {
  const { uuid } = useParams<{ uuid: string }>();
  const [state, setState] = useState<State>({ phase: 'loading' });

  // ---- Lifted cross-link / UI state (README §State). The shell owns it; the
  // panes consume it. Most is exercised by 108.5/108.6/108.8 — see pane props.
  const [setupOpen, setSetupOpen] = useState(true);
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const [expandedReq, setExpandedReq] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<string | null>(null);
  const [showNonGradeable, setShowNonGradeable] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<CollapsedGroups>({
    attestation: false,
    'active-only': true,
    none: true,
  });
  // deleteModalOpen + deleteConfirm: owned here; consumed by the Danger zone +
  // Delete modal built in 108.7/108.8.
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  // Refetch the session. Used by the initial-load effect, the background poll,
  // and children that mutate session state (e.g. Setup's §1.3 auth toggle). The
  // `cancelled` guard lets a caller drop a stale in-flight response on
  // unmount/uuid change. In `background` mode a transient network/5xx error is
  // swallowed — the live view is kept and the next tick retries — rather than
  // replacing healthy data with the full-screen error state; a 404 (the session
  // genuinely expired) still transitions to not-found.
  const load = useCallback(
    (cancelled?: () => boolean, opts?: { background?: boolean }) => {
      if (!uuid) {
        setState({ phase: 'not-found' });
        return;
      }
      getSession(uuid)
        .then((result) => {
          if (cancelled?.()) return;
          if (result.ok) setState({ phase: 'ready', data: result.data });
          else setState({ phase: 'not-found' });
        })
        .catch((err: unknown) => {
          if (cancelled?.() || opts?.background) return;
          setState({
            phase: 'error',
            message: err instanceof Error ? err.message : 'Failed to load session',
          });
        });
    },
    [uuid],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Auto-refresh while the dashboard is showing data. Polling pauses when the
  // tab is backgrounded (no point refetching a session nobody is watching) and
  // fires an immediate catch-up refresh when the tab becomes visible again.
  const isReady = state.phase === 'ready';
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    const guard = () => cancelled;

    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => load(guard, { background: true }), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        load(guard, { background: true });
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isReady, load]);

  // Derive the data the render needs (safe defaults while not ready).
  const data = state.phase === 'ready' ? state.data : null;
  const transmissions = data?.transmissions ?? [];
  const summary = data?.summary ?? [];
  const txCount = transmissions.length;

  // Auto-collapse rule (README §Interactions): Setup is open while the endpoint
  // has zero transmissions; the FIRST transmission collapses it ONCE (tracked
  // via autoCollapsed so a later manual reopen isn't fought by the poll).
  // Returning to zero transmissions (after delete) re-opens it.
  useEffect(() => {
    if (txCount > 0 && !autoCollapsed) {
      setSetupOpen(false);
      setAutoCollapsed(true);
    } else if (txCount === 0) {
      setSetupOpen(true);
      setAutoCollapsed(false);
    }
  }, [txCount, autoCollapsed]);

  // Keep a sensible selected transmission (default = newest; the API returns
  // transmissions newest-first, so [0] is newest).
  useEffect(() => {
    const newest = transmissions[0];
    if (!newest) {
      setSelectedTx(null);
      return;
    }
    setSelectedTx((cur) => (cur && transmissions.some((t) => t.id === cur) ? cur : newest.id));
  }, [transmissions]);

  const rollup = useMemo(() => computeRollup(summary), [summary]);

  const toggleGroup = useCallback((cls: ComplianceClass) => {
    setCollapsedGroups((prev) => ({ ...prev, [cls]: !prev[cls] }));
  }, []);

  if (state.phase === 'loading') {
    return (
      <main className="container">
        <p>Loading…</p>
      </main>
    );
  }

  if (state.phase === 'not-found') {
    return (
      <main className="container">
        <h1>Endpoint not found</h1>
        <p>This test endpoint does not exist, or it expired after 7 days of inactivity.</p>
        <p>
          <Link to="/">Create a new test endpoint</Link>
        </p>
      </main>
    );
  }

  if (state.phase === 'error') {
    return (
      <main className="container">
        <h1>Something went wrong</h1>
        <p className="error">{state.message}</p>
      </main>
    );
  }

  const { session, expiresAt } = state.data;
  const ingestUrl = `/i/${session.uuid}`;
  const hasData = txCount > 0;
  const short = shortUuid(session.uuid);
  const days = daysLeft(expiresAt);

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--canvas)',
      }}
    >
      {/* Header (folds in Lifecycle's "Nd left") */}
      <header
        style={{
          padding: '14px 24px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Delivery compliance report</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
            schema {SCHEMA_VERSION} · auth {session.auth_enabled ? 'on' : 'off'} · {days}d left
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          Endpoint <span style={{ fontFamily: 'var(--mono)' }}>{short}</span>
          {hasData ? (
            <>
              {' '}
              · {rollup.passing} passing, {rollup.failing} with failures across {rollup.gradeable}{' '}
              verifiable requirements.
            </>
          ) : (
            <> · awaiting your first transmission.</>
          )}
        </div>
      </header>

      {/* Setup bar (collapsed) */}
      <div
        onClick={() => setSetupOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 24px',
          background: 'var(--surface-3)',
          borderBottom: '1px solid var(--border)',
          cursor: 'pointer',
        }}
      >
        <Icon
          name={setupOpen ? 'chevronDown' : 'chevron'}
          size={12}
          style={{ color: 'var(--text-faint)' }}
        />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Endpoint &amp; setup</span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {ingestUrl}
        </span>
        <span style={{ flex: 1 }} />
        {!hasData && (
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--accent)' }}>
            Start here →
          </span>
        )}
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          {setupOpen ? 'Collapse' : 'Expand'}
        </span>
      </div>

      {/* Setup panel (expanded) — existing Setup inside the panel chrome for now
          (108.7 rebuilds its internals + adds the Danger zone). */}
      {setupOpen && (
        <div
          style={{
            background: 'var(--surface-2)',
            borderBottom: '1px solid var(--border)',
            padding: '18px 24px',
          }}
        >
          <Setup session={session} ingestUrl={ingestUrl} onAuthChange={() => load()} />
        </div>
      )}

      {/* Scorecard strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          padding: '13px 24px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {(
          [
            { value: rollup.passing, label: 'passing', color: 'var(--pass)' },
            { value: rollup.failing, label: 'with failures', color: 'var(--fail)' },
            { value: rollup.untested, label: 'untested', color: 'var(--neutral)' },
          ] as const
        ).map((m) => (
          <div
            key={m.label}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
          >
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 26,
                fontWeight: 700,
                color: m.color,
                lineHeight: 1,
              }}
            >
              {m.value}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{m.label}</span>
          </div>
        ))}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />
        <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          <strong style={{ fontWeight: 700, color: 'var(--text)' }}>
            {rollup.gradeable} of {rollup.total}
          </strong>{' '}
          requirements are verifiable from your traffic. The rest are self-attested or need active
          testing.
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: 'var(--text-faint)',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: hasData ? 'var(--pass)' : 'var(--neutral)',
              display: 'inline-block',
            }}
          />
          {hasData ? 'live · updated just now' : 'no data yet'}
        </span>
      </div>

      {/* Two-pane body */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          gap: 16,
          padding: 16,
          background: 'var(--canvas)',
          minHeight: 0,
        }}
      >
        <CompliancePane
          summary={summary}
          selectedTx={selectedTx}
          onSelectTx={setSelectedTx}
          expandedReq={expandedReq}
          onToggleReq={setExpandedReq}
          showNonGradeable={showNonGradeable}
          onShowNonGradeableChange={setShowNonGradeable}
          collapsedGroups={collapsedGroups}
          onToggleGroup={toggleGroup}
        />
        <TransmissionsPane
          transmissions={transmissions}
          selectedTx={selectedTx}
          onSelectTx={setSelectedTx}
          onSelectReq={setExpandedReq}
        />
      </div>

      {/* deleteModalOpen + deleteConfirm are plumbed for the 108.8 delete modal.
          Referenced here (no-op) so the lifted owner state isn't dead code; the
          modal + Danger-zone trigger arrive in 108.7/108.8. */}
      {deleteModalOpen ? (
        <span
          hidden
          data-delete-confirm={deleteConfirm}
          onClick={() => {
            setDeleteModalOpen(false);
            setDeleteConfirm('');
          }}
        />
      ) : null}
    </main>
  );
}
