/**
 * TRANSPORT wrappers — the second exercise transform family (8qa.1; epic 8qa
 * design notes).
 *
 * Where a payload mutator changes WHAT is sent, a transport wrapper changes HOW
 * it is delivered: method, headers, body encoding, body size, credential. These
 * are the §6 transport-level halts (405/413/400/401) and the §1.2 content-type
 * finding — gradeable requirements that short-circuit the pipeline before any
 * schema work, so a suite that only mutated payloads would never reach them.
 *
 * A wrapper is a pure function over a {@link WireRequest}. Nothing here opens a
 * socket: the future live runner (8qa.2) takes the materialized request and
 * sends it. That split is what keeps this whole module CI-testable.
 *
 * ── the payload is untouched ────────────────────────────────────────────────
 * By construction a transport wrapper cannot change the payload's standing with
 * the schema, so ../cases.test.ts checks these cases at the layer where they ARE
 * checkable: the wrapper's effect on the wire request (method, headers, bytes).
 * Whether the validator then returns 405/413/400/401 is a live-instance
 * assertion, and belongs to the runner bite.
 */

import { gzipSync } from 'node:zlib';

import { JSON_UTF8, oversizeBytes, unparseableBytes } from '../../ingest/fixtures/transmissions.js';

/** The HTTP request an exercise POST turns into, before it is sent anywhere. */
export interface WireRequest {
  method: string;
  /** Header names are lower-cased so wrappers can overwrite deterministically. */
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Runtime facts a wrapper may need that a case cannot know when it is written —
 * today just the session credential the runner configured for §1.3 cases.
 */
export interface TransportContext {
  /** The credential value a correctly-authorized POST should present. */
  readonly credential?: string | null;
}

/** One named transport wrapper. */
export interface TransportTransform {
  readonly kind: 'transport';
  /** Self-documenting name, e.g. `contentType(text/plain)`. */
  readonly name: string;
  /** Requirement ids (COMPLIANCE_MATRIX ids) this wrapper bears on. */
  readonly targets: readonly string[];
  apply(request: WireRequest, context: TransportContext): WireRequest;
}

/** The extension point later bites add vocabulary through. */
export function transportTransform(spec: {
  name: string;
  targets?: readonly string[];
  apply: (request: WireRequest, context: TransportContext) => WireRequest;
}): TransportTransform {
  return {
    kind: 'transport',
    name: spec.name,
    targets: spec.targets ?? [],
    apply: spec.apply,
  };
}

/**
 * The canonical POST every case starts from: `POST` with the §1.2 content-type
 * and the serialized payload as its body.
 */
export function baseRequest(body: Buffer): WireRequest {
  return { method: 'POST', headers: { 'content-type': JSON_UTF8 }, body };
}

// ── §1.1 method ─────────────────────────────────────────────────────────────

/**
 * Send with a different HTTP method. Anything but POST is a §6 row-1 halt: 405,
 * with NO transmission row and therefore no finding — the status IS the grade.
 */
export function method(verb: string): TransportTransform {
  return transportTransform({
    name: `method(${verb})`,
    targets: ['1.1'],
    apply: (request) => ({ ...request, method: verb }),
  });
}

/**
 * Replace the body with bytes that never parse as JSON (§6 row 6 → 400, §1.1
 * fail). Reuses the ingest fixture's unparseable bytes rather than minting a
 * second definition of "broken JSON".
 */
export function unparseableBody(): TransportTransform {
  return transportTransform({
    name: 'unparseableBody()',
    targets: ['1.1'],
    apply: (request) => ({ ...request, body: unparseableBytes() }),
  });
}

// ── §1.2 content-type ───────────────────────────────────────────────────────

/**
 * Override `Content-Type`. `application/json; charset=utf-8` is the §1.2 pass;
 * anything else is a §1.2 fail finding that does NOT halt (415 is optional per
 * §6), so the run continues and still reaches the schema stage.
 */
export function contentType(value: string): TransportTransform {
  return transportTransform({
    name: `contentType(${value})`,
    targets: ['1.2'],
    apply: (request) => ({ ...request, headers: { ...request.headers, 'content-type': value } }),
  });
}

// ── §1.3 authorization (opt-in) ─────────────────────────────────────────────

/**
 * Present the session's credential as an RFC 6750 Bearer token — the §1.3 pass
 * once a session has opted into auth. The value comes from the runner via
 * {@link TransportContext}; a case never hard-codes a credential.
 */
export function bearerCredential(): TransportTransform {
  return transportTransform({
    name: 'bearerCredential()',
    targets: ['1.3'],
    apply: (request, context) => {
      const credential = context.credential;
      if (credential == null || credential === '') {
        throw new Error('bearerCredential(): no credential supplied by the runner');
      }
      return {
        ...request,
        headers: { ...request.headers, authorization: `Bearer ${credential}` },
      };
    },
  });
}

/** Send no credential at all — a §1.3 fail + 401 on an auth-enabled session. */
export function noAuth(): TransportTransform {
  return transportTransform({
    name: 'noAuth()',
    targets: ['1.3'],
    apply: (request) => {
      const headers = { ...request.headers };
      delete headers.authorization;
      return { ...request, headers };
    },
  });
}

/** Send a WRONG bearer credential — a §1.3 fail + 401, distinct from `noAuth`. */
export function badAuth(token = 'not-the-configured-credential'): TransportTransform {
  return transportTransform({
    name: 'badAuth()',
    targets: ['1.3'],
    apply: (request) => ({
      ...request,
      headers: { ...request.headers, authorization: `Bearer ${token}` },
    }),
  });
}

// ── §1.4 size ───────────────────────────────────────────────────────────────

/**
 * Replace the body with one byte over the §1.4 1MB cap (§6 row 3 → 413). Content
 * is irrelevant — the size stage halts before parse — so this reuses the ingest
 * fixture's filler bytes.
 */
export function oversize(): TransportTransform {
  return transportTransform({
    name: 'oversize()',
    targets: ['1.4'],
    apply: (request) => ({ ...request, body: oversizeBytes() }),
  });
}

// ── §1.6 content-encoding ───────────────────────────────────────────────────

/** Gzip the body and declare it — the legal §1.6 encoding (a §1.6 pass). */
export function gzip(): TransportTransform {
  return transportTransform({
    name: 'gzip()',
    targets: ['1.6'],
    apply: (request) => ({
      ...request,
      headers: { ...request.headers, 'content-encoding': 'gzip' },
      body: gzipSync(request.body),
    }),
  });
}

/**
 * Gzip the body TWICE while declaring a single `gzip` — the double-wrapping
 * §1.6 forbids (§6 row 5 → 400). Composes on top of {@link gzip} so the
 * "one legal layer" definition lives in one place.
 */
export function doubleGzip(): TransportTransform {
  return transportTransform({
    name: 'doubleGzip()',
    targets: ['1.6'],
    apply: (request) => ({
      ...request,
      headers: { ...request.headers, 'content-encoding': 'gzip' },
      body: gzipSync(gzipSync(request.body)),
    }),
  });
}

/** Declare an encoding we never accept (only gzip is decodable) → §1.6 fail, 400. */
export function unsupportedEncoding(token = 'br'): TransportTransform {
  return transportTransform({
    name: `unsupportedEncoding(${token})`,
    targets: ['1.6'],
    apply: (request) => ({
      ...request,
      headers: { ...request.headers, 'content-encoding': token },
    }),
  });
}

// ── §1.7 custom headers (permissive — nothing to grade) ─────────────────────

/**
 * Add an arbitrary custom header. §1.7 explicitly permits them and we grade
 * nothing, so this exists to demonstrate the permissive path rather than to
 * provoke a finding.
 */
export function customHeader(name: string, value: string): TransportTransform {
  return transportTransform({
    name: `customHeader(${name})`,
    targets: ['1.7'],
    apply: (request) => ({
      ...request,
      headers: { ...request.headers, [name.toLowerCase()]: value },
    }),
  });
}
