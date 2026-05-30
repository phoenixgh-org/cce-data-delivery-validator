/**
 * Fastify app factory.
 *
 * `buildApp()` returns a configured Fastify instance without binding a port, so
 * it is testable via `app.inject(...)`. The listen/bootstrap entrypoint lives in
 * `index.ts`.
 *
 * Two edge-contract requirements from DESIGN.md §4.1 are wired here:
 *
 *   - **Raw-body retention.** A catch-all content-type parser keeps the exact
 *     wire bytes of a POST body as a Buffer on `request.rawBody`, so §1.4
 *     wire-byte measurement (lands in M2) sees precisely what the supplier sent.
 *     We deliberately do NOT register a JSON body parser that would discard the
 *     raw bytes.
 *
 *   - **Scoped trustProxy.** `X-Forwarded-Proto` (how §1.1 HTTPS is known) is
 *     only trusted from Caddy's address — never blanket `true`, which would let
 *     a client spoof the scheme. The trusted proxy address is env-configurable.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerIngestRoute } from './ingest/route.js';
import { SchemaRegistry } from './schema-registry.js';

/** Default trusted proxy address for local dev (loopback). */
const DEFAULT_TRUSTED_PROXY = '127.0.0.1';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact wire bytes of the request body, retained for §1.4 measurement. */
    rawBody?: Buffer;
  }
}

export interface BuildAppOptions {
  /**
   * Address(es) Fastify will trust `X-Forwarded-*` headers from. Defaults to the
   * `TRUSTED_PROXY` env var, then loopback. Never blanket-trusts.
   */
  trustedProxy?: string;
  /** Pre-loaded registry; if omitted, one is loaded (and compiled) here. */
  registry?: SchemaRegistry;
  /** Fastify logger config. Defaults to enabled. */
  logger?: boolean;
}

/**
 * Build (but do not start) the Fastify app. Loads + compiles the schema registry
 * at construction time, so the app fails loudly if the blessed bytes don't
 * compile.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const trustedProxy = options.trustedProxy ?? process.env.TRUSTED_PROXY ?? DEFAULT_TRUSTED_PROXY;

  // Load + compile the registry (throws at boot if it can't compile).
  const registry = options.registry ?? SchemaRegistry.load();

  const app = Fastify({
    logger: options.logger ?? true,
    // Scope trust to the proxy only — NOT blanket `true`. This prevents clients
    // from spoofing X-Forwarded-Proto behind Caddy.
    trustProxy: trustedProxy,
  });

  // Make the registry available to routes/plugins.
  app.decorate('schemaRegistry', registry);

  // Retain raw wire bytes for ALL content types. We keep the Buffer rather than
  // parsing here; request-time parsing/validation lands in M2. Remove Fastify's
  // built-in JSON/text parsers first so they can't shadow this catch-all and
  // silently discard (or reject) the raw bytes — §1.4 needs the exact bytes the
  // supplier sent, even when the body is not valid JSON.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body: Buffer, done) => {
    done(null, body);
  });

  // Capture the raw Buffer onto the request for later §1.4 measurement.
  app.addHook('preValidation', async (request) => {
    if (Buffer.isBuffer(request.body)) {
      request.rawBody = request.body;
    }
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // The ingest pipeline: `POST /i/:uuid` (all methods registered so non-POST
  // returns 405, not Fastify's default 404). DESIGN.md §6.
  registerIngestRoute(app);

  // Log the blessed registry provenance at startup.
  app.ready(() => {
    for (const version of registry.supportedVersions()) {
      const entry = registry.get(version);
      if (entry) {
        app.log.info(`registry: ${entry.version} (sha256 ${entry.sha256}) compiled`);
      }
    }
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    schemaRegistry: SchemaRegistry;
  }
}
