/**
 * §7 verifiability matrix (yih.4 — Subagent B fills this in). Renders the
 * compliance summary as the 27-row matrix with class/status badges + live
 * counts. Render-only; never recompute status. STUB: renders a placeholder.
 */
import type { ComplianceRow } from '../api';

export interface MatrixProps {
  /** All 27 §7 rows, in matrix order, as returned by the API. */
  summary: ComplianceRow[];
}

export function Matrix(_props: MatrixProps) {
  return (
    <section>
      <h2>Compliance summary</h2>
    </section>
  );
}
