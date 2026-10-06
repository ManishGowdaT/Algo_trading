const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createUserRateLimiter } = require('../middleware/rateLimiters');

test('authenticated limiter returns 429 at the configured user limit and isolates users', async (t) => {
  const app = express();
  app.use((req, res, next) => {
    req.user = { _id: req.get('x-test-user') };
    next();
  });
  app.get('/limited', createUserRateLimiter({ windowMs: 60_000, limit: 2 }), (req, res) => {
    res.status(200).json({ ok: true });
  });

  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
    server.closeAllConnections();
  }));

  const url = `http://127.0.0.1:${server.address().port}/limited`;
  const requestAs = (userId) => fetch(url, { headers: { 'x-test-user': userId } });

  const first = await requestAs('user-a');
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  const second = await requestAs('user-a');
  assert.equal(second.status, 200);
  await second.arrayBuffer();
  const limited = await requestAs('user-a');
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('ratelimit'));
  assert.ok(limited.headers.get('retry-after'));
  assert.deepEqual(await limited.json(), {
    status: 'fail',
    code: 'APPLICATION_RATE_LIMITED',
    message: 'Too many requests. Please wait a moment and try again.',
    retryAfterSeconds: 60,
  });

  const otherUser = await requestAs('user-b');
  assert.equal(otherUser.status, 200);
  await otherUser.arrayBuffer();
});
