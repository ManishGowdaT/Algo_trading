const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const createSecurityHeaders = require('../middleware/securityHeaders');

async function createTestServer(t, app) {
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('API security headers are present without changing JSON response behavior', async (t) => {
  const app = express();
  app.use(createSecurityHeaders({ production: false }));
  app.get('/health', (req, res) => res.status(200).json({ ok: true }));

  const baseUrl = await createTestServer(t, app);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('production HSTS is emitted only when the trusted proxy reports HTTPS', async (t) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createSecurityHeaders({ production: true }));
  app.get('/health', (req, res) => res.status(200).json({ ok: true }));

  const baseUrl = await createTestServer(t, app);
  const secureResponse = await fetch(`${baseUrl}/health`, { headers: { 'x-forwarded-proto': 'https' } });
  const insecureResponse = await fetch(`${baseUrl}/health`, { headers: { 'x-forwarded-proto': 'http' } });

  assert.match(secureResponse.headers.get('strict-transport-security') || '', /max-age=15552000/);
  assert.equal(insecureResponse.headers.get('strict-transport-security'), null);
});
