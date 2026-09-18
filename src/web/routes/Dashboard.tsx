/**
 * Dashboard route `/d/:uuid`. Fetches the session via GET /api/sessions/:uuid
 * and renders the redesigned two-pane shell (README §Screens 2): header →
 * collapsible Setup bar/panel → summary cards → [ComplianceCard |
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
 *
 * The header is one line now (vamh.1): ReportHeader carries the title and the two
 * scope controls, which used to sit in a FilterBar strip below the scorecard. That
 * component is gone, along with the header's endpoint sentence, the pass-rate
 * sparkline and the "live · updated just now" dot. The scope state and the `load`
 * callback did not move — only where the controls are rendered.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  deleteSessionData,
  getSession,
  listTransmissions,
  type ComplianceClass,
  type ListTransmissionsResponse,
  type SessionResponse,
  type Signature,
  type TransmissionView,
} from '../api';
import { ComplianceCard } from '../components/ComplianceCard';
import { DeleteModal } from '../components/DeleteModal';
import { ReadinessStrip } from '../components/ReadinessStrip';
import { ReportHeader, type WindowValue } from '../components/ReportHeader';
import { Setup } from '../components/Setup';
import { SummaryCards } from '../components/SummaryCards';
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
  //
  // 4h4.13: `listData` always holds the PAGE-1 anchor (its `scoped` is the
  // post-filter denominator). The rows the card renders are ACCUMULATED across
  // cursor pages in `accumulatedRows`; `listCursor` is the cursor for the NEXT
  // page (null at the end). A scope/filter change or poll re-anchors: it
  // REPLACES the accumulated rows with page 1 and resets the cursor. Only a
  // scroll-to-end load-more appends an additional page.
  const [listData, setListData] = useState<ListTransmissionsResponse | null>(null);
  const [accumulatedRows, setAccumulatedRows] = useState<TransmissionView[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Guards a load-more append against a concurrent re-anchor (scope change /
  // poll): each re-anchor bumps this token, and an in-flight append drops its
  // result if the token moved while it was outstanding (stale-scope page).
  const listAnchorRef = useRef(0);

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
      // Summary read (drives the phase machine + summary cards + compliance pane).
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
      // reflects newly-arrived rows. This RE-ANCHORS (4h4.13): it REPLACES the
      // accumulated rows with page 1 and resets the cursor, and bumps the anchor
      // token so any in-flight load-more append (older scope) is discarded.
      // Errors are swallowed regardless of mode — the summary read owns the
      // not-found/error transitions.
      const anchorToken = (listAnchorRef.current += 1);
      listTransmissions(uuid, {
        window,
        source,
        failuresOnly,
        signatureKey: selectedSignature?.key,
      })
        .then((result) => {
          if (cancelled?.()) return;
          // A newer re-anchor superseded this read while it was outstanding —
          // drop it so the stale page-1 doesn't clobber the current scope.
          if (listAnchorRef.current !== anchorToken) return;
          if (result.ok) {
            setListData(result.data);
            setAccumulatedRows(result.data.transmissions);
            setListCursor(result.data.nextCursor);
            setIsLoadingMore(false);
          }
        })
        .catch(() => {
          // Swallow — the summary read drives the error/not-found states.
        });
    },
    [uuid, window, source, failuresOnly, selectedSignature],
  );

  // Full-screen loading RESET is keyed on `uuid` ONLY (3ta). Post-4h4.9 `load`
  // is recreated on any scope/filter change, so keying the loading reset on
  // `[load]` blanked the ENTIRE dashboard (header, summary cards, both panes) to
  // "Loading…" for a round-trip on every toggle. Resetting on `uuid` means only
  // a genuine session switch (or mount) drops to the loading screen; a
  // scope/filter change refetches IN PLACE via the `[load]` effect below,
  // keeping the ready render (and the scope the user just picked in the
  // header's window/source controls).
  useEffect(() => {
    setState({ phase: 'loading' });
  }, [uuid]);

  // The fetch itself is keyed on `load` so scope/filter changes re-run BOTH
  // reads — but WITHOUT touching the phase, so the ready render survives the
  // round-trip. On mount/uuid change this fires alongside the reset above.
  useEffect(() => {
    let cancelled = false;
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
  // The requirements card's numbers come from the SERVER rollup (4h4.9 — no
  // client recompute). Zero-fallback keeps the type non-optional while not
  // ready; the cards only render in the `ready` phase, where `data.rollup`
  // exists.
  const rollup = data?.rollup ?? { total: 0, gradeable: 0, passing: 0, failing: 0, untested: 0 };
  const txCount = transmissions.length;
  // The list rows (scoped + filtered + cross-filtered) the TransmissionsCard
  // renders — ACCUMULATED across cursor pages (4h4.13). Page 1 is newest-first
  // and re-anchored on every scope change/poll; load-more appends OLDER rows at
  // the END, so newest stays row[0] and a kept selection never jumps. Empty
  // until the first list read lands.
  const listRows = accumulatedRows;

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

  // Infinite-scroll page fetch (4h4.13). Raised by the TransmissionsCard when
  // the virtualized list nears its end. Fetches the NEXT cursor page in the
  // CURRENT scope and APPENDS its (older) rows — it does NOT re-anchor. Guards:
  // no uuid, no remaining cursor, or an append already in flight short-circuit.
  // The anchor token captured at fire time is re-checked on resolve so a
  // scope/filter change or poll that re-anchored mid-flight discards this stale
  // page rather than appending it to a different scope.
  const onLoadMore = useCallback(() => {
    if (!uuid || listCursor === null || isLoadingMore) return;
    const anchorToken = listAnchorRef.current;
    setIsLoadingMore(true);
    listTransmissions(uuid, {
      window,
      source,
      failuresOnly,
      signatureKey: selectedSignature?.key,
      cursor: listCursor,
    })
      .then((result) => {
        if (listAnchorRef.current !== anchorToken) return;
        if (result.ok) {
          setAccumulatedRows((prev) => [...prev, ...result.data.transmissions]);
          setListCursor(result.data.nextCursor);
        }
      })
      .catch(() => {
        // Swallow — the next poll re-anchors page 1; the user can retry scroll.
      })
      .finally(() => {
        if (listAnchorRef.current === anchorToken) setIsLoadingMore(false);
      });
  }, [uuid, listCursor, isLoadingMore, window, source, failuresOnly, selectedSignature]);

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

  const { session, expiresAt, schemas } = state.data;
  const ingestUrl = `/i/${session.uuid}`;
  const hasData = txCount > 0;

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--canvas)',
      }}
    >
      {/* Header (vamh.1) — one line: the title left, the window and source
          controls at the right end. Presentational; the scope state stays here. */}
      <ReportHeader
        window={window}
        source={source}
        sources={state.data.sources}
        onWindowChange={setWindow}
        onSourceChange={setSource}
      />

      {/* Setup — controlled collapsed bar + expanded panel (108.7). The
          auto-collapse rule below flips setupOpen; the Danger-zone trigger
          opens the 108.8 delete modal via deleteModalOpen. */}
      <Setup
        open={setupOpen}
        onToggleOpen={() => setSetupOpen((v) => !v)}
        hasData={hasData}
        session={session}
        ingestUrl={ingestUrl}
        schemas={schemas}
        expiresAt={expiresAt}
        onAuthChange={() => load()}
        onRequestDelete={() => setDeleteModalOpen(true)}
      />

      {/* Summary cards (vamh.3) — the scorecard strip's headline row, split into
          one card per column so each set of numbers sits above the pane whose
          noun it counts. The cards own their gutter and gap, matched to the
          two-pane body below so their edges land on the pane edges; everything
          they render comes from the SERVER rollup and scope totals. */}
      <SummaryCards rollup={rollup} scoped={state.data.scoped} />

      {/* DS01.3 readiness strip (by1c.13) — how much of the scope's
          contract-passing traffic would still pass under the shadow lineage, and
          the shadow signatures standing in the way. It keeps its place directly
          under the summary cards, now on the canvas rather than inside the
          retired strip's bordered surface; it brings its own inset chrome and
          hides itself when there is no shadow lineage, no readiness, or no
          contract-passing traffic — hence the wrapper carrying the gutter and
          nothing else, so a hidden strip leaves no empty band behind. NOT gated
          on failuresOnly: readiness is computed over the scoped set alone, so
          the list filter must not move these numbers. `readiness` is never
          undefined here — the first-load phase renders a whole-page "Loading…"
          above, so the strip's skeleton variant is prop-driven and covered by
          its test rather than reached on load. */}
      <div style={{ padding: '0 16px' }}>
        <ReadinessStrip
          readiness={state.data.readiness}
          shadowProfile={session.shadowProfile}
          activeSignatureKey={selectedSignature?.key ?? null}
          onSelectSignature={onSelectSignature}
        />
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
          // Signature cross-filter seams. `signatures` carries BOTH halves: the
          // issue signatures the requirement rows group, and the advisory ones
          // (kind 'advisory') the card's own Advisories section renders (agj.16).
          // onSelectSignature sets the list filter and nothing else — in
          // particular it never touches failuresOnly, which would hide an
          // advisory-only transmission from its own cross-filter.
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
          // Infinite-scroll seam (4h4.13): the card raises onLoadMore near the
          // list end; hasMore reflects whether a next cursor page exists.
          onLoadMore={onLoadMore}
          hasMore={listCursor !== null}
          isLoadingMore={isLoadingMore}
          // Shadow lineage (by1c.12): null hides the DS01.3 verdict column and
          // the row's second dot. Served, not derived from the findings.
          shadowProfile={session.shadowProfile}
          // The docked detail's shadow rows (by1c.14) name their defect from the
          // matching signature and cross-filter the list by its key — the same
          // array and the same handler the compliance column uses.
          signatures={state.data.signatures}
          onSelectSignature={onSelectSignature}
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
