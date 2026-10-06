const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const context = require('../services/accountContext');
const active = require('../services/activeAccountService');
const BrokerAccount = require('../models/BrokerAccount');
const Trade = require('../models/Trade');
const Strategy = require('../models/Strategy');
const config = require('../config');
const feeds = require('../services/marketDataService');
const engine = require('../services/strategyEngine');
const marketSession = require('../services/marketSessionManager');
const transport = require('../services/pythonApiClient');
const budget = require('../services/marketRequestBudget');
marketSession.stopMonitoring();

const A = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: '111111111111111111111111', brokerClientId: 'CLIENT-A', sessionGeneration: 1, ownerGeneration: 0, status: 'CONNECTED' };
const B = { ...A, _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', userId: '222222222222222222222222', brokerClientId: 'CLIENT-B' };
class Socket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.failSend = false; }
  send(data) { if (this.failSend) throw new Error('socket closed during cleanup'); this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
}
const flatCandles = Array.from({ length: 35 }, (_, i) => ({
  ts: new Date(Date.UTC(2026, 9, 5, 4, i * 5)).toISOString(), open: 100, high: 101, low: 99, close: 100,
}));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t) {
  const old = { find: BrokerAccount.findOne, trade: Trade.findOne, update: Trade.findOneAndUpdate,
    strategy: Strategy.findOne, socket: globalThis.WebSocket, base: config.API.ANGEL_ONE_API_BASE, key: config.API.INTERNAL_SERVICE_KEY };
  const records = [structuredClone(A), structuredClone(B)];
  BrokerAccount.findOne = query => ({ lean: async () => records.find(row => row.userId === String(query.userId)
    && (!query._id || row._id === String(query._id))) || null });
  Trade.findOne = () => ({ select() { return this; }, lean: async () => null });
  Strategy.findOne = async () => null;
  globalThis.WebSocket = Socket;
  config.API.INTERNAL_SERVICE_KEY = 'phase4-local-only';
  for (const row of records) active.setActiveAccount({ userId: row.userId, brokerAccountId: row._id,
    clientCode: row.brokerClientId, sessionId: `session-${row.brokerClientId}`, sessionGeneration: 1, ownerGeneration: 0 });
  const calls = [];
  const state = { handler: null };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const row = records.find(item => item._id === req.headers['x-broker-account-id']);
    calls.push({ url, headers: req.headers });
    assert.equal(req.headers['x-internal-service-key'], 'phase4-local-only');
    assert.equal(req.headers['x-active-user-id'], row.userId);
    assert.equal(req.headers['x-broker-client-id'], row.brokerClientId);
    assert.equal(req.headers['x-broker-session-id'], `session-${row.brokerClientId}`);
    if (state.handler && await state.handler(req, res, url, row)) return;
    let data;
    if (url.pathname === '/angel/session-tokens') data = { status: true, active_user_id: row.userId,
      session_id: `session-${row.brokerClientId}`, client_code: row.brokerClientId, feed_token: 'test-feed', jwt_token: 'test-jwt', api_key: 'test-key' };
    else if (url.pathname === '/angel/status') data = { connected: true };
    else if (url.pathname === '/market/index-ltp') data = { ltp: 100 };
    else if (url.pathname === '/instruments/index-options') data = { expiries: ['2099-01-01'], strikes: [100], contracts: [
      { exchange: 'NFO', symboltoken: '77', tradingsymbol: `${row.brokerClientId}-CE`, strike: 100, option_type: 'CE' },
      { exchange: 'NFO', symboltoken: '78', tradingsymbol: `${row.brokerClientId}-PE`, strike: 100, option_type: 'PE' },
    ] };
    else if (url.pathname === '/market/candles') data = { items: flatCandles };
    else if (url.pathname === '/market/ltp') data = { ltp: row._id === A._id ? 111 : 222 };
    else if (url.pathname === '/angel/orderbook') data = { data: [{ orderid: 'protective-A', orderstatus: 'complete', averageprice: 90 }] };
    else data = { status: true };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  config.API.ANGEL_ONE_API_BASE = `http://127.0.0.1:${server.address().port}`;
  budget.accounts.clear(); budget.global = []; budget.inFlight = 0;
  t.after(async () => {
    for (const runner of engine.runners.values()) runner.stop();
    engine.runners.clear();
    feeds.resetAccountSession();
    marketSession.stopMonitoring();
    for (const row of records) active.clearActiveAccount(row.userId, row._id);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    BrokerAccount.findOne = old.find; Trade.findOne = old.trade; Trade.findOneAndUpdate = old.update;
    Strategy.findOne = old.strategy; globalThis.WebSocket = old.socket;
    config.API.ANGEL_ONE_API_BASE = old.base; config.API.INTERNAL_SERVICE_KEY = old.key;
    require('../services/contractManager').cache.clear();
  });
  const a = await context.resolve(A.userId, A._id);
  const b = await context.resolve(B.userId, B._id);
  return { a, b, calls, state, records };
}
async function ready(ctx) { return context.run(ctx, () => feeds.ensureReady()); }
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('Phase 4 production: verified context survives real token/backfill/quote transport; forged ownership is denied', async t => {
  const { a, b, calls } = await fixture(t);
  const [sa, sb] = await Promise.all([ready(a), ready(b)]);
  assert.equal(sa.accountContext, a);
  assert.equal(sb.accountContext, b);
  assert.ok(sa.smartStream.ws instanceof Socket);
  await Promise.all([context.run(a, () => feeds.subscribe('NFO', '77', 'FIVE_MINUTE', null, { tradingsymbol: 'CLIENT-A-CE' })),
    context.run(b, () => feeds.subscribe('NFO', '77', 'FIVE_MINUTE', null, { tradingsymbol: 'CLIENT-B-CE' }))]);
  await Promise.all([sa.pollRestLtpFallback(), sb.pollRestLtpFallback()]);
  assert.equal(sa.getLtp('NFO', '77'), 111);
  assert.equal(sb.getLtp('NFO', '77'), 222);
  const count = calls.length;
  await assert.rejects(transport.requestPython('/market/ltp', { context: { ...a } }), /unavailable/);
  await assert.rejects(context.resolve(A.userId, B._id), { status: 404 });
  assert.equal(calls.length, count);
});

test('Phase 4 production: cold simultaneous Starts register listeners before contract discovery and run real plugins outside request scope', async t => {
  const { a, b, state } = await fixture(t);
  const entered = deferred(); const release = deferred();
  state.handler = async (_req, _res, url) => {
    if (url.pathname === '/market/index-ltp') { entered.resolve(); await release.promise; }
    return false;
  };
  const starts = [context.run(a, () => engine.startStrategy(a.userId, 'HeikenAshi', { underlying: 'NIFTY' })),
    context.run(b, () => engine.startStrategy(b.userId, 'HeikenAshi', { underlying: 'NIFTY' }))];
  await entered.promise;
  for (const service of feeds.accounts.values()) assert.equal(service.listenerCount('candle:closed'), 1);
  release.resolve(); await Promise.all(starts);
  const ra = engine.getRunner(`${a.userId}_HeikenAshi`);
  const rb = engine.getRunner(`${b.userId}_HeikenAshi`);
  const sa = feeds.accounts.get(`${a.userId}:${a.brokerAccountId}`);
  const sb = feeds.accounts.get(`${b.userId}:${b.brokerAccountId}`);
  // Exercise the production binary decoder, candle builder, router callback and plugin.
  for (const service of [sa, sb]) {
    const packet = Buffer.alloc(51); packet.writeInt8(2, 1); packet.write('77', 2);
    packet.writeInt32LE(10000, 43);
    packet.writeBigInt64LE(BigInt(Date.UTC(2026, 9, 5, 9)), 35);
    service.smartStream.ws.onmessage({ data: packet });
    packet.writeBigInt64LE(BigInt(Date.UTC(2026, 9, 5, 9, 5)), 35);
    service.smartStream.ws.onmessage({ data: packet });
  }
  await settle();
  assert.ok(ra.logs.some(log => JSON.stringify(log).includes('CANDLE EVALUATION')));
  assert.ok(rb.logs.some(log => JSON.stringify(log).includes('CANDLE EVALUATION')));
  assert.equal(ra.activeTradeId, null);
  assert.equal(rb.activeTradeId, null);
  let observed;
  const callback = () => { observed = context.current(); };
  context.run(a, () => feeds.on('candle:closed', callback));
  context.run(b, () => sa.emit('candle:closed', { ...sa.sessionIdentity }));
  await settle(); assert.equal(observed, a);
  feeds.removeListener('candle:closed', callback);
});

test('Phase 4 production: pending token initialization is cancelled by unsubscribe/reset and cannot reopen a retired feed', async t => {
  const { a, b, state } = await fixture(t);
  const entered = deferred(); const release = deferred();
  let enteredCount = 0;
  state.handler = async (_req, _res, url) => {
    if (url.pathname === '/angel/session-tokens') { if (++enteredCount === 2) entered.resolve(); await release.promise; }
    return false;
  };
  const pa = context.run(a, () => feeds.subscribe('NFO', '77', 'ONE_MINUTE', null, { role: 'position', tradingsymbol: 'A' }));
  const pb = context.run(b, () => feeds.subscribe('NFO', '77', 'ONE_MINUTE', null, { role: 'position', tradingsymbol: 'B' }));
  await entered.promise;
  const sa = feeds.accounts.get(`${a.userId}:${a.brokerAccountId}`);
  const sb = feeds.accounts.get(`${b.userId}:${b.brokerAccountId}`);
  context.run(a, () => feeds.unsubscribe('NFO', '77', 'ONE_MINUTE', 'position'));
  feeds.resetAccountSession(b.brokerAccountId);
  release.resolve(); await Promise.all([pa, pb]);
  assert.equal(sa.streamSubscribers.size, 0);
  assert.equal(sb.streamSubscribers.size, 0);
  assert.equal(sb.smartStream.ws, null);
});

test('Phase 4 production: delayed candle backfill cannot restore a removed builder', async t => {
  const { a, state } = await fixture(t); const service = await ready(a);
  const entered = deferred(); const release = deferred();
  state.handler = async (_req, _res, url) => {
    if (url.pathname === '/market/candles') { entered.resolve(); await release.promise; }
    return false;
  };
  const pending = context.run(a, () => feeds.subscribe('NFO', '77', 'FIVE_MINUTE', null, { tradingsymbol: 'A' }));
  await entered.promise;
  context.run(a, () => feeds.unsubscribe('NFO', '77', 'FIVE_MINUTE', 'scanner'));
  release.resolve(); await pending;
  assert.equal(service.candleBuilders.size, 0); assert.equal(service.streamSubscribers.size, 0);
});

test('Phase 4 production: retired-feed exit/Stop and failing socket cleanup clear runner state; protective fill releases held references', async t => {
  // Phase 5 requires a durable entry/position instead of an invented trade ID.
  const f = await require('./helpers/executionFixture').fixture(t);
  const a = f.contexts[0]; const runner = await f.runner(0, 'HeikenAshi', false);
  const contract = f.contract; const service = await ready(a);
  await runner.executeEntry(contract, 100, 'BULLISH');
  service.smartStream.ws.open(); service.smartStream.ws.failSend = true;
  await runner.executeExit(contract, 120, 'Target');
  assert.equal(runner.activeTradeId, null); assert.equal(runner.exitInProgress, false);
  assert.equal(service.streamSubscribers.size, 0); assert.equal(f.stores.Trade[0].exitPrice, 120);
  service.smartStream.ws.failSend = false;
  runner.config.liveTradingConsent = true;
  await runner.executeEntry(contract, 100, 'BULLISH');
  const protective = f.orders.get(a.brokerAccountId).find(order => order.ordertype === 'SL');
  protective.orderstatus = 'complete'; protective.filledshares = 10; protective.averageprice = 70;
  await new Promise(resolve => setTimeout(resolve, 1010));
  await runner.reconcileProtectiveOrder();
  assert.equal(service.streamSubscribers.size, 0);
  runner.config.liveTradingConsent = false;
  await runner.executeEntry(contract, 100, 'BULLISH');
  feeds.resetAccountSession(a.brokerAccountId);
  await runner.executeExit(contract, 120, 'Target');
  assert.equal(runner.activeTradeId, null); assert.equal(runner.exitInProgress, false);
  runner.ceContract = contract; runner.stop();
  assert.equal(runner.activeTradeId, null); assert.equal(runner.isRunning, false);
});

test('Phase 4 production: background health and subscribe share the per-account request guard', async t => {
  const { a, calls, state } = await fixture(t); const service = await ready(a);
  service.lastSessionCheckAt = 0;
  const entered = deferred(); const release = deferred();
  state.handler = async (_req, _res, url, row) => {
    if (url.pathname === '/angel/status' && row._id === A._id) { entered.resolve(); await release.promise; }
    return false;
  };
  const background = feeds.autoInitSession(); await entered.promise;
  const start = calls.filter(call => call.url.pathname === '/angel/session-tokens' && call.headers['x-broker-account-id'] === A._id).length;
  const subscribe = context.run(a, () => feeds.subscribe('NFO', '77', 'ONE_MINUTE', null, { role: 'position', tradingsymbol: 'A' }));
  await settle();
  assert.equal(calls.filter(call => call.url.pathname === '/angel/session-tokens' && call.headers['x-broker-account-id'] === A._id).length, start);
  release.resolve(); await Promise.all([background, subscribe]);
  assert.equal(calls.filter(call => call.url.pathname === '/angel/session-tokens' && call.headers['x-broker-account-id'] === A._id).length, start + 1);
});

test('Phase 4 production: real HTTP 429/503 and timeout back off only A; fallback instrument and bounded transport remain correct', async t => {
  const { a, b, state, calls } = await fixture(t);
  const warnings = t.mock.method(console, 'warn', () => {});
  const [sa, sb] = await Promise.all([ready(a), ready(b)]);
  for (const [ctx, symbol] of [[a, 'A-OPT'], [b, 'B-OPT']]) await context.run(ctx, () => feeds.subscribe('NFO', '77', 'ONE_MINUTE', null, { role: 'position', tradingsymbol: symbol }));
  let status = 429;
  state.handler = async (_req, res, url, row) => {
    if (url.pathname === '/market/ltp' && row._id === A._id) {
      res.statusCode = status; res.setHeader('Retry-After', '10'); res.end('{"detail":"test failure"}'); return true;
    }
    return false;
  };
  await Promise.all([sa.pollRestLtpFallback(), sb.pollRestLtpFallback()]);
  const quotes = calls.filter(call => call.url.pathname === '/market/ltp');
  assert.equal(quotes.find(call => call.headers['x-broker-account-id'] === A._id).url.searchParams.get('tradingsymbol'), 'A-OPT');
  assert.equal(quotes[0].url.searchParams.get('exchange'), 'NFO');
  assert.equal(quotes[0].url.searchParams.get('symboltoken'), '77');
  assert.ok(sa.fallbackBackoffUntil >= Date.now() + 9000); assert.equal(sb.getLtp('NFO', '77'), 222);
  await sa.pollRestLtpFallback(); assert.equal(calls.filter(call => call.url.pathname === '/market/ltp').length, 2);
  sa.fallbackBackoffUntil = 0; status = 503; await sa.pollRestLtpFallback(); assert.ok(sa.fallbackBackoffUntil > Date.now());
  state.handler = async (_req, res, url, row) => {
    if (url.pathname === '/market/ltp' && row._id === A._id) { await new Promise(resolve => setTimeout(resolve, 100)); res.end('{}'); return true; }
    return false;
  };
  await assert.rejects(transport.requestPython('/market/ltp?exchange=NFO&tradingsymbol=A-OPT&symboltoken=77', { context: a, timeoutMs: 20 }), { name: 'AbortError' });
  assert.ok(warnings.mock.calls.some(call => call.arguments[0].includes('(429)')));
  assert.ok(warnings.mock.calls.some(call => call.arguments[0].includes('(503)')));
});

test('Phase 4: account/global quote budgets bound rate and concurrency without retaining idle accounts', () => {
  const { MarketRequestBudget } = budget;
  const limiter = new MarketRequestBudget({ accountLimit: 1, globalLimit: 2, windowMs: 1000 });
  const a = limiter.acquire('A', 0); assert.equal(limiter.acquire('A', 0), null);
  const b = limiter.acquire('B', 0); assert.equal(limiter.acquire('C', 0), null);
  a(); a(); b(); assert.equal(limiter.inFlight, 0);
  assert.equal(limiter.acquire('A', 500), null);
  const c = limiter.acquire('C', 1001); assert.ok(c); c();
  assert.equal(limiter.accounts.has('A'), false);
  const reserved = new MarketRequestBudget();
  const releases = Array.from({ length: 3 }, () => reserved.acquire('A', 0, true));
  assert.equal(reserved.acquire('A', 0, true), null);
  const monitor = reserved.acquire('A', 0); assert.ok(monitor);
  releases.forEach(release => release()); monitor();
});

test('Phase 4 production: cold Start fails closed on unavailable tokens, and Stop cancels delayed startup', async t => {
  const { a, b, state } = await fixture(t);
  const entered = deferred(); const release = deferred();
  state.handler = async (_req, res, url, row) => {
    if (url.pathname === '/angel/session-tokens' && row._id === A._id) {
      res.statusCode = 503; res.end('{}'); return true;
    }
    if (url.pathname === '/angel/session-tokens' && row._id === B._id) { entered.resolve(); await release.promise; }
    return false;
  };
  await assert.rejects(context.run(a, () => engine.startStrategy(a.userId, 'HeikenAshi', {})), /feed is unavailable/);
  const ra = engine.getRunner(`${a.userId}_HeikenAshi`);
  assert.equal(ra.isRunning, false); assert.ok(ra.candleListener == null);
  assert.equal(ra.contractInterval, null); assert.equal(ra.heartbeatInterval, null);
  const pending = context.run(b, () => engine.startStrategy(b.userId, 'HeikenAshi', {}));
  await entered.promise;
  engine.stopStrategy(b.userId, 'HeikenAshi'); release.resolve(); await pending;
  const rb = engine.getRunner(`${b.userId}_HeikenAshi`);
  assert.equal(rb.isRunning, false); assert.ok(rb.candleListener == null);
  assert.equal(rb.contractInterval, null); assert.equal(rb.heartbeatInterval, null);
});

test('Phase 4 production: old socket/candle callbacks and old cleanup cannot affect the replacement session', async t => {
  const { a, b, records } = await fixture(t);
  const sa = await ready(a); const sb = await ready(b);
  const oldMessage = sa.smartStream.ws.onmessage;
  let candles = 0; context.run(a, () => feeds.on('candle:closed', () => { candles++; }));
  records[0].sessionGeneration = 2;
  active.setActiveAccount({ userId: a.userId, brokerAccountId: a.brokerAccountId,
    clientCode: a.brokerClientIdentity, sessionGeneration: 2, ownerGeneration: 0, sessionId: a.sessionId });
  const next = await context.resolve(a.userId, a.brokerAccountId);
  const replacement = await context.run(next, () => feeds._service());
  assert.equal(sa.destroyed, true); assert.notEqual(replacement, sa);
  const packet = Buffer.alloc(51); packet.writeInt8(2, 1); packet.write('77', 2); packet.writeInt32LE(99900, 43);
  oldMessage({ data: packet });
  sa.emit('candle:closed', { ...sa.sessionIdentity }); await settle();
  assert.equal(candles, 0); assert.equal(replacement.getLtp('NFO', '77'), null);
  context.run(a, () => feeds.unsubscribe('NFO', '77', 'ONE_MINUTE', 'position'));
  assert.equal(feeds.accounts.get(`${a.userId}:${a.brokerAccountId}`), replacement);
  assert.equal(sb.destroyed, false);
});

test('Phase 4 production: real quote transport enforces the account budget and A saturation leaves B operational', async t => {
  const { a, b, calls, state } = await fixture(t);
  const entered = deferred(); const release = deferred(); let count = 0;
  state.handler = async (_req, _res, url, row) => {
    if (url.pathname === '/market/ltp' && row._id === A._id) {
      if (++count === 4) entered.resolve(); await release.promise;
    }
    return false;
  };
  const reads = Array.from({ length: 4 }, () => transport.requestPython('/market/ltp', { context: a }));
  await entered.promise;
  await assert.rejects(transport.requestPython('/market/ltp', { context: a }), { status: 429 });
  assert.equal(calls.filter(call => call.headers['x-broker-account-id'] === A._id).length, 4);
  const result = await transport.requestPython('/market/ltp', { context: b }); assert.equal(result.data.ltp, 222);
  release.resolve(); await Promise.all(reads);
  assert.equal(budget.inFlight, 0);
});

test('Phase 4 production: fallback transport timeout logs/backoffs A, releases its budget, and B keeps polling', async t => {
  const { a, b, state } = await fixture(t);
  const warnings = t.mock.method(console, 'warn', () => {});
  const [sa, sb] = await Promise.all([ready(a), ready(b)]);
  for (const [ctx, symbol] of [[a, 'A'], [b, 'B']]) await context.run(ctx, () => feeds.subscribe('NFO', '77', 'ONE_MINUTE', null, { role: 'position', tradingsymbol: symbol }));
  const release = deferred();
  state.handler = async (_req, res, url, row) => {
    if (url.pathname === '/market/ltp' && row._id === A._id) {
      await release.promise; res.end('{}'); return true;
    }
    return false;
  };
  await Promise.all([sa.pollRestLtpFallback(), sb.pollRestLtpFallback()]);
  release.resolve();
  assert.ok(sa.fallbackBackoffUntil > Date.now());
  assert.equal(sa.getLtp('NFO', '77'), null); assert.equal(sb.getLtp('NFO', '77'), 222);
  assert.equal(budget.inFlight, 0);
  assert.ok(warnings.mock.calls.some(call => call.arguments[0].includes('(transport)')));
});

test('Phase 4 production: immediate unsubscribe cancels a router reservation before database validation completes', async t => {
  const { a } = await fixture(t); const service = await ready(a);
  const pending = context.run(a, () => {
    const request = feeds.subscribe('NFO', '77', 'ONE_MINUTE', null, { role: 'position', tradingsymbol: 'A' });
    feeds.unsubscribe('NFO', '77', 'ONE_MINUTE', 'position');
    return request;
  });
  await pending;
  assert.equal(service.streamSubscribers.size, 0); assert.equal(feeds.pendingRoutes.size, 0);
});

test('Phase 4 production: context-bound gap candles retain synchronous baseline delivery and historical candle semantics', async t => {
  const { a } = await fixture(t); const service = await ready(a);
  await context.run(a, () => feeds.subscribe('NFO', '77', 'ONE_MINUTE', null, { tradingsymbol: 'A' }));
  const snapshots = [];
  const listener = event => {
    assert.equal(context.current(), a);
    snapshots.push({ candle: { ...event.candle }, count: feeds.getBuffer('NFO', '77', 'ONE_MINUTE').length });
  };
  context.run(a, () => feeds.on('candle:closed', listener));
  const count = service.getBuffer('NFO', '77', 'ONE_MINUTE').length;
  service.handleTick({ token: '77', exchangeType: 2, ltp: 100, timestamp: 60000 });
  service.handleTick({ token: '77', exchangeType: 2, ltp: 105, timestamp: 70000 });
  service.handleTick({ token: '77', exchangeType: 2, ltp: 110, timestamp: 240000 });
  assert.deepEqual(snapshots.map(item => item.count), [count + 1, count + 2, count + 3]);
  assert.deepEqual(snapshots.map(item => item.candle), [
    { time: 60, open: 100, high: 105, low: 100, close: 105 },
    { time: 120, open: 105, high: 105, low: 105, close: 105 },
    { time: 180, open: 105, high: 105, low: 105, close: 105 },
  ]);
  feeds.removeListener('candle:closed', listener);
});
