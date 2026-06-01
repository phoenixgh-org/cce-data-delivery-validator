/**
 * Setup view (yih.2). Shows the absolute ingest URL plus copy-paste `curl` and
 * header examples so a supplier can point a transmitter at the endpoint
 * (DESIGN §5 onboarding, §10 Setup). Pure presentational + local clipboard UI
 * state — no fetching. The ingest URL is a bearer capability URL, so it is
 * shown plainly for the holder to copy and use.
 *
 * Scope note: the §1.3 auth opt-in toggle (DESIGN §10) is deferred to M6 and is
 * deliberately NOT rendered here.
 */
import { useState } from 'react';

import type { SessionMeta } from '../api';

export interface SetupProps {
  /** Session metadata (uuid, auth flags). */
  session: SessionMeta;
  /** Relative ingest path, e.g. `/i/{uuid}`. Compose origin in the component. */
  ingestUrl: string;
}

/** A small JSON body suppliers can adapt — keeps the curl one realistic. */
const SAMPLE_BODY = '{"schemaVersion":"0.8.0","transferId":"demo-001","records":[]}';

/** Reusable copy button with a transient "Copied!" affordance. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); fail quietly —
      // the text remains visible for manual selection.
      setCopied(false);
    }
  }

  return (
    <button type="button" onClick={onCopy} aria-label={`Copy ${label}`}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export function Setup(props: SetupProps) {
  // The API returns ingestUrl as a relative path (`/i/{uuid}`); the SPA composes
  // the origin so suppliers get a fully-qualified, runnable URL.
  const absoluteIngestUrl = `${window.location.origin}${props.ingestUrl}`;

  const contentType = 'application/json; charset=utf-8';

  const curlExample = [
    `curl -X POST '${absoluteIngestUrl}' \\`,
    `  -H 'Content-Type: ${contentType}' \\`,
    `  -d '${SAMPLE_BODY}'`,
  ].join('\n');

  return (
    <section>
      <h2>Setup</h2>
      <p>
        Point your transmitter at the ingest URL below, then POST a JSON transmission. Results
        appear in the dashboard as data arrives. The URL is a bearer capability — anyone holding it
        can POST and view, so treat it like a secret.
      </p>

      <h3>Ingest URL</h3>
      <div style={rowStyle}>
        <code style={codeInlineStyle}>{absoluteIngestUrl}</code>
        <CopyButton text={absoluteIngestUrl} label="ingest URL" />
      </div>

      <h3>Headers</h3>
      <p>Send these request headers:</p>
      <pre style={blockStyle}>
        <code>{`Content-Type: ${contentType}`}</code>
      </pre>
      <p className="muted">
        Gzip is supported: add <code>Content-Encoding: gzip</code> and send the gzipped body (do not
        double-encode, e.g. base64 over gzip) — §1.6.
      </p>

      <h3>Example request (curl)</h3>
      <div style={rowStyle}>
        <pre style={blockStyle}>
          <code>{curlExample}</code>
        </pre>
        <CopyButton text={curlExample} label="curl example" />
      </div>
    </section>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.5rem',
  flexWrap: 'wrap',
};

const blockStyle: React.CSSProperties = {
  flex: '1 1 20rem',
  margin: 0,
  padding: '0.75rem 1rem',
  border: '1px solid currentColor',
  borderRadius: '6px',
  overflowX: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.85rem',
};

const codeInlineStyle: React.CSSProperties = {
  flex: '1 1 20rem',
  padding: '0.5rem 0.75rem',
  border: '1px solid currentColor',
  borderRadius: '6px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.85rem',
  wordBreak: 'break-all',
};
