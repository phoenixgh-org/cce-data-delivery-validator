/**
 * Landing route `/` (yih.1). A single "Create test endpoint" button mints a
 * session via POST /api/sessions, then navigates to `/d/{uuid}` (DESIGN §5).
 *
 * Layout follows the redesign handoff (README §1): a single centered card on a
 * --canvas background, styled via design tokens + inline style objects.
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
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'var(--canvas)',
      }}
    >
      <main
        style={{
          maxWidth: 540,
          padding: '40px 44px',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow)',
        }}
      >
        <h1
          style={{
            fontSize: 24,
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: '-0.01em',
            color: 'var(--text)',
            margin: '0 0 4px',
          }}
        >
          CCE Data Delivery Validator
        </h1>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-muted)',
            marginBottom: 18,
          }}
        >
          Self-service compliance tool
        </div>
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.6,
            color: 'var(--text-muted)',
            margin: '0 0 16px',
          }}
        >
          Create a private test endpoint, configure your transmitter to point at it, and see which
          delivery requirements your traffic satisfies — in real time, classified plainly against
          current requirements. No signup needed.
        </p>
        <p
          style={{
            fontSize: 12.5,
            lineHeight: 1.6,
            color: 'var(--text-faint)',
            margin: '0 0 22px',
          }}
        >
          Your data is not shared with anyone (not even the maintainers of this site). Delete your
          data at any time. All endpoints and their data are automatically deleted after 7 days of
          inactivity.
        </p>
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          style={{
            background: 'var(--accent)',
            color: '#fff',
            fontWeight: 600,
            fontSize: 13.5,
            padding: '10px 18px',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: creating ? 'default' : 'pointer',
            opacity: creating ? 0.7 : 1,
          }}
        >
          {creating ? 'Creating…' : 'Create test endpoint'}
        </button>
        {error ? (
          <p className="error" style={{ marginTop: 16, marginBottom: 0 }}>
            {error}
          </p>
        ) : null}
      </main>
    </div>
  );
}
