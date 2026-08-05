/**
 * Drift guard for the dev-server proxy (beads 51o, bug 5cb).
 *
 * `npm run dev:web` serves the SPA from Vite and proxies the backend-owned
 * prefixes to the API on :3000; `buildApp()` uses the same list to keep its SPA
 * fallback from shadowing backend routes. Both now read {@link API_PREFIXES},
 * but a hand-written literal is easy to reintroduce in vite.config.ts, and the
 * failure it causes is silent — dev serves the SPA shell for a real API route
 * instead of proxying it. So assert the config's actual proxy keys.
 *
 * Sharing the list is only half of it. The two consumers must agree on MATCHING
 * SEMANTICS too, and 5cb is what happens when they don't: Fastify compares path
 * segments while a plain proxy context is `startsWith`, so `/api` also claimed
 * `/api.ts` — the SPA's own API-client module — and the dashboard went blank.
 * The second half of this file therefore replays Vite's real context matcher
 * against the derived config and demands the same verdict as {@link isApiPath},
 * for every prefix and for the paths that actually bit us.
 *
 * Needs no DB and starts no server: it imports the Vite config object only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { API_PREFIXES, apiProxyContext, isApiPath } from './api-prefixes.js';
import viteConfig from '../vite.config.js';

/** The proxy contexts the config actually declares. */
function proxyContexts(): string[] {
  const proxy = viteConfig.server?.proxy;
  assert.ok(proxy, 'vite.config.ts declares no server.proxy');
  return Object.keys(proxy);
}

/**
 * Vite's own context matcher, verbatim from `doesProxyContextMatchUrl` in
 * vite/src/node/server/middlewares/proxy.ts:
 *
 *     context[0] === '^' && new RegExp(context).test(url) || url.startsWith(context)
 *
 * Copied rather than imported because Vite does not export it. Keep the
 * `startsWith` arm: it is the rule that made a raw `/api` context swallow
 * `/api.ts`, so a kinder copy would hide the very bug this file pins — with it
 * present, reverting the contexts to bare prefixes fails these tests.
 */
function isProxied(url: string): boolean {
  return proxyContexts().some(
    (context) => (context[0] === '^' && new RegExp(context).test(url)) || url.startsWith(context),
  );
}

test('vite dev proxy covers exactly API_PREFIXES', () => {
  assert.deepEqual(proxyContexts().sort(), API_PREFIXES.map(apiProxyContext).sort());
});

test('every proxied prefix targets the API dev server', () => {
  const proxy = viteConfig.server?.proxy ?? {};
  for (const [context, target] of Object.entries(proxy)) {
    assert.equal(target, 'http://127.0.0.1:3000', `${context} proxies somewhere unexpected`);
  }
});

test('the proxy matches every prefix on segment boundaries, as Fastify does', () => {
  for (const prefix of API_PREFIXES) {
    // Owned by the backend: the prefix itself and anything below it.
    for (const url of [prefix, `${prefix}/`, `${prefix}/thing`, `${prefix}/a/b`, `${prefix}?q=1`]) {
      assert.equal(isProxied(url), true, `${url} must be proxied to the API`);
    }

    // NOT owned: a sibling path that merely starts with the same characters.
    // `${prefix}.ts` is the 5cb case — a Vite-transformed module, e.g. /api.ts.
    for (const url of [`${prefix}.ts`, `${prefix}x/y`, `${prefix}-legacy`, `${prefix}con/a.png`]) {
      assert.equal(isProxied(url), false, `${url} must be served by Vite, not proxied`);
    }
  }
});

test('proxy and SPA fallback agree on which paths the backend owns', () => {
  const urls = [
    // The 5cb repro and its neighbours.
    '/api.ts',
    '/api/sessions',
    '/api/sessions/6f1b0c4e-0000-4000-8000-000000000000',
    // `/i` must not swallow same-origin dev assets that share its first char.
    '/i/6f1b0c4e-0000-4000-8000-000000000000',
    '/icons/foo.png',
    '/images/x',
    '/index.css',
    // `/health` likewise.
    '/health',
    '/health?probe=1',
    '/healthz',
    // Client routes Vite's SPA fallback owns.
    '/',
    '/d/6f1b0c4e-0000-4000-8000-000000000000',
    '/main.tsx',
    '/assets/index-abc123.js',
  ];

  for (const url of urls) {
    assert.equal(
      isProxied(url),
      isApiPath(url.split('?')[0]!),
      `${url}: the dev proxy and the SPA fallback disagree about who owns it`,
    );
  }
});
