const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('50-name expiry loading has a bounded authenticated budget independent of scans', async () => {
  const auth = require('../controllers/authController');
  const controller = require('../controllers/spreadController');
  const savedProtect = auth.protect;
  const saved = { ...controller };
  let router;
  try {
    auth.protect = (req, res, next) => {
      if (!req.headers['x-test-user']) return res.sendStatus(401);
      req.user = { id: req.headers['x-test-user'] };
      next();
    };
    for (const name of Object.keys(controller)) {
      if (typeof controller[name] === 'function') controller[name] = (_req, res) => res.json({ ok: true });
    }
    delete require.cache[require.resolve('../routes/spreadRoutes')];
    router = require('../routes/spreadRoutes');
  } finally {
    auth.protect = savedProtect;
    Object.assign(controller, saved);
    delete require.cache[require.resolve('../routes/spreadRoutes')];
  }
  const app = express();
  app.use('/spreads', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/spreads`;
  async function request(path, method = 'GET', user = 'batch-user') {
    const response = await fetch(base + path, { method, headers: user ? { 'x-test-user': user } : {} });
    await response.text();
    return response.status;
  }
  try {
    assert.equal(await request('/underlyings/NIFTY/expiries', 'GET', null), 401);
    for (let i = 0; i < 50; i++) assert.equal(await request(`/underlyings/S${i}/expiries`), 200);
    for (let i = 0; i < 30; i++) assert.equal(await request('/scan', 'POST'), 200);
    assert.equal(await request('/scan', 'POST'), 429);
    for (let i = 50; i < 120; i++) assert.equal(await request(`/underlyings/S${i}/expiries`), 200);
    assert.equal(await request('/underlyings/EXTRA/expiries'), 429);
    assert.equal(await request('/underlyings/OTHER/expiries', 'GET', 'other-user'), 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
