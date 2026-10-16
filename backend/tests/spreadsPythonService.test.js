const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpreadsPythonService } = require('../services/spreadsPythonService');

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('V2 profile and unrounded payoff numbers survive Node forwarding', async () => {
  const body = { underlyings: ['INFY'], strategy_profile: 'NSE_PAYOFF_RESEARCH_V2', width_steps: 1 };
  const payload = { data_mode: 'fixtures', strategy_profile: body.strategy_profile,
    candidates: [{ ev: -34, payoff_mean_per_unit: -0.3373456789, reference_spot: 1148.8,
      ev_per_lot_inr: -134.94, p_raw: 0.1487, p_adj: 0.1487 }] };
  const service = createSpreadsPythonService({ baseUrl: 'http://python.local', internalKey: 'test-key',
    getMode: () => 'fixtures', fetchImpl: async (url, options) => {
      assert.equal(url, 'http://python.local/spreads/scan');
      assert.deepEqual(JSON.parse(options.body), body);
      return response(200, JSON.parse(JSON.stringify(payload)));
    } });
  assert.deepEqual(await service.scanMultiple(body), payload);
});

test('discovery endpoints forward server user identity only through private headers', async () => {
  const calls = [];
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.local', internalKey: 'test-key', getMode: () => 'fixtures',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200, { all: [], data_mode: 'fixtures' }); },
  });
  await service.getDiscovery({ userId: 'owner-a' });
  await service.discover({ userId: 'owner-a' });
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [
    ['http://python.local/spreads/trending', 'GET'], ['http://python.local/spreads/discover', 'POST'],
  ]);
  assert.equal(calls[0].options.headers['X-Spreads-User-Id'], 'owner-a');
  assert.equal(calls[1].options.body, undefined);
  await assert.rejects(service.discover({}), { status: 422 });
});

test('mismatched provider modes cannot silently serve fixture data in live mode', async () => {
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.local', internalKey: 'internal-secret', getMode: () => 'upstox',
    fetchImpl: async () => response(200, { data_mode: 'fixtures', candidates: [] }),
  });
  await assert.rejects(service.scanMultiple({ underlyings: ['NIFTY'], dte: 30 }, { accessToken: 'test-token' }), {
    status: 503, message: 'Spread data modes differ. Set SPREADS_DATA_MODE identically in Node and Python.',
  });
});

test('fixture mode uses only the private NIFTY endpoint and never forwards an Upstox token', async () => {
  let captured;
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.local/', internalKey: 'internal-secret', getMode: () => 'fixtures',
    fetchImpl: async (url, options) => { captured = { url, options }; return response(200, { expiries: ['2026-12-31'] }); },
  });
  const result = await service.getExpiries({ accessToken: 'must-not-forward' });
  assert.equal(result.expiries[0], '2026-12-31');
  assert.equal(captured.url, 'http://python.local/spreads/nifty/expiries');
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.headers['X-Internal-Service-Key'], 'internal-secret');
  assert.equal(captured.options.headers['X-Upstox-Access-Token'], undefined);
});

test('live mode forwards the user Upstox token to Python without putting it in the body', async () => {
  let captured;
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.local', internalKey: 'internal-secret', getMode: () => 'upstox',
    fetchImpl: async (url, options) => { captured = { url, options }; return response(200, { ok: true, candidates: [] }); },
  });
  const body = { expiry: '2026-12-31', width: 50 };
  await service.scanNifty(body, { accessToken: 'user-scoped-token', userId: 'server-owner' });
  assert.equal(captured.url, 'http://python.local/spreads/nifty/scan');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['X-Upstox-Access-Token'], 'user-scoped-token');
  assert.equal(captured.options.headers['X-Spreads-User-Id'], 'server-owner');
  assert.deepEqual(JSON.parse(captured.options.body), body);
});

test('live mode refuses a scan without an Upstox token and service failures are sanitized', async () => {
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.local', internalKey: 'internal-secret', getMode: () => 'upstox',
    fetchImpl: async () => response(502, { detail: 'sensitive upstream response' }),
  });
  await assert.rejects(service.getExpiries(), { status: 401 });
  await assert.rejects(service.getExpiries({ accessToken: 'token' }), {
    status: 502, message: 'Spread Terminal service is unavailable.',
  });
});

test('production live mode refuses to send an Upstox token over public HTTP', async () => {
  let called = false;
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.example.test', internalKey: 'internal-secret', getMode: () => 'upstox',
    isProduction: () => true, privateNetwork: false,
    fetchImpl: async () => { called = true; return response(200, { ok: true }); },
  });
  await assert.rejects(service.getExpiries({ accessToken: 'user-token' }), {
    status: 503,
    message: 'Upstox token transport must use HTTPS or an explicitly isolated private network.',
  });
  assert.equal(called, false);
});

test('production live mode permits HTTP only when the private network is explicitly enabled', async () => {
  let captured;
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.internal', internalKey: 'internal-secret', getMode: () => 'upstox',
    isProduction: () => true, privateNetwork: true,
    fetchImpl: async (url, options) => { captured = { url, options }; return response(200, { ok: true }); },
  });
  await service.getExpiries({ accessToken: 'user-token' });
  assert.equal(captured.url, 'http://python.internal/spreads/nifty/expiries');
  assert.equal(captured.options.headers['X-Upstox-Access-Token'], 'user-token');
});

test('underlying calls use the private whitelist pattern and sanitize the symbol path', async () => {
  let captured;
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.local', internalKey: 'internal-secret', getMode: () => 'upstox',
    fetchImpl: async (url, options) => { captured = { url, options }; return response(200, { expiries: [] }); },
  });
  await service.getUnderlyingExpiries('banknifty', { accessToken: 'user-token' });
  assert.equal(captured.url, 'http://python.local/spreads/underlyings/BANKNIFTY/expiries');
  assert.equal(captured.options.headers['X-Upstox-Access-Token'], 'user-token');
  assert.throws(() => service.getUnderlyingExpiries('../upstox/connect', { accessToken: 'user-token' }), { status: 422 });
});

test('multi-underlying scan uses only its fixed private read-only Python route', async () => {
  let captured;
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.local', internalKey: 'internal-secret', getMode: () => 'fixtures',
    fetchImpl: async (url, options) => { captured = { url, options }; return response(200, { ok: true }); },
  });
  const body = { underlyings: ['NIFTY', 'BANKNIFTY'], expiries: { NIFTY: '2026-12-31', BANKNIFTY: '2026-12-31' } };
  await service.scanMultiple(body);
  assert.equal(captured.url, 'http://python.local/spreads/scan');
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(JSON.parse(captured.options.body), body);
  assert.equal(captured.options.headers['X-Upstox-Access-Token'], undefined);
});


test('scan transport budget exceeds the cooperative Python worker budget', async t => {
  const delays = [];
  const realSetTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
    delays.push(delay);
    return realSetTimeout(fn, delay, ...args);
  });
  const service = createSpreadsPythonService({
    baseUrl: 'http://python.local', internalKey: 'test-key', getMode: () => 'fixtures', timeoutMs: 60000,
    fetchImpl: async () => response(200, { data_mode:'fixtures', ok:true }),
  });
  await service.getExpiries();
  await service.scanMultiple({underlyings:['NIFTY']});
  await service.scanUnderlying('BANKNIFTY', {});
  await service.discover({userId:'owner'});
  assert.deepEqual(delays, [60000, 210000, 210000, 190000]);
});
