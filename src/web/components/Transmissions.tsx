/**
 * Transmissions list + drill-down (yih.3). Reverse-chron list (the API returns
 * them DESC, so we render in the given order without re-sorting); drill into a
 * transmission for raw body, returned status, and per-tx findings with JSON
 * Pointers (DESIGN §10). Pure presentational + local expand/collapse state.
 */
import { type ReactNode, useState } from 'react';

import type { FindingView, Severity, TransmissionView } from '../api';

export interface TransmissionsProps {
  /** Transmissions, newest-first (the API returns them DESC). */
  transmissions: TransmissionView[];
}

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Severity badge colors (DESIGN §8 severities). */
const SEVERITY_COLOR: Record<Severity, string> = {
  pass: '#1b7f37',
  fail: '#b00020',
  info: '#555',
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.05rem 0.45rem',
        borderRadius: 4,
        fontSize: '0.75rem',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        border: `1px solid ${SEVERITY_COLOR[severity]}`,
        color: SEVERITY_COLOR[severity],
      }}
    >
      {severity}
    </span>
  );
}

/** A small label/value pair for the drill-down metadata grid. */
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <span className="muted">{label}</span>
      <div style={{ fontFamily: mono, fontSize: '0.85rem', wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

function flag(value: boolean | null): string {
  if (value === null) return '—';
  return value ? 'yes' : 'no';
}

function FindingItem({ finding }: { finding: FindingView }) {
  return (
    <li style={{ margin: '0.5rem 0', listStyle: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <SeverityBadge severity={finding.severity} />
        <span style={{ fontFamily: mono, fontSize: '0.85rem' }}>{finding.requirement}</span>
      </div>
      {finding.detail !== null && (
        <div style={{ fontSize: '0.85rem', margin: '0.15rem 0' }}>{finding.detail}</div>
      )}
      {finding.pointer !== null && (
        <div className="muted">
          pointer: <code style={{ fontFamily: mono }}>{finding.pointer}</code>
        </div>
      )}
    </li>
  );
}

function TransmissionRow({ tx }: { tx: TransmissionView }) {
  const [open, setOpen] = useState(false);
  const findingCount = tx.findings.length;

  return (
    <li style={{ border: '1px solid currentColor', borderRadius: 6, marginBottom: '0.75rem' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%',
          textAlign: 'left',
          border: 'none',
          borderRadius: 6,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.75rem',
        }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span style={{ fontFamily: mono, fontSize: '0.85rem' }}>{tx.received_at}</span>
        <span>HTTP {tx.http_status ?? '—'}</span>
        <span className="muted">{tx.content_type ?? 'no content-type'}</span>
        <span className="muted">{tx.wire_bytes ?? '—'} bytes</span>
        <span>parse {flag(tx.parse_ok)}</span>
        <span>schema {flag(tx.schema_ok)}</span>
        <span>
          {findingCount} finding{findingCount === 1 ? '' : 's'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 1rem 1rem' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
              gap: '0.75rem',
              margin: '0.5rem 0 1rem',
            }}
          >
            <Field label="http_status" value={tx.http_status ?? '—'} />
            <Field label="content_type" value={tx.content_type ?? '—'} />
            <Field label="content_encoding" value={tx.content_encoding ?? '—'} />
            <Field label="wire_bytes" value={tx.wire_bytes ?? '—'} />
            <Field label="parse_ok" value={flag(tx.parse_ok)} />
            <Field label="schema_ok" value={flag(tx.schema_ok)} />
            <Field label="schema_version" value={tx.schema_version ?? '—'} />
            <Field label="transfer_id" value={tx.transfer_id ?? '—'} />
          </div>

          <h4 style={{ margin: '0.5rem 0 0.25rem' }}>Findings</h4>
          {findingCount === 0 ? (
            <p className="muted">No findings for this transmission.</p>
          ) : (
            <ul style={{ padding: 0, margin: 0 }}>
              {tx.findings.map((finding, i) => (
                <FindingItem key={i} finding={finding} />
              ))}
            </ul>
          )}

          <h4 style={{ margin: '1rem 0 0.25rem' }}>Parsed body</h4>
          <pre
            style={{
              fontFamily: mono,
              fontSize: '0.8rem',
              overflowX: 'auto',
              padding: '0.75rem',
              border: '1px solid currentColor',
              borderRadius: 6,
              margin: 0,
            }}
          >
            {tx.body == null ? '(no parsed body)' : JSON.stringify(tx.body, null, 2)}
          </pre>

          <h4 style={{ margin: '1rem 0 0.25rem' }}>Raw body</h4>
          {tx.raw_body === null ? (
            <p className="muted">Raw body not retained for this transmission.</p>
          ) : (
            <pre
              style={{
                fontFamily: mono,
                fontSize: '0.8rem',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                padding: '0.75rem',
                border: '1px solid currentColor',
                borderRadius: 6,
                margin: 0,
              }}
            >
              {tx.raw_body}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

export function Transmissions(props: TransmissionsProps) {
  const { transmissions } = props;

  return (
    <section>
      <h2>Transmissions</h2>
      {transmissions.length === 0 ? (
        <p className="muted">No transmissions yet — POST to your ingest URL to see results here.</p>
      ) : (
        <ul style={{ padding: 0, margin: 0, listStyle: 'none' }}>
          {transmissions.map((tx) => (
            <TransmissionRow key={tx.id} tx={tx} />
          ))}
        </ul>
      )}
    </section>
  );
}
