/**
 * Landing route `/` (yih.1). A single "Create test endpoint" button mints a
 * session via POST /api/sessions, then navigates to `/d/{uuid}` (DESIGN §5).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { createSession } from '../api';

export function Landing() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate() {
    setCreating(true);
    setError(null);
    try {
      const { uuid } = await createSession();
      navigate(`/d/${uuid}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create endpoint');
      setCreating(false);
    }
  }

  return (
    <main className="container">
      <h1>CCE Data Delivery Validator</h1>
      <p>
        Create a throwaway test endpoint, point your transmitter at it, and see exactly which
        delivery requirements your traffic satisfies — honestly classified, nothing faked as a pass.
      </p>
      <button type="button" onClick={onCreate} disabled={creating}>
        {creating ? 'Creating…' : 'Create test endpoint'}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
