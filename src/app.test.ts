import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from './app.js';

function makeApp() {
  // Logger off to keep test output clean; registry still loads + compiles.
  return buildApp({ logger: false });
}

test('GET /health returns 200 with ok body', async () => {
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

test('raw POST body bytes are recoverable on request.rawBody', async () => {
  const app = makeApp();
  // A route that echoes back exactly what it received, for the test only.
  app.post('/echo', async (request) => {
    assert.ok(Buffer.isBuffer(request.rawBody), 'rawBody must be a Buffer');
    return {
      hex: request.rawBody.toString('hex'),
      length: request.rawBody.length,
    };
  });
  await app.ready();
  try {
    // Intentionally NOT valid JSON, plus a non-ASCII byte, to prove the parser
    // keeps exact wire bytes rather than parsing/normalizing them.
    const payload = Buffer.from('not-jsoné{', 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { hex: string; length: number };
    assert.equal(body.hex, payload.toString('hex'));
    assert.equal(body.length, payload.length);
  } finally {
    await app.close();
  }
});

test('app does not blanket-trust proxy headers (trustProxy is scoped)', async () => {
  // With trustProxy scoped to a specific address, an injected request from an
  // untrusted source must NOT have its X-Forwarded-Proto honored.
  const app = buildApp({ logger: false, trustedProxy: '10.0.0.1' });
  app.get('/proto', async (request) => ({ protocol: request.protocol }));
  await app.ready();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/proto',
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '203.0.113.9', // not the trusted proxy
    });
    const body = res.json() as { protocol: string };
    assert.equal(body.protocol, 'http', 'spoofed X-Forwarded-Proto must be ignored');
  } finally {
    await app.close();
  }
});
