/**
 * Dashboard route `/d/:uuid`. Fetches the session via GET /api/sessions/:uuid
 * and renders the four dashboard sections (DESIGN §10). This shell owns the
 * loading + 404 (unknown/expired uuid) states and passes each child its data
 * slice; B/C/D/E fill in the four components against the exported prop types.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { getSession, type SessionResponse } from '../api';
import { Lifecycle } from '../components/Lifecycle';
import { Matrix } from '../components/Matrix';
import { Setup } from '../components/Setup';
import { Transmissions } from '../components/Transmissions';

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

export function Dashboard() {
  const { uuid } = useParams<{ uuid: string }>();
  const [state, setState] = useState<State>({ phase: 'loading' });

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

  const { session, transmissions, summary, expiresAt } = state.data;
  const ingestUrl = `/i/${session.uuid}`;

  return (
    <main className="container">
      <h1>Validation dashboard</h1>
      <p className="muted">Endpoint {session.uuid}</p>
      <Setup session={session} ingestUrl={ingestUrl} onAuthChange={() => load()} />
      <Matrix summary={summary} />
      <Transmissions transmissions={transmissions} />
      <Lifecycle expiresAt={expiresAt} lastPostAt={session.last_post_at} />
    </main>
  );
}
