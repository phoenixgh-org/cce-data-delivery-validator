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
 * The panes are the real cards now: ComplianceCard (108.5) and TransmissionsCard
 * (108.6) consume the lifted cross-link/UI state, and Setup (108.7) is the
 * controlled bar+panel. This shell owns + plumbs that state (expandedReq,
 * selectedTx, showNonGradeable, collapsedGroups, setupOpen, the delete trigger).
 * The Danger-zone trigger flips deleteModalOpen, opening the DeleteModal (108.8);
 * its typed-confirm runs deleteSessionData + a refetch, which drops back to the
 * empty state via the auto-collapse effect.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  deleteSessionData,
  getSession,
  listTransmissions,
  type ComplianceClass,
  type ListTransmissionsResponse,
  type SessionResponse,
  type Signature,
} from '../api';
import { ComplianceCard } from '../components/ComplianceCard';
import { DeleteModal } from '../components/DeleteModal';
import { FilterBar, type WindowValue } from '../components/FilterBar';
import { Setup } from '../components/Setup';
import { TransmissionsCard } from '../components/TransmissionsCard';

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

/** Per-verifiability-class collapse map for the non-gradeable groups. */
type CollapsedGroups = Partial<Record<ComplianceClass, boolean>>;

export function Dashboard() {
  const { uuid } = useParams<{ uuid: string }>();
  const [state, setState] = useState<State>({ phase: 'loading' });

  // ---- Scope state (4h4.9). These drive the SERVER-computed scope: the summary
  // read passes {window,source}; the list read passes {window,source,failuresOnly,
  // signatureKey}. Every value here defaults to the unscoped/all view and is
  // preserved across polls (the poll re-enters the CURRENT scope, never resets).
  const [window, setWindow] = useState<WindowValue>('all');
  const [source, setSource] = useState<string>('all');
  const [selectedSignature, setSelectedSignature] = useState<Signature | null>(null);
  const [failuresOnly, setFailuresOnly] = useState(false);

  // The paginated transmission list page (a SEPARATE read from the summary). The
  // TransmissionsCard renders THESE rows (the scoped/filtered page), not the
  // summary read's full data.transmissions. Null until the first list read lands.
  const [listData, setListData] = useState<ListTransmissionsResponse | null>(null);

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
  // deleteModalOpen + deleteConfirm: owned here; consumed by the Danger-zone
  // trigger (Setup) and the DeleteModal (108.8).
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  // In-flight guard for the delete-all-data request: blocks a rapid
  // double-click (or Enter+click) from firing deleteSessionData twice, and
  // disables the modal's confirm button while the request is outstanding.
  const [deleting, setDeleting] = useState(false);

  // Refetch the session. Used by the initial-load effect, the background poll,
  // and children that mutate session state (e.g. Setup's §1.3 auth toggle). The
  // `cancelled` guard lets a caller drop a stale in-flight response on
  // unmount/uuid change. In `background` mode a transient network/5xx error is
  // swallowed — the live view is kept and the next tick retries — rather than
  // replacing healthy data with the full-screen error state; a 404 (the session
  // genuinely expired) still transitions to not-found.
  //
  // 4h4.9: this closes over the scope state (window/source/failuresOnly/
  // selectedSignature) and fires BOTH reads — the scope-aware summary AND the
  // current list page — re-entering the CURRENT scope. The phase machine stays
  // driven by the SUMMARY read; the list populates into its own state (and may
  // land slightly after). Changing any scope value re-creates this callback,
  // which re-runs the reads via the initial-load effect's `load` dependency.
  const load = useCallback(
    (cancelled?: () => boolean, opts?: { background?: boolean }) => {
      if (!uuid) {
        setState({ phase: 'not-found' });
        return;
      }
      // Summary read (drives the phase machine + scorecard + compliance pane).
      getSession(uuid, { window, source })
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
      // List read (separate; drives the TransmissionsCard page). The first page
      // always re-enters the current scope from the top (no cursor) so a poll
      // reflects newly-arrived rows. Errors are swallowed regardless of mode —
      // the summary read owns the not-found/error transitions.
      listTransmissions(uuid, {
        window,
        source,
        failuresOnly,
        signatureKey: selectedSignature?.key,
      })
        .then((result) => {
          if (cancelled?.()) return;
          if (result.ok) setListData(result.data);
        })
        .catch(() => {
          // Swallow — the summary read drives the error/not-found states.
        });
    },
    [uuid, window, source, failuresOnly, selectedSignature],
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
  // Full scoped transmissions from the SUMMARY read — feeds ComplianceCard's
  // "From transmissions" chips (a finding→tx linkage over the whole scope).
  const transmissions = data?.transmissions ?? [];
  const summary = data?.summary ?? [];
  // Scorecard numbers come from the SERVER rollup now (4h4.9 — no client
  // recompute). Zero-fallback keeps the type non-optional while not ready; the
  // scorecard/header only render in the `ready` phase where `data.rollup` exists.
  const rollup = data?.rollup ?? { total: 0, gradeable: 0, passing: 0, failing: 0, untested: 0 };
  const txCount = transmissions.length;
  // The list PAGE rows (scoped + filtered + cross-filtered) — what the
  // TransmissionsCard renders. Empty until the first list read lands.
  const listRows = listData?.transmissions ?? [];

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

  // Keep a sensible selected transmission against the FILTERED list page (4h4.9):
  // default = newest in the filtered list (list rows are newest-first, so [0] is
  // newest); if the current selection has fallen out of the filtered list, move
  // to the newest remaining row; a still-valid selection is NOT yanked on poll.
  useEffect(() => {
    const newest = listRows[0];
    if (!newest) {
      setSelectedTx(null);
      return;
    }
    setSelectedTx((cur) => (cur && listRows.some((t) => t.id === cur) ? cur : newest.id));
  }, [listRows]);

  // Cross-filter handlers (4h4.9 owns the logic; the UI triggers land in
  // 4h4.11/4h4.12). Picking a signature scopes the list AND clears the docked
  // selection so the detail follows the newly-filtered list; clearing the chip
  // returns to the full scoped list; the failures-only toggle flips the filter.
  const onSelectSignature = useCallback((sig: Signature) => {
    setSelectedSignature(sig);
    setSelectedTx(null);
  }, []);
  const onClearSignature = useCallback(() => {
    setSelectedSignature(null);
  }, []);
  const onToggleFailuresOnly = useCallback(() => {
    setFailuresOnly((v) => !v);
  }, []);

  const toggleGroup = useCallback((cls: ComplianceClass) => {
    setCollapsedGroups((prev) => ({ ...prev, [cls]: !prev[cls] }));
  }, []);

  // Dismiss the delete modal and reset the typed-confirm input.
  const closeDeleteModal = useCallback(() => {
    setDeleteModalOpen(false);
    setDeleteConfirm('');
  }, []);

  // Run the delete-all-data flow (README §Interactions — Delete). On success:
  // close the modal, clear the confirm input, and refetch. The refetch returns
  // zero transmissions, which the auto-collapse effect turns into the empty
  // state with Setup re-expanded — no extra empty-state handling here.
  const confirmDelete = useCallback(() => {
    if (!uuid || deleting) return;
    setDeleting(true);
    deleteSessionData(uuid)
      .then(() => {
        closeDeleteModal();
        load();
      })
      .catch(() => {
        // Leave the modal open so the user can retry; the next poll/refetch
        // will reconcile if the delete actually landed.
      })
      .finally(() => {
        setDeleting(false);
      });
  }, [uuid, deleting, closeDeleteModal, load]);

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

      {/* Setup — controlled collapsed bar + expanded panel (108.7). The
          auto-collapse rule below flips setupOpen; the Danger-zone trigger
          opens the 108.8 delete modal via deleteModalOpen. */}
      <Setup
        open={setupOpen}
        onToggleOpen={() => setSetupOpen((v) => !v)}
        hasData={hasData}
        session={session}
        ingestUrl={ingestUrl}
        onAuthChange={() => load()}
        onRequestDelete={() => setDeleteModalOpen(true)}
      />

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

      {/* Scoped filter strip (4h4.8) — sits between the scorecard and the panes;
          drives the server-computed scope. Presentational: Dashboard owns the
          window/source state and feeds it the summary read's sources + scope
          totals. */}
      <FilterBar
        window={window}
        source={source}
        sources={state.data.sources}
        scoped={state.data.scoped}
        onWindowChange={setWindow}
        onSourceChange={setSource}
      />

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
        <ComplianceCard
          summary={summary}
          transmissions={transmissions}
          selectedTx={selectedTx}
          onSelectTx={setSelectedTx}
          expandedReq={expandedReq}
          onToggleReq={setExpandedReq}
          showNonGradeable={showNonGradeable}
          onShowNonGradeableChange={setShowNonGradeable}
          collapsedGroups={collapsedGroups}
          onToggleGroup={toggleGroup}
          // Signature cross-filter seams — consumed by 4h4.11 (not rendered yet).
          signatures={state.data.signatures}
          onSelectSignature={onSelectSignature}
          activeSignatureKey={selectedSignature?.key ?? null}
        />
        <TransmissionsCard
          // The list renders the paginated PAGE rows (scoped/filtered), not the
          // summary read's full transmissions.
          transmissions={listRows}
          selectedTx={selectedTx}
          onSelectTx={setSelectedTx}
          onSelectReq={setExpandedReq}
          // Filter/chip/readout seams — consumed by 4h4.12 (not rendered yet).
          failuresOnly={failuresOnly}
          onToggleFailuresOnly={onToggleFailuresOnly}
          activeSignature={selectedSignature}
          onClearSignature={onClearSignature}
          visibleCount={listRows.length}
          scopedTotal={listData?.scoped ?? 0}
        />
      </div>

      {/* Delete-confirm modal (108.8). Opened by the Setup Danger-zone trigger
          (deleteModalOpen); the typed-confirm input is bound to deleteConfirm.
          confirmDelete runs deleteSessionData + refetch on success. */}
      <DeleteModal
        open={deleteModalOpen}
        count={txCount}
        value={deleteConfirm}
        onChange={setDeleteConfirm}
        onCancel={closeDeleteModal}
        onConfirm={confirmDelete}
        deleting={deleting}
      />
    </main>
  );
}
