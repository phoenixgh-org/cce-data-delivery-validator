/**
 * Lifecycle / expiry display (yih.5 — Subagent E fills this in). Surfaces the
 * 30-day inactivity expiry clock from `expiresAt` (DESIGN §11), framed as
 * informational. STUB: renders a placeholder.
 */

export interface LifecycleProps {
  /** ISO timestamp string when the session expires. */
  expiresAt: string;
  /** ISO timestamp string of the last POST, or null when none yet. */
  lastPostAt: string | null;
}

export function Lifecycle(_props: LifecycleProps) {
  return (
    <section>
      <h2>Lifecycle</h2>
    </section>
  );
}
