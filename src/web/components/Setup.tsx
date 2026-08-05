/**
 * Setup (108.7) — a CONTROLLED collapsed bar + expanded two-column panel
 * (redesign README §2 "Setup bar / Setup panel"). The bar (chevron + "Endpoint
 * & setup" + truncated ingest URL + "Start here →" when the endpoint has no
 * data yet + Expand/Collapse) toggles the panel. The panel's LEFT column hosts
 * the onboarding copy fields (ingest URL, headers, gzip §1.6, curl example);
 * the RIGHT column hosts the §1.3 auth opt-in card, the schema & lifecycle line,
 * and the Danger zone trigger.
 *
 * The ingest URL is a bearer capability URL, so it is shown plainly for the
 * holder to copy and use (DESIGN §5 onboarding, §10 Setup).
 *
 * Open/close is controlled when `open`/`onToggleOpen` are supplied (the
 * Dashboard lifts that state to drive the auto-collapse rule); otherwise the
 * component falls back to its own state so the existing call site still works.
 *
 * Auth opt-in (§1.3 / §10 / §12) is preserved verbatim: enabling generates a
 * credential and shows a copy-paste snippet ONCE, the enabled state reflects on
 * reload (without the secret), and disable/rotate reuse the same client calls.
 * The supplier picks WHICH of the three DS01.3 methods to enable (5bs.4/dav) —
 * before, the panel silently took the service's `header` default.
 */
import { Fragment, useState, type CSSProperties } from 'react';

import {
  disableAuth,
  enableAuth,
  type AuthMethod,
  type EnableAuthResponse,
  type SchemaProvenance,
  type SessionMeta,
} from '../api';
import { Icon } from './ui/Icon';
import { SyntheticDataNotice } from './ui/SyntheticDataNotice';

export interface SetupProps {
  /** Session metadata (uuid, auth flags). */
  session: SessionMeta;
  /** Relative ingest path, e.g. `/i/{uuid}`. Compose origin in the component. */
  ingestUrl: string;
  /**
   * The registered schema set, straight off the API (GET /api/sessions/:uuid).
   * The "Schema & lifecycle" line renders it; it must never be restated as a
   * literal here, which is how a fabricated hash once shipped (beads 3cq).
   */
  schemas: SchemaProvenance[];
  /** Refetch the session so the dashboard reflects the new auth state. */
  onAuthChange: () => void;
  /** Controlled open state. When omitted, the component manages its own. */
  open?: boolean;
  /** Toggle handler. When omitted, the component toggles its internal state. */
  onToggleOpen?: () => void;
  /** Whether the endpoint has captured any data yet (drives "Start here →"). */
  hasData?: boolean;
  /** Open the delete-confirm flow. The modal itself lives elsewhere (108.8). */
  onRequestDelete?: () => void;
}

/**
 * The smallest cce-interop transmission that actually earns a 200 — a runnable
 * request, not a shape sketch. An earlier version rendered
 * `{"schemaVersion":…,"transferId":"demo-001","records":[]}`, which the service
 * never accepts: schemaVersion/transferId live under `meta`, there is no root
 * `records`, and `data` has minItems 1 — so the panel handed a first-run
 * supplier a guaranteed 422 (beads auu).
 *
 * Every field here is REQUIRED by the schema at 0.8.1: `meta` carries the five
 * `transmission-metadata` fields, and the one `rtmd-report` carries AMID, CID,
 * DLST (which itself requires a TVC sensor), EDOP, EMFR, EMOD, EPQS, ESER and a
 * `records` array whose entries require ABST, ALRM, BEMD, EERR. EMSV rides on
 * the report because `rtmd-report`'s oneOf demands it in EXACTLY one place —
 * the report or every record, never both. `transferType` is `rtm` because the
 * RTMD report is the shorter of the two arms. TVC is required too, just not via
 * `required`: `rtmd-record` carries an `anyOf` demanding one of TVC / TFRZ /
 * TAMB on every record, and TVC is the arm chosen — a temperature sample with no
 * temperature is not a record the service accepts. Same shape as the README
 * quick-start.
 *
 * `schemaVersion` comes from the server-reported `schemas`, never a literal: a
 * hardcoded version would keep the copy-paste sample earning a 200 only until
 * the registry moved off it, and then hand a first-run supplier the 422 the
 * "Schema & lifecycle" line one column right already contradicts. `schemas` is
 * ordered oldest-first (SchemaRegistry.provenance()), so the last entry is the
 * newest registered version — the one ingest grades as current.
 *
 * With no registered version there is nothing truthful to name, so the field is
 * omitted rather than guessed (same rule as the provenance line, beads 3cq).
 * Cannot happen with the current registry — load() seeds it.
 *
 * Rendered multi-line for readability: the callers embed it in a shell snippet
 * as `-d '<body>'`, so it must stay free of single quotes (it is).
 *
 * Exported only so Setup.test.ts can hold both claims to account — that the body
 * still validates against the newest registered schema, and that it carries no
 * single quote. Twice now the sample drifted into a guaranteed 422 (beads 48h,
 * auu) and both times only a manual audit caught it (beads lg8).
 */
export function sampleBody(schemas: SchemaProvenance[]): string {
  const version = schemas.at(-1)?.version;
  const schemaLine = version === undefined ? '' : `\n    "schemaVersion": "${version}",`;
  return `{
  "meta": {${schemaLine}
    "transferType": "rtm",
    "transferId": "demo-001",
    "transferSrc": "com.example.demo",
    "transferredAt": "2026-01-15T04:06:00Z"
  },
  "data": [
    {
      "AMID": "demo-appliance-001",
      "CID": "US",
      "EDOP": "2024-01-01",
      "EMFR": "Demo Monitoring Ltd",
      "EMOD": "DEMO-100",
      "EPQS": "E006/999",
      "ESER": "demo-emd-001",
      "EMSV": "v01.02.123",
      "DLST": { "TVC": { "SID": "demo-sensor-1", "SMFR": "Demo Sensors", "SMOD": "DS-1" } },
      "records": [
        { "ABST": "20260115T040600Z", "ALRM": null, "BEMD": 100, "EERR": null, "TVC": 4.2 }
      ]
    }
  ]
}`;
}

const CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Leading hex chars of a sha256 shown in the provenance line — enough to check
 * against the published artifact at a glance. The full 64 are in the API
 * response (and the service's boot log) for anyone verifying properly.
 */
const SHA256_PREFIX_CHARS = 8;

/** `290290fd…` — a sha256 abbreviated for display only, never for comparison. */
function shortSha(sha256: string): string {
  return `${sha256.slice(0, SHA256_PREFIX_CHARS)}…`;
}

/**
 * The three §1.3 / DS01.3 clause 5.1.5 authentication methods, as the picker
 * offers them. `label` is the segmented-control face, `blurb` the one-line
 * explanation under it, `name` the prose form used in the enabled-state summary
 * and the "switch method" button.
 *
 * `header` and `bearer` are DELIBERATELY separate entries: the first is the 2025
 * requirement's token-in-a-configurable-header method (no scheme prefix), the
 * second the RFC 6750 scheme DS01.3 adds. Collapsing them is the conflation
 * 5bs.5 removed from the requirement text.
 */
interface AuthMethodOption {
  v: AuthMethod;
  label: string;
  name: string;
  blurb: string;
}

/** The service's own default, and this picker's fallback for an unknown method. */
const HEADER_METHOD_OPTION: AuthMethodOption = {
  v: 'header',
  label: 'Token header',
  name: 'token header',
  blurb: 'Access token in a configurable header (X-CCE-Token) — no scheme prefix.',
};

const AUTH_METHOD_OPTIONS: AuthMethodOption[] = [
  HEADER_METHOD_OPTION,
  {
    v: 'basic',
    label: 'HTTP Basic',
    name: 'HTTP Basic',
    blurb: 'HTTP Basic — Authorization: Basic base64(username:password).',
  },
  {
    v: 'bearer',
    label: 'Bearer',
    name: 'Bearer token',
    blurb: 'Authorization: Bearer <token> (RFC 6750) — the method DS01.3 adds.',
  },
];

/** Look up an option by method, falling back to the `header` default. */
function methodOption(method: AuthMethod | null): AuthMethodOption {
  return AUTH_METHOD_OPTIONS.find((o) => o.v === method) ?? HEADER_METHOD_OPTION;
}

/** Reusable copy button that flips to a check for ~1.3s (redesign look). */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); fail quietly —
      // the text remains visible for manual selection.
      setCopied(false);
    }
  }

  return (
    <button type="button" onClick={onCopy} aria-label={`Copy ${label}`} style={uBtn}>
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * A labelled mono code box + Copy button (redesign "copy field"). `multiline`
 * preserves whitespace and wraps; single-line truncates with an ellipsis.
 */
function CopyField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={eyebrowStyle}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <code
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--mono)',
            fontSize: 12,
            padding: '8px 11px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text)',
            whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            wordBreak: multiline ? 'break-all' : 'normal',
          }}
        >
          {value}
        </code>
        <CopyButton text={value} label={label} />
      </div>
    </div>
  );
}

/**
 * Method picker — a small segmented control matching FilterBar's `Seg` (the
 * house style for a short exclusive choice). Radio semantics are spelled out for
 * assistive tech since these are `<button>`s, not `<input type="radio">`.
 */
function MethodPicker({
  value,
  onChange,
  disabled,
}: {
  value: AuthMethod;
  onChange: (v: AuthMethod) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Authentication method"
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {AUTH_METHOD_OPTIONS.map((o, i) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.v)}
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--sans)',
              padding: '4px 10px',
              border: 'none',
              cursor: disabled ? 'default' : 'pointer',
              background: active ? 'var(--accent)' : 'var(--surface)',
              color: active ? '#fff' : 'var(--text-muted)',
              fontWeight: active ? 600 : 400,
              borderLeft: i ? '1px solid var(--border)' : 'none',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Auth opt-in card (DESIGN §1.3 / §10). Renders the persisted
 * `auth_enabled`/`auth_method` state (a reload shows the enabled state without
 * the secret) and, on enable, the show-once credential + copy-paste snippet.
 * "Rotate" re-enables (the server issues a fresh secret); "Disable" turns it off.
 */
function AuthCard({
  session,
  absoluteIngestUrl,
  body,
  onAuthChange,
}: {
  session: SessionMeta;
  absoluteIngestUrl: string;
  /** The sample request body, already derived from the registry (see sampleBody). */
  body: string;
  onAuthChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The show-once credential, held only in local state for this render. Cleared
  // on disable; lost on reload (the server never echoes it again — §12).
  const [credential, setCredential] = useState<EnableAuthResponse | null>(null);
  // The picked §1.3 method. Seeded from the persisted one so an already-enabled
  // endpoint opens on what it is actually using; thereafter the supplier owns it
  // (no re-sync on refetch — that would fight the click that caused the refetch).
  const [method, setMethod] = useState<AuthMethod>(session.auth_method ?? 'header');

  async function onEnable() {
    setBusy(true);
    setError(null);
    try {
      // The picked method is always sent explicitly; the service's own default
      // (`header`) is only a back-compat fallback for a body-less caller.
      const result = await enableAuth(session.uuid, { method });
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

  const enabled = session.auth_enabled;
  const activeOption = methodOption(session.auth_method);
  const pickedOption = methodOption(method);
  // Re-POSTing with a different method switches it (and mints a fresh secret), so
  // the primary button says so rather than calling that a "Rotate".
  const switching = enabled && session.auth_method !== null && session.auth_method !== method;

  return (
    <div>
      <div style={eyebrowStyle}>Authentication</div>
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '11px 13px',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
          <Icon
            name="lock"
            size={13}
            style={{ color: enabled ? 'var(--pass)' : 'var(--text-faint)' }}
          />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>
            {enabled ? `Enabled — ${activeOption.name}` : 'Optional — not enabled'}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          {enabled ? (
            <>
              Every POST must carry a credential. The secret is shown only once. §1.3 is graded from
              real traffic.
            </>
          ) : (
            <>
              By default the ingest URL is unauthenticated. Enable auth to require a credential on
              every POST — the validator then grades §1.3 from real traffic.
            </>
          )}
        </div>

        {/* Method picker (§1.3 offers two, DS01.3 a third) — the choice is made
            BEFORE enabling, and re-picking while enabled switches the method. */}
        <div style={{ marginTop: 11 }}>
          <div style={eyebrowStyle}>Method</div>
          <MethodPicker value={method} onChange={setMethod} disabled={busy} />
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--text-muted)',
              lineHeight: 1.55,
              marginTop: 6,
            }}
          >
            {pickedOption.blurb}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
          {enabled ? (
            <>
              <button
                type="button"
                style={uBtn}
                onClick={onEnable}
                disabled={busy}
                title={
                  switching
                    ? `Switch this endpoint to ${pickedOption.name} and issue a fresh credential`
                    : 'Issue a fresh credential for the current method'
                }
              >
                <Icon name="refresh" size={12} />
                {busy ? 'Working…' : switching ? `Switch to ${pickedOption.label}` : 'Rotate'}
              </button>
              <button type="button" style={uBtn} onClick={onDisable} disabled={busy}>
                {busy ? 'Working…' : 'Disable'}
              </button>
            </>
          ) : (
            <button type="button" style={uBtn} onClick={onEnable} disabled={busy}>
              <Icon name="lock" size={12} />
              {busy ? 'Working…' : 'Enable authentication'}
            </button>
          )}
        </div>

        {error && (
          <p style={{ margin: '9px 0 0', fontSize: 11.5, color: 'var(--fail)' }}>{error}</p>
        )}

        {/* Reflect a previously-enabled state on reload: the secret is gone, but
            we tell the holder how to rotate it. */}
        {enabled && !credential && (
          <p
            style={{
              margin: '9px 0 0',
              fontSize: 11.5,
              color: 'var(--text-muted)',
              lineHeight: 1.55,
            }}
          >
            A credential is active for this endpoint. The secret is shown only once at creation; if
            you have lost it, Rotate issues a fresh credential.
          </p>
        )}

        {credential && (
          <AuthCredential
            credential={credential}
            absoluteIngestUrl={absoluteIngestUrl}
            body={body}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Show-once credential display + copy-paste config snippet (DESIGN §10/§12).
 *
 * One arm per method, discriminated on `auth_method` — the credential LINE and
 * the curl flag differ for each and must not be guessed from the shape:
 *   header → `-H '<configured header>: <token>'` (bare token, no scheme)
 *   basic  → `-u '<username>:<password>'`
 *   bearer → `-H 'Authorization: Bearer <token>'` (RFC 6750)
 */
function AuthCredential({
  credential,
  absoluteIngestUrl,
  body,
}: {
  credential: EnableAuthResponse;
  absoluteIngestUrl: string;
  /** The sample request body, already derived from the registry (see sampleBody). */
  body: string;
}) {
  let credLine: string;
  let credLabel: string;
  let authArg: string;
  if (credential.auth_method === 'basic') {
    credLine = `${credential.username}:${credential.password}`;
    credLabel = 'Basic credentials';
    authArg = `-u '${credLine}'`;
  } else if (credential.auth_method === 'bearer') {
    credLine = `${credential.auth_header_name}: Bearer ${credential.token}`;
    credLabel = 'Bearer token';
    authArg = `-H '${credLine}'`;
  } else {
    credLine = `${credential.auth_header_name}: ${credential.token}`;
    credLabel = 'Token header';
    authArg = `-H '${credLine}'`;
  }

  const snippet = [
    `curl -X POST '${absoluteIngestUrl}' \\`,
    `  -H 'Content-Type: ${CONTENT_TYPE}' \\`,
    `  ${authArg} \\`,
    `  -d '${body}'`,
  ].join('\n');

  return (
    <div
      style={{
        marginTop: 11,
        padding: '10px 12px',
        border: '1px solid var(--mixed)',
        background: 'var(--mixed-bg)',
        borderRadius: 6,
      }}
    >
      <p style={{ margin: '0 0 9px', fontSize: 11.5, lineHeight: 1.55 }}>
        <strong>Save this credential now — you will not see it again.</strong> The validator stores
        only a salted hash (§12). Use Rotate to issue a fresh one.
      </p>
      <CopyField label={credLabel} value={credLine} />
      <CopyField label="Authenticated request" value={snippet} multiline />
    </div>
  );
}

export function Setup(props: SetupProps) {
  const {
    session,
    ingestUrl,
    schemas,
    onAuthChange,
    open,
    onToggleOpen,
    hasData,
    onRequestDelete,
  } = props;

  // Controlled when `open` is supplied; else manage internally (default open).
  const [internalOpen, setInternalOpen] = useState(true);
  const isOpen = open ?? internalOpen;
  const toggle = onToggleOpen ?? (() => setInternalOpen((v) => !v));

  // The API returns ingestUrl as a relative path (`/i/{uuid}`); the SPA composes
  // the origin so suppliers get a fully-qualified, runnable URL.
  const absoluteIngestUrl = `${window.location.origin}${ingestUrl}`;

  const body = sampleBody(schemas);

  const curlExample = [
    `curl -X POST '${absoluteIngestUrl}' \\`,
    `  -H 'Content-Type: ${CONTENT_TYPE}' \\`,
    `  -d '${body}'`,
  ].join('\n');

  return (
    <section>
      {/* Collapsed bar — always rendered; toggles the panel. */}
      <div
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 24px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-3)',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <Icon
          name={isOpen ? 'chevronDown' : 'chevron'}
          size={12}
          style={{ color: 'var(--text-faint)' }}
        />
        <span style={{ fontWeight: 600 }}>Endpoint &amp; setup</span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--text-muted)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {ingestUrl}
        </span>
        {hasData === false && (
          <span style={{ fontSize: 11, color: 'var(--accent-text)', fontWeight: 600 }}>
            Start here →
          </span>
        )}
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {isOpen ? 'Collapse' : 'Expand'}
        </span>
      </div>

      {/* Expanded panel — two-column grid. */}
      {isOpen && (
        <div
          style={{
            padding: '18px 24px 22px',
            background: 'var(--surface-2)',
            borderBottom: '1px solid var(--border)',
            display: 'grid',
            gridTemplateColumns: '1.4fr 1fr',
            gap: '0 32px',
          }}
        >
          {/* LEFT: onboarding copy fields. */}
          <div style={{ minWidth: 0 }}>
            {/* Synthetic-data-only warning at the moment of integration — sits
                directly above the ingest URL and curl snippet (DESIGN §2/§12, dkz.1). */}
            <SyntheticDataNotice compact />
            <CopyField label="Ingest URL" value={absoluteIngestUrl} />
            <CopyField label="Required headers" value={`Content-Type: ${CONTENT_TYPE}`} />
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--text-muted)',
                margin: '-6px 0 14px',
                lineHeight: 1.55,
              }}
            >
              Gzip is supported — add{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>Content-Encoding: gzip</code> and send the
              gzipped body. Do not double-encode (§1.6).
            </div>
            <CopyField label="Example request" value={curlExample} multiline />
          </div>

          {/* RIGHT: auth, schema & lifecycle, danger zone. */}
          <div style={{ minWidth: 0 }}>
            <AuthCard
              session={session}
              absoluteIngestUrl={absoluteIngestUrl}
              body={body}
              onAuthChange={onAuthChange}
            />

            <div style={eyebrowStyle}>Schema &amp; lifecycle</div>
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                lineHeight: 1.6,
                marginBottom: 16,
              }}
            >
              {schemas.length === 0 ? (
                // Should not happen — SchemaRegistry.load() seeds itself — but a
                // provenance line is the wrong place to guess. Say what the
                // service reported, never a version it did not.
                <>No schema version is registered, so nothing can be graded against one.</>
              ) : (
                <>
                  Validating against official{' '}
                  {schemas.map((s, i) => (
                    <Fragment key={s.version}>
                      {i > 0 && ', '}
                      <strong style={{ color: 'var(--text)' }}>{s.version}</strong>{' '}
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                        (sha256 {shortSha(s.sha256)})
                      </span>
                    </Fragment>
                  ))}{' '}
                  — {schemas.length === 1 ? 'our vendored copy' : 'our vendored copies'},
                  byte-identical to the bytes published upstream, and the{' '}
                  {schemas.length === 1 ? 'only registered version' : 'whole registered set'}.
                </>
              )}{' '}
              Schemas are never fetched at runtime: the{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>$id</code> inside the schema names the
              version, it is not a download location. Inactive endpoints are purged after 7 days;
              the clock resets on each POST.
            </div>

            <div style={{ ...eyebrowStyle, color: 'var(--fail)' }}>Danger zone</div>
            <div
              style={{
                border: '1px solid var(--fail)',
                borderRadius: 6,
                padding: '11px 13px',
                background: 'var(--fail-bg)',
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>
                Delete all captured data
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--text-muted)',
                  lineHeight: 1.55,
                  marginBottom: 9,
                }}
              >
                Permanently removes every transmission and finding for this endpoint. The endpoint
                and its URL keep working. Cannot be undone.
              </div>
              <button
                type="button"
                onClick={() => onRequestDelete?.()}
                style={{ ...uBtn, color: '#fff', background: 'var(--fail)', border: 'none' }}
              >
                <Icon name="trash" size={12} />
                Delete data…
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

const uBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  fontSize: 12,
  fontFamily: 'var(--sans)',
  color: 'var(--text-muted)',
  background: 'var(--surface)',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const eyebrowStyle: CSSProperties = {
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: 'var(--text-faint)',
  marginBottom: 5,
};
