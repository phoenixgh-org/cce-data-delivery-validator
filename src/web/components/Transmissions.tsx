/**
 * Transmissions list + drill-down (yih.3 — Subagent C fills this in).
 * Reverse-chron list (API already returns DESC); drill into a transmission for
 * raw body, returned status, and per-tx findings with JSON Pointers. STUB:
 * renders a placeholder.
 */
import type { TransmissionView } from '../api';

export interface TransmissionsProps {
  /** Transmissions, newest-first (the API returns them DESC). */
  transmissions: TransmissionView[];
}

export function Transmissions(_props: TransmissionsProps) {
  return (
    <section>
      <h2>Transmissions</h2>
    </section>
  );
}
