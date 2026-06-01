/**
 * Setup view (yih.2 — Subagent D fills this in). Shows the ingest URL +
 * copy-paste curl/header examples. STUB: renders a placeholder.
 */
import type { SessionMeta } from '../api';

export interface SetupProps {
  /** Session metadata (uuid, auth flags). */
  session: SessionMeta;
  /** Relative ingest path, e.g. `/i/{uuid}`. Compose origin in the component. */
  ingestUrl: string;
}

export function Setup(_props: SetupProps) {
  return (
    <section>
      <h2>Setup</h2>
    </section>
  );
}
