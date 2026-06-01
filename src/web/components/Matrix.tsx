/**
 * §7 verifiability matrix (yih.4). Renders the compliance summary as the 27-row
 * matrix with class/status badges + live counts (DESIGN.md §7, §10).
 *
 * RENDER-ONLY: this component never recomputes or reclassifies. It renders the
 * exact `status`, `classes`, and `counts` the API returns. A gradeable row with
 * zero pass+fail comes back as `status: 'untested'` and is rendered honestly as
 * "untested" — never as a pass.
 */
import type { ComplianceClass, ComplianceRow, DisplayStatus } from '../api';

export interface MatrixProps {
  /** All 27 §7 rows, in matrix order, as returned by the API. */
  summary: ComplianceRow[];
}

/** Per-class legend badge (DESIGN.md §7 legend). */
const CLASS_BADGE: Record<ComplianceClass, { glyph: string; label: string }> = {
  verified: { glyph: '✅', label: 'Passively verified' },
  heuristic: { glyph: '🟡', label: 'Heuristic / partial' },
  'active-only': { glyph: '🔌', label: 'Active-only (deferred)' },
  attestation: { glyph: '📝', label: 'Self-attestation' },
  enforced: { glyph: '🔒', label: 'Enforced by us' },
  none: { glyph: '—', label: 'Nothing to grade' },
};

/** Display-status → readable label + colors. `info` is never a grade signal. */
const STATUS_BADGE: Record<DisplayStatus, { label: string; fg: string; bg: string }> = {
  pass: { label: 'pass', fg: '#0a5c2b', bg: '#d7f5e1' },
  fail: { label: 'fail', fg: '#8a0d1f', bg: '#fbdbe0' },
  mixed: { label: 'mixed', fg: '#7a4e00', bg: '#fbeccb' },
  untested: { label: 'untested', fg: '#444', bg: '#e6e6e6' },
  'not-exercised': { label: 'not yet exercised', fg: '#3a4a6b', bg: '#dfe6f5' },
  'self-attestation': { label: 'self-attestation', fg: '#4a3a6b', bg: '#e8e0f5' },
  enforced: { label: 'enforced at edge', fg: '#1d4a4a', bg: '#d6efef' },
  'not-applicable': { label: 'n/a', fg: '#555', bg: '#ececec' },
};

const cellStyle: React.CSSProperties = {
  padding: '0.4rem 0.6rem',
  borderBottom: '1px solid rgba(128, 128, 128, 0.3)',
  textAlign: 'left',
  verticalAlign: 'top',
};

function StatusBadge({ status }: { status: DisplayStatus }) {
  const s = STATUS_BADGE[status];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.1rem 0.5rem',
        borderRadius: '999px',
        fontSize: '0.8rem',
        fontWeight: 600,
        color: s.fg,
        background: s.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

function ClassBadges({ classes }: { classes: ComplianceClass[] }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {classes.map((c) => {
        const b = CLASS_BADGE[c];
        return (
          <span key={c} title={b.label} style={{ marginRight: '0.25rem' }}>
            {b.glyph}
          </span>
        );
      })}
    </span>
  );
}

/** A single live count, dimmed when zero so non-zero counts stand out. */
function Count({ label, n, color }: { label: string; n: number; color: string }) {
  return (
    <span style={{ marginRight: '0.6rem', color, opacity: n === 0 ? 0.45 : 1 }}>
      {label} {n}
    </span>
  );
}

export function Matrix(props: MatrixProps) {
  const { summary } = props;
  return (
    <section>
      <h2>Compliance summary</h2>
      <p className="muted">
        Every requirement is classified — not just the ones we can grade. ✅ Passively verified · 🟡
        Heuristic · 🔌 Active-only (deferred) · 📝 Self-attestation · 🔒 Enforced by us · — Nothing
        to grade.
      </p>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.9rem' }}>
        <thead>
          <tr>
            <th style={{ ...cellStyle, fontWeight: 700 }}>Req</th>
            <th style={{ ...cellStyle, fontWeight: 700 }}>Summary</th>
            <th style={{ ...cellStyle, fontWeight: 700 }}>Class</th>
            <th style={{ ...cellStyle, fontWeight: 700 }}>Status</th>
            <th style={{ ...cellStyle, fontWeight: 700 }}>Findings</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((row: ComplianceRow) => (
            <tr key={row.requirement}>
              <td style={{ ...cellStyle, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                {row.requirement}
              </td>
              <td style={cellStyle}>{row.summary}</td>
              <td style={cellStyle}>
                <ClassBadges classes={row.classes} />
              </td>
              <td style={cellStyle}>
                <StatusBadge status={row.status} />
              </td>
              <td style={cellStyle}>
                <Count label="pass" n={row.counts.pass} color="#0a5c2b" />
                <Count label="fail" n={row.counts.fail} color="#8a0d1f" />
                <Count label="info" n={row.counts.info} color="#555" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
