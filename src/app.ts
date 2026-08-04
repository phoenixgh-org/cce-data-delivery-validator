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
 *     a client spoof the scheme. The trusted proxy address is env-configurable,
 *     and a scope that does not cover the real proxy is warned about once per
 *     instance rather than silently dropping the header (c64).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { API_PREFIXES } from './api-prefixes.js';
import { registerSessionsApi } from './api/sessions.js';
import { registerIngestRoute } from './ingest/route.js';
import { SchemaRegistry } from './schema-registry.js';

/** Default trusted proxy address for local dev (loopback). */
const DEFAULT_TRUSTED_PROXY = '127.0.0.1';

/**
 * Default directory of the built React SPA (Vite's `outDir` in vite.config.ts).
 * Resolved relative to the compiled module: `dist/app.js` → `dist/web`.
 */
const DEFAULT_WEB_DIST = fileURLToPath(new URL('./web', import.meta.url));

/**
 * File whose presence identifies a directory as the Vite SOURCE root (`src/web`)
 * rather than the build output — `vite build` emits hashed bundles under
 * `assets/`, never a `.tsx`.
 *
 * This matters in dev: `npm run dev` runs `tsx src/index.ts`, so
 * {@link DEFAULT_WEB_DIST} resolves to `src/web`, which EXISTS but holds the
 * untransformed `index.html` whose `<script src="/main.tsx">` the browser cannot
 * load — the SPA fallback would serve a page that 404s its own module. Serving
 * that is worse than serving nothing, so we skip static registration and say why
 * (beads 4z2). Use `npm run dev:web` (Vite dev server, proxying the API here) or
 * `npm run build` to serve the dashboard from this process.
 */
const WEB_SOURCE_MARKER = 'main.tsx';

/** True when `pathname` is owned by a backend route (must not be SPA-fallen-back). */
function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Outer hard ceiling on the request body Fastify will buffer, set ABOVE the §1.4
 * 1MB grading cap (`MAX_WIRE_BYTES` in src/ingest/stages/size.ts).
 *
 * Fastify's DEFAULT bodyLimit is exactly 1MB — the same as our grading cap — so
 * an oversized POST would be rejected with Fastify's generic `413`
 * (`FST_ERR_CTP_BODY_TOO_LARGE`, body shape `{statusCode,code,error,message}`)
 * BEFORE it ever reaches the size stage, recording no transmission row and no
 * §1.4 teaching finding. DESIGN.md §4.1 says "the app owns the §1.4 cap", so we
 * raise the ceiling to give headroom: an oversized-but-bounded body now REACHES
 * the size stage, which emits the 1.4 finding and halts `413` with a persisted
 * row. Bodies beyond this outer ceiling still get Fastify's generic 413 to bound
 * memory. See bug 6y3.
 */
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024; // 2 MiB

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
  /**
   * Outer hard ceiling (bytes) on the request body Fastify buffers. Defaults to
   * {@link DEFAULT_BODY_LIMIT} (2 MiB), kept ABOVE the §1.4 1MB grading cap so
   * oversized bodies reach the size stage for the teaching 413. See bug 6y3.
   */
  bodyLimit?: number;
  /**
   * Directory of the built React SPA to serve as static files (DESIGN §13).
   * Defaults to {@link DEFAULT_WEB_DIST} (`dist/web`). Overridable so tests can
   * point at a fixture. If the directory does not exist (e.g. `npm test` with no
   * prior `vite build`) — or holds the Vite SOURCE rather than a build, see
   * {@link WEB_SOURCE_MARKER} — static serving + the SPA fallback are NOT
   * registered, keeping the app construct-able without a web build.
   */
  webDist?: string;
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
    // Above the §1.4 grading cap so oversized bodies reach the size stage (6y3).
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
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

  // Make the TRUSTED_PROXY misconfiguration fail LOUD (c64).
  //
  // The out-of-the-box compose default (`TRUSTED_PROXY=127.0.0.1`) is wrong the
  // moment the proxy is a container on the bridge network: Fastify then ignores
  // its `X-Forwarded-Proto` and every request reads as plain `http`, with no
  // error anywhere. docker-compose.yml and docs/deployment.md §2 both say so —
  // but only to a reader who reads them, and there is no assertable surface for
  // that contract term (deployment.md §6). So detect it at request time: if a
  // request carries `X-Forwarded-Proto` and `request.protocol` still disagrees
  // with it, Fastify rejected the peer address and the trust scope does not
  // match the real proxy.
  //
  // OBSERVATIONAL ONLY. Nothing about grading changes — DESIGN §7 row 1.1 keeps
  // HTTPS as 🔒 enforced-by-us and src/ingest/stages/method.ts stays deliberately
  // lenient on scheme. Warned once per instance so a misconfigured edge logs a
  // single line rather than one per request.
  let forwardedProtoWarned = false;
  app.addHook('onRequest', async (request) => {
    if (forwardedProtoWarned) return;
    const header = request.headers['x-forwarded-proto'];
    if (typeof header !== 'string' || header.trim() === '') return;
    // Fastify honours the LAST comma-separated entry (lib/request.js
    // `getLastEntryInMultiHeaderValue`) and does not case-fold it, so compare
    // like for like or a proxy sending `HTTPS` would read as a mismatch.
    const claimed = header.slice(header.lastIndexOf(',') + 1).trim();
    if (claimed.toLowerCase() === (request.protocol ?? '').toLowerCase()) return;
    forwardedProtoWarned = true;
    app.log.warn(
      `X-Forwarded-Proto: ${claimed} arrived from ${request.ip}, which TRUSTED_PROXY ` +
        `(${trustedProxy}) does not cover — the header is being IGNORED and requests are ` +
        `treated as ${request.protocol}. If this address is your reverse proxy, set ` +
        `TRUSTED_PROXY to it (or its subnet); see docs/deployment.md §3. Logged once.`,
    );
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // The ingest pipeline: `POST /i/:uuid` (all methods registered so non-POST
  // returns 405, not Fastify's default 404). DESIGN.md §6.
  registerIngestRoute(app);

  // The sessions API: `POST /api/sessions` mints a session and returns its
  // capability paths (DESIGN.md §5).
  registerSessionsApi(app);

  // The M4 React SPA: serve the Vite build as static files with an SPA fallback
  // so `/d/:uuid` deep-links resolve to index.html (DESIGN §5/§13). Registered
  // LAST so it can never shadow /api/*, /i/*, or /health. Guarded on the build
  // dir existing, so `npm test` (no prior `vite build`) stays green.
  const webDist = options.webDist ?? DEFAULT_WEB_DIST;
  if (existsSync(join(webDist, WEB_SOURCE_MARKER))) {
    // Dev (`npm run dev`): this is the Vite source root, not a build. See
    // WEB_SOURCE_MARKER — serving it hands the browser a page that 404s.
    app.log.warn(
      `web: ${webDist} is the Vite SOURCE root, not a build — static serving and the ` +
        `SPA fallback are disabled. Run \`npm run dev:web\` for the dashboard, or ` +
        `\`npm run build\` to serve it from this process.`,
    );
  } else if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });

    // SPA fallback: a GET that matched no route and is NOT an API/ingest/health
    // path serves index.html (200, text/html) so the client router can read the
    // uuid. Non-GET or API paths get a 404 — reproduced INLINE rather than via
    // reply.callNotFound(): calling that from inside a notFoundHandler re-enters
    // the handler, which Fastify rejects with a warn log ("Trying to send a
    // NotFound error inside a 404 handler") and a degraded plain-text body. We
    // instead send Fastify's own default-404 JSON shape directly (bug bcm).
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !isApiPath(request.url.split('?')[0]!)) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Route ${request.method}:${request.url} not found`,
      });
    });
  }

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
