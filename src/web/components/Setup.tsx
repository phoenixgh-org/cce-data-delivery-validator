/**
 * Setup view (yih.2). Shows the absolute ingest URL plus copy-paste `curl` and
 * header examples so a supplier can point a transmitter at the endpoint
 * (DESIGN §5 onboarding, §10 Setup). Also hosts the §1.3 auth opt-in toggle:
 * enabling generates a credential and shows a copy-paste config snippet ONCE
 * (DESIGN §10, §12 — the secret is never echoed again).
 *
 * The ingest URL is a bearer capability URL, so it is shown plainly for the
 * holder to copy and use.
 */
import { useState } from 'react';

import { disableAuth, enableAuth, type EnableAuthResponse, type SessionMeta } from '../api';

export interface SetupProps {
  /** Session metadata (uuid, auth flags). */
  session: SessionMeta;
  /** Relative ingest path, e.g. `/i/{uuid}`. Compose origin in the component. */
  ingestUrl: string;
  /** Refetch the session so the dashboard reflects the new auth state. */
  onAuthChange: () => void;
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

/**
 * Auth opt-in section (DESIGN §1.3 / §10). Renders a toggle reflecting the
 * persisted `auth_enabled`/`auth_method` (a reload shows the enabled state
 * without the secret), and on enable shows the show-once credential + a
 * copy-paste config snippet.
 */
function AuthOptIn({
  session,
  absoluteIngestUrl,
  contentType,
  onAuthChange,
}: {
  session: SessionMeta;
  absoluteIngestUrl: string;
  contentType: string;
  onAuthChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The show-once credential, held only in local state for this render. Cleared
  // on disable; lost on reload (the server never echoes it again — §12).
  const [credential, setCredential] = useState<EnableAuthResponse | null>(null);

  async function onEnable() {
    setBusy(true);
    setError(null);
    try {
      // Empty body → service defaults to the `header` method (zero-config opt-in).
      const result = await enableAuth(session.uuid);
      setCredential(result);
      onAuthChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable auth');
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setBusy(true);
    setError(null);
    try {
      await disableAuth(session.uuid);
      setCredential(null);
      onAuthChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable auth');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Authentication (optional)</h3>
      <p className="muted">
        §1.3 auth is opt-in. By default the ingest URL is unauthenticated. Enable auth to require a
        credential on every POST — the validator then grades §1.3 from real traffic.
      </p>

      <div style={rowStyle}>
        {session.auth_enabled ? (
          <button type="button" onClick={onDisable} disabled={busy}>
            {busy ? 'Working…' : 'Disable authentication'}
          </button>
        ) : (
          <button type="button" onClick={onEnable} disabled={busy}>
            {busy ? 'Working…' : 'Enable authentication'}
          </button>
        )}
        {session.auth_enabled && (
          <span className="muted">
            Enabled
            {session.auth_method ? ` (${session.auth_method})` : ''}
          </span>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {/* Reflect a previously-enabled state on reload: the secret is gone, but we
          tell the holder how to rotate it. */}
      {session.auth_enabled && !credential && (
        <p className="muted">
          A credential is active for this endpoint. The secret is shown only once at creation; if
          you have lost it, enabling again rotates to a fresh credential.
        </p>
      )}

      {credential && (
        <AuthCredential
          credential={credential}
          absoluteIngestUrl={absoluteIngestUrl}
          contentType={contentType}
        />
      )}
    </>
  );
}

/** Show-once credential display + copy-paste config snippet (DESIGN §10/§12). */
function AuthCredential({
  credential,
  absoluteIngestUrl,
  contentType,
}: {
  credential: EnableAuthResponse;
  absoluteIngestUrl: string;
  contentType: string;
}) {
  const snippet =
    credential.auth_method === 'header'
      ? [
          `curl -X POST '${absoluteIngestUrl}' \\`,
          `  -H 'Content-Type: ${contentType}' \\`,
          `  -H '${credential.auth_header_name}: ${credential.token}' \\`,
          `  -d '${SAMPLE_BODY}'`,
        ].join('\n')
      : [
          `curl -X POST '${absoluteIngestUrl}' \\`,
          `  -H 'Content-Type: ${contentType}' \\`,
          `  -u '${credential.username}:${credential.password}' \\`,
          `  -d '${SAMPLE_BODY}'`,
        ].join('\n');

  const secret = credential.auth_method === 'header' ? credential.token : credential.password;

  return (
    <div style={warnBlockStyle}>
      <p>
        <strong>Save this credential now — you will not see it again.</strong> The validator stores
        only a salted hash (§12). To rotate, enable authentication again.
      </p>

      {credential.auth_method === 'header' ? (
        <>
          <h4>Token header</h4>
          <div style={rowStyle}>
            <code style={codeInlineStyle}>
              {credential.auth_header_name}: {credential.token}
            </code>
            <CopyButton
              text={`${credential.auth_header_name}: ${credential.token}`}
              label="token header"
            />
          </div>
        </>
      ) : (
        <>
          <h4>Basic credentials</h4>
          <div style={rowStyle}>
            <code style={codeInlineStyle}>
              {credential.username}:{credential.password}
            </code>
            <CopyButton
              text={`${credential.username}:${credential.password}`}
              label="basic credentials"
            />
          </div>
        </>
      )}
      <div style={rowStyle}>
        <CopyButton text={secret} label="secret" />
        <span className="muted">Copy just the secret</span>
      </div>

      <h4>Example request (curl)</h4>
      <div style={rowStyle}>
        <pre style={blockStyle}>
          <code>{snippet}</code>
        </pre>
        <CopyButton text={snippet} label="authenticated curl example" />
      </div>
    </div>
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

      <AuthOptIn
        session={props.session}
        absoluteIngestUrl={absoluteIngestUrl}
        contentType={contentType}
        onAuthChange={props.onAuthChange}
      />
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

const warnBlockStyle: React.CSSProperties = {
  marginTop: '0.75rem',
  padding: '0.75rem 1rem',
  border: '1px solid currentColor',
  borderRadius: '6px',
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
