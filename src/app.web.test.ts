/**
 * Static-serving + SPA-fallback smoke test (M4, yih.1). Proves @fastify/static
 * serves the SPA shell at `/` and falls back to index.html for `/d/:uuid`
 * deep-links, WITHOUT shadowing /api/*, /i/*, or /health, and only for GET.
 *
 * Hermetic: points `webDist` at a tmp fixture holding a minimal index.html, so
 * it does not depend on a prior `vite build` and needs no DB.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp } from './app.js';

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div>SPA-SHELL</body></html>';

let webDist: string;

before(() => {
  webDist = mkdtempSync(join(tmpdir(), 'cce-web-'));
  writeFileSync(join(webDist, 'index.html'), INDEX_HTML);
});

after(() => {
  rmSync(webDist, { recursive: true, force: true });
});

function makeApp() {
  return buildApp({ logger: false, webDist });
}

test('GET / serves the SPA shell (200, text/html)', async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.match(res.body, /SPA-SHELL/);
  } finally {
    await app.close();
  }
});

test('GET /d/:uuid falls back to index.html (200, text/html)', async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/d/11111111-1111-4111-8111-111111111111',
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.match(res.body, /SPA-SHELL/);
  } finally {
    await app.close();
  }
});

test('GET /health is NOT shadowed by the SPA fallback', async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  } finally {
    await app.close();
  }
});

test('GET /api/sessions/:uuid hits the API, not the SPA fallback', async () => {
  const app = makeApp();
  await app.ready();
  try {
    // No DB in unit tests → the API handler will error reaching the pool. The
    // point is routing: the response must NOT be the SPA shell. Assert the body
    // is not the index.html and the content-type is not text/html.
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/22222222-2222-4222-8222-222222222222',
    });
    assert.doesNotMatch(res.body, /SPA-SHELL/, 'API path must not be served index.html');
    assert.doesNotMatch(
      res.headers['content-type'] ?? '',
      /text\/html/,
      'API path must not get an HTML content-type from the SPA fallback',
    );
  } finally {
    await app.close();
  }
});

test('POST /api/sessions is NOT shadowed by the GET-only SPA fallback', async () => {
  const app = makeApp();
  await app.ready();
  try {
    // The fallback is GET-only; a POST must route to the API (which errors w/o a
    // DB) rather than being served the SPA shell.
    const res = await app.inject({ method: 'POST', url: '/api/sessions' });
    assert.doesNotMatch(res.body, /SPA-SHELL/, 'POST must not be served index.html');
  } finally {
    await app.close();
  }
});

test('POST /i/:uuid is NOT shadowed by the GET-only SPA fallback', async () => {
  const app = makeApp();
  await app.ready();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/i/33333333-3333-4333-8333-333333333333',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from('{}'),
    });
    assert.doesNotMatch(res.body, /SPA-SHELL/, 'ingest POST must not be served index.html');
  } finally {
    await app.close();
  }
});
