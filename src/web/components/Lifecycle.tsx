/**
 * Lifecycle / expiry display (yih.5). Surfaces the 30-day inactivity expiry
 * clock from `expiresAt` (DESIGN.md §10, §11), framed as informational — a
 * heads-up, never a surprise. The clock is inactivity-based: it resets on each
 * new transmission, and is measured from session creation until the first POST.
 *
 * RENDER-ONLY: `expiresAt` is the ISO instant the API already computed (base +
 * 30 days, base = last_post_at ?? created_at). This component does not refetch
 * or recompute that base — it only derives an absolute date + relative
 * "expires in N days" against `Date.now()` for display.
 */

const MS_PER_DAY = 86_400_000;

export interface LifecycleProps {
  /** ISO timestamp string when the session expires. */
  expiresAt: string;
  /** ISO timestamp string of the last POST, or null when none yet. */
  lastPostAt: string | null;
}

/** Human relative phrase from the days remaining (negative ⇒ already expired). */
function relativeLabel(daysRemaining: number): string {
  if (daysRemaining <= 0) return 'expired';
  if (daysRemaining === 1) return 'expires in 1 day';
  return `expires in ${daysRemaining} days`;
}

export function Lifecycle(props: LifecycleProps) {
  const { expiresAt, lastPostAt } = props;

  const expires = new Date(expiresAt);
  const absolute = expires.toLocaleString();
  // ceil so "11.4 days left" reads as "expires in 12 days" — round in the
  // user's favor; a sub-day remainder still reads as 1 day, not 0.
  const daysRemaining = Math.ceil((expires.getTime() - Date.now()) / MS_PER_DAY);
  const expired = daysRemaining <= 0;
  const relative = relativeLabel(daysRemaining);

  return (
    <section>
      <h2>Lifecycle</h2>
      <p className="muted">
        Inactive test endpoints are purged after 30 days. This is a heads-up, not something you need
        to act on — the clock resets every time you POST a transmission.
      </p>
      <p>
        <span
          style={{
            display: 'inline-block',
            padding: '0.1rem 0.5rem',
            borderRadius: '999px',
            fontSize: '0.85rem',
            fontWeight: 600,
            color: expired ? '#8a0d1f' : '#3a4a6b',
            background: expired ? '#fbdbe0' : '#dfe6f5',
            whiteSpace: 'nowrap',
          }}
        >
          {relative}
        </span>{' '}
        <span style={{ marginLeft: '0.4rem' }}>
          {expired ? 'expired on' : 'expires'} {absolute}
        </span>
      </p>
      {lastPostAt === null && (
        <p className="muted">
          No transmissions yet — expiry is measured from when this endpoint was created. It resets
          each time you POST.
        </p>
      )}
    </section>
  );
}
