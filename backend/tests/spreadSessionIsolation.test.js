const test = require('node:test');
const assert = require('node:assert/strict');
const controller = require('../controllers/spreadController');

function response() {
  return { statusCode: 200, body: null, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('opening Spreads without Upstox returns a connection error rather than app-auth 401', async () => {
  const originalMode = process.env.SPREADS_DATA_MODE;
  process.env.SPREADS_DATA_MODE = 'upstox';
  try {
    const req = { user: { id: 'spreads-session-isolation-test' }, params: { symbol: 'NIFTY' } };
    controller.oauth.disconnect(req.user.id);
    const res = response();
    await controller.underlyingExpiries(req, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.upstoxSessionUnavailable, true);
    assert.match(res.body.message, /Connect Upstox/);
  } finally {
    if (originalMode === undefined) delete process.env.SPREADS_DATA_MODE;
    else process.env.SPREADS_DATA_MODE = originalMode;
  }
});

test('expired provider and OAuth tokens remain separate from app authentication', () => {
  for (const handler of [controller.sendScanError, controller.sendError]) {
    const res = response();
    handler({}, res, Object.assign(new Error('Upstox token expired; reconnect.'), { status: 401 }));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.upstoxSessionUnavailable, true);
    assert.match(res.body.message, /Upstox token expired/);
  }
});

test('unrelated Spread request errors retain their original status', () => {
  for (const status of [403, 422, 429]) {
    const res = response();
    controller.sendScanError({}, res, Object.assign(new Error('Rejected'), { status }));
    assert.equal(res.statusCode, status);
    assert.equal(res.body.upstoxSessionUnavailable, undefined);
  }
});

test('callback admission is logged without exposing query values or cookies', () => {
  const { EventEmitter } = require('node:events');
  const res = new EventEmitter();
  res.statusCode = 401;
  const logs = [];
  const original = console.info;
  console.info = entry => logs.push(entry);
  let continued = false;
  try {
    controller.observeCallback({ requestId: 'safe-reference', headers: {}, cookies: { jwt: 'PRIVATE-COOKIE' }, query: { code: 'PRIVATE-CODE', state: 'PRIVATE-STATE' } }, res, () => { continued = true; });
    res.emit('finish');
  } finally { console.info = original; }
  assert.equal(continued, true);
  assert.match(logs[0], /hasAppCookie=true/);
  assert.match(logs[1], /httpStatus=401/);
  assert.doesNotMatch(logs.join(' '), /PRIVATE-/);
});

test('discovery controller uses authenticated user rather than body owner selectors', async () => {
  const bridge = require('../services/spreadsPythonService');
  // Route protection is required for all discovery paths, just like scans.
  const fs = require('node:fs');
  const routes = fs.readFileSync(require.resolve('../routes/spreadRoutes'), 'utf8');
  assert.ok(routes.indexOf('router.use(authController.protect)') < routes.indexOf("router.post('/discover'"));
  assert.match(routes, /router\.get\('\/trending', controller\.discovery\)/);
  const originalMode = process.env.SPREADS_DATA_MODE;
  process.env.SPREADS_DATA_MODE = 'upstox';
  try {
    const res = response();
    await controller.discovery({ method: 'POST', user: { id: 'disconnected-discovery-owner' }, body: { userId: 'foreign-user', accessToken: 'forged-token' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.upstoxSessionUnavailable, true);
    assert.equal(typeof bridge.createSpreadsPythonService, 'function');
  } finally {
    if (originalMode === undefined) delete process.env.SPREADS_DATA_MODE;
    else process.env.SPREADS_DATA_MODE = originalMode;
  }
});
