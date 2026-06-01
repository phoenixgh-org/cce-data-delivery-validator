/**
 * Dashboard route `/d/:uuid`. Fetches the session via GET /api/sessions/:uuid
 * and renders the four dashboard sections (DESIGN §10). This shell owns the
 * loading + 404 (unknown/expired uuid) states and passes each child its data
 * slice; B/C/D/E fill in the four components against the exported prop types.
 */
import { useEffect, useState } from 'react';
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

export function Dashboard() {
  const { uuid } = useParams<{ uuid: string }>();
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    if (!uuid) {
      setState({ phase: 'not-found' });
      return;
    }
    let cancelled = false;
    setState({ phase: 'loading' });
    getSession(uuid)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setState({ phase: 'ready', data: result.data });
        else setState({ phase: 'not-found' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Failed to load session',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [uuid]);

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
        <p>This test endpoint does not exist, or it expired after 30 days of inactivity.</p>
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
      <Setup session={session} ingestUrl={ingestUrl} />
      <Matrix summary={summary} />
      <Transmissions transmissions={transmissions} />
      <Lifecycle expiresAt={expiresAt} lastPostAt={session.last_post_at} />
    </main>
  );
}
