const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
process.env.INTERNAL_SERVICE_KEY = 'test-internal-key';
const accounts = require('../services/accountContext');
const active = require('../services/activeAccountService');
const BrokerAccount = require('../models/BrokerAccount');
const { requestPython } = require('../services/pythonApiClient');
const candleCache = require('../services/candleCache');
const A = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: '111111111111111111111111', brokerClientId: 'CLIENT-A', sessionGeneration: 1, ownerGeneration: 0, version: 0, status: 'CONNECTED' };
const B = { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', userId: '222222222222222222222222', brokerClientId: 'CLIENT-B', sessionGeneration: 1, ownerGeneration: 0, status: 'CONNECTED' };
function fixtures(t) {
  const originalFind = BrokerAccount.findOne;
  const originalFetch = global.fetch;
  const records = [structuredClone(A), structuredClone(B)];
  active.clearActiveAccount(A.userId, A._id);
  active.clearActiveAccount(B.userId, B._id);
  BrokerAccount.findOne = query => ({ lean: async () => structuredClone(records.find(record =>
    (!query.userId || String(record.userId) === String(query.userId)) && (!query._id || record._id === String(query._id))
    && (!query.brokerClientId || record.brokerClientId === query.brokerClientId)) || null) });
  active.setActiveAccount({ userId: A.userId, clientCode: A.brokerClientId, brokerAccountId: A._id, sessionGeneration: 1, ownerGeneration: 0, sessionId: 'session-A' });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('/internal/execution-fence') ? { accepted: true, ownerGeneration: JSON.parse(options.body).generation }
      : url.endsWith('/angel/orderbook') ? { data: [{ orderid: 'order-A', variety: 'NORMAL' }] }
      : url.endsWith('/angel/positions') ? { data: [{ exchange: 'NFO', tradingsymbol: 'OPT-A', symboltoken: '7', producttype: 'INTRADAY', netqty: '10' }] }
        : { status: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => { BrokerAccount.findOne = originalFind; global.fetch = originalFetch;
    active.clearActiveAccount(A.userId, A._id); active.clearActiveAccount(B.userId, B._id); candleCache.clear(); });
  return { records, calls };
}

test('default resolution is server-owned; known foreign account selectors are denied', async t => {
  fixtures(t);
  const context = await accounts.resolve(A.userId);
  assert.equal(context.brokerAccountId, A._id);
  assert.ok(Object.isFrozen(context));
  await assert.rejects(accounts.resolve(A.userId, B._id), { status: 404 });
  await assert.rejects(accounts.resolve(B.userId, A._id), { status: 404 });
  await assert.rejects(accounts.resolve(B.userId), { code: 'INACTIVE_BROKER_ACCOUNT' });
});

test('missing/forged and stale session contexts fail before broker dispatch', async t => {
  const { records, calls } = fixtures(t);
  await assert.rejects(requestPython('/angel/profile'), { code: 'BROKER_CONTEXT_REQUIRED' });
  await assert.rejects(requestPython('/angel/profile', { context: { ...A } }), { code: 'BROKER_CONTEXT_REQUIRED' });
  const context = await accounts.resolve(A.userId);
  records[0].sessionGeneration += 1;
  await assert.rejects(requestPython('/angel/profile', { context }), /Stale/);
  assert.equal(calls.length, 0);
});

test('transport writes only verified owner/account/session headers and background work retains them', async t => {
  const { calls } = fixtures(t);
  const context = await accounts.resolve(A.userId);
  await accounts.run(context, () => new Promise((resolve, reject) => setImmediate(() => requestPython('/market/ltp').then(resolve, reject))));
  assert.equal(calls[0].options.headers['X-Active-User-Id'], A.userId);
  assert.equal(calls[0].options.headers['X-Broker-Account-Id'], A._id);
  assert.equal(calls[0].options.headers['X-Broker-Session-Id'], 'session-A');
  assert.equal(calls[0].options.headers['X-Session-Generation'], '1');
  assert.equal(calls[0].options.headers['X-Internal-Service-Key'], 'test-internal-key');
});

test('owner generation changes and disabled accounts invalidate background contexts', async t => {
  const { records } = fixtures(t);
  const context = await accounts.resolve(A.userId);
  records[0].ownerGeneration++;
  await assert.rejects(accounts.validate(context), /Stale/);
  records[0].ownerGeneration = 0;
  records[0].status = 'DISABLED';
  await assert.rejects(accounts.validate(context), { status: 404 });
});

test('cancel validates account orderbook before mutation; foreign order IDs never reach cancel', async t => {
  const { calls } = fixtures(t);
  const context = await accounts.resolve(A.userId);
  await assert.rejects(requestPython('/angel/orders/order-B/cancel?ignored=1', { method: 'POST', context, body: { variety: 'NORMAL' } }), { status: 404 });
  assert.equal(calls.length, 1);
  await requestPython('/angel/orders/order-A/cancel', { method: 'POST', context, body: { variety: 'NORMAL' } });
  assert.ok(calls.at(-1).url.endsWith('/order-A/cancel'));
});

test('exit verifies instrument/product/direction/quantity against account positions', async t => {
  const { calls } = fixtures(t);
  const context = await accounts.resolve(A.userId);
  const body = { exchange: 'NFO', tradingsymbol: 'OPT-A', symboltoken: '7', producttype: 'INTRADAY', quantity: 10, transactiontype: 'SELL' };
  for (const changes of [{ tradingsymbol: 'OPT-B' }, { quantity: 11 }, { transactiontype: 'BUY' }, { producttype: 'DELIVERY' }]) {
    await assert.rejects(requestPython('/angel/positions/exit', { context, method: 'POST', body: { ...body, ...changes } }), { status: 404 });
  }
  assert.equal(calls.filter(call => call.url.endsWith('/exit')).length, 0);
  await requestPython('/angel/positions/exit', { context, method: 'POST', body });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), body);
});

test('candle cache keys include account and session; cached A data is absent for B', async t => {
  fixtures(t);
  const a = accounts.mint(A, 'session-A');
  const b = accounts.mint(B, 'session-B');
  accounts.run(a, () => candleCache.set('NIFTY', '2026-10-05', '5m', [{ close: 10 }]));
  assert.equal(accounts.run(b, () => candleCache.get('NIFTY', '2026-10-05', '5m')), null);
  assert.equal(accounts.run(accounts.mint({ ...A, sessionGeneration: 2 }, 'new-session'), () => candleCache.get('NIFTY', '2026-10-05', '5m')), null);
});

test('connect/reconnect admission is serialized and errors release the queue', async () => {
  const events = [];
  let release;
  const first = accounts.exclusive('test-connect', async () => { events.push('first'); await new Promise(resolve => { release = resolve; }); throw new Error('fake failure'); });
  await new Promise(resolve => setImmediate(resolve));
  const second = accounts.exclusive('test-connect', async () => events.push('second'));
  assert.deepEqual(events, ['first']);
  release();
  await assert.rejects(first, /fake failure/);
  await second;
  assert.deepEqual(events, ['first', 'second']);
});

function loadProxy(t) {
  const filename = require.resolve('../controllers/brokerProxyController');
  const original = Module._load;
  const prior = require.cache[filename];
  delete require.cache[filename];
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === filename && name === '../services/strategyEngine') return { runners: new Map(), assertAccountCanSwitch: async () => {} };
    return original.call(this, name, parent, isMain);
  };
  const proxy = require(filename);
  Module._load = original;
  t.after(() => { if (prior) require.cache[filename] = prior; else delete require.cache[filename]; });
  return proxy;
}
function response() { return { statusCode: null, data: null, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } }; }

test('broker status for B never queries or reveals A connection', async t => {
  const { calls } = fixtures(t);
  const proxy = loadProxy(t);
  const res = response();
  await proxy.status({ user: { _id: B.userId }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.connected, false);
  assert.equal(res.data.clientCode, null);
  assert.equal(res.data.activeUserId, undefined);
  assert.equal(calls.length, 0);
});

test('B login uses its own Python account context and leaves A session untouched', async t => {
  const { calls, records } = fixtures(t);
  const proxy = loadProxy(t);
  const originals = { reserve: BrokerAccount.findOneAndUpdate, update: BrokerAccount.updateOne,
    exposure: accounts.assertNoForeignExposure, indexes: accounts.verifyOwnershipIndexes };
  t.after(() => { BrokerAccount.findOneAndUpdate = originals.reserve; BrokerAccount.updateOne = originals.update;
    accounts.assertNoForeignExposure = originals.exposure; accounts.verifyOwnershipIndexes = originals.indexes; });
  accounts.assertNoForeignExposure = async () => {};
  accounts.verifyOwnershipIndexes = async () => {};
  BrokerAccount.findOneAndUpdate = (query, update) => ({ lean: async () => {
    const record = records.find(value => value._id === String(query._id) && value.sessionGeneration === query.sessionGeneration);
    if (!record) return null;
    Object.assign(record, update.$set);
    for (const [key, value] of Object.entries(update.$inc || {})) record[key] = (record[key] || 0) + value;
    return structuredClone(record);
  } });
  BrokerAccount.updateOne = async (query, update) => {
    const record = records.find(value => value._id === String(query._id) && value.sessionGeneration === query.sessionGeneration);
    if (!record) return { modifiedCount: 0 };
    Object.assign(record, update.$set);
    for (const [key, value] of Object.entries(update.$inc || {})) record[key] = (record[key] || 0) + value;
    return { modifiedCount: 1 };
  };
  global.fetch = async (_url, options) => ({ ok: true, status: 200, headers: new Headers(),
    text: async () => JSON.stringify({ status: true, client_code: 'CLIENT-B', session_id: 'session-B-2' }) });
  const res = response();
  await proxy.login({ user: { _id: B.userId }, body: { clientCode: 'CLIENT-B' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(active.getActiveAccount(A.userId, A._id).userId, A.userId);
  assert.equal(active.getActiveAccount(B.userId, B._id).userId, B.userId);
  assert.equal(calls.length, 0); // global.fetch was replaced for this login
});

test('forged selectors are rejected by middleware before chart/cache handlers', async t => {
  fixtures(t);
  let handlerReached = false;
  let error;
  await accounts.middleware({ user: { _id: A.userId }, query: { brokerAccountId: B._id } }, {}, err => { error = err; if (!err) handlerReached = true; });
  assert.equal(error.status, 404);
  assert.equal(handlerReached, false);
});

test('a disconnected second user still cannot claim A real broker client ID', async t => {
  const { calls } = fixtures(t);
  const originalExposure = accounts.assertNoForeignExposure;
  accounts.assertNoForeignExposure = async () => {};
  t.after(() => { accounts.assertNoForeignExposure = originalExposure; });
  active.clearActiveAccount();
  const proxy = loadProxy(t);
  const res = response();
  await proxy.login({ user: { _id: '333333333333333333333333' }, body: { clientCode: ' client-a ' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('connection fails closed when required unique ownership indexes are absent', async t => {
  const original = BrokerAccount.collection.indexes;
  t.after(() => { BrokerAccount.collection.indexes = original; });
  BrokerAccount.collection.indexes = async () => [{ key: { _id: 1 }, name: '_id_' }];
  await assert.rejects(accounts.verifyOwnershipIndexes(), /indexes/);
  BrokerAccount.collection.indexes = async () => [
    { key: { userId: 1, broker: 1 }, unique: true },
    { key: { broker: 1, brokerClientId: 1 }, unique: true },
  ];
  await accounts.verifyOwnershipIndexes();
});

test('expired JWT and refresh tokens cannot reach account dispatch; body userId is not authority', async t => {
  fixtures(t);
  const User = require('../models/User');
  const jwt = require('jsonwebtoken');
  const originalFind = User.findById;
  const filename = require.resolve('../controllers/authController');
  const prior = require.cache[filename];
  const previousSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = 'phase2-test-jwt-secret';
  delete require.cache[filename];
  const auth = require(filename);
  User.findById = async id => ({ _id: id });
  t.after(() => { User.findById = originalFind; if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previousSecret; if (prior) require.cache[filename] = prior; else delete require.cache[filename]; });
  for (const payload of [{ id: A.userId, exp: 1 }, { id: A.userId, type: 'refresh' }]) {
    const res = response();
    let reached = false;
    await auth.protect({ headers: { authorization: `Bearer ${jwt.sign(payload, process.env.JWT_ACCESS_SECRET)}` } }, res, () => { reached = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(reached, false);
  }
  const req = { headers: { authorization: `Bearer ${jwt.sign({ id: A.userId, type: 'access' }, process.env.JWT_ACCESS_SECRET)}` }, body: { userId: B.userId }, query: {} };
  let authenticated = false;
  await auth.protect(req, response(), () => { authenticated = true; });
  assert.ok(authenticated);
  await accounts.middleware(req, response(), err => { assert.equal(err, undefined); assert.equal(accounts.current().userId, A.userId); });
});

function loadEngineFixture(t, tradeModel) {
  const { EventEmitter } = require('node:events');
  const filename = require.resolve('../services/strategyEngine');
  const original = Module._load;
  const prior = require.cache[filename];
  const market = new EventEmitter();
  market.unsubscribe = () => {};
  const mocks = { '../models/Trade': tradeModel, '../models/Strategy': { findOne: async () => ({ _id: 'strategy-A' }) },
    './contractManager': {}, './marketDataService': market, './orderUpdateService': new EventEmitter(),
    './marketSessionManager': { startMonitoring() {} }, './notificationService': { notifyUrgent: async () => {} },
    './strategyRegistry': { init: async () => {}, getPlugin: () => null } };
  delete require.cache[filename];
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === filename && Object.hasOwn(mocks, name)) return mocks[name];
    return original.call(this, name, parent, isMain);
  };
  let manager;
  try { manager = require(filename); } finally { Module._load = original; }
  t.after(() => { if (prior) require.cache[filename] = prior; else delete require.cache[filename]; });
  return manager;
}

test('managed PAPER entry/exit retains quantity and thresholds while persisting account ownership', async t => {
  const { calls } = fixtures(t);
  const context = await accounts.resolve(A.userId);
  const mongoose = require('mongoose');
  const model = require('../models/Trade');
  const strategy = require('../models/Strategy');
  const stores = require('./helpers/mongooseMemory').collections(t, [model, strategy, require('../models/Position'), require('../models/OrderIntent'), require('../models/ExecutionLease')],
    { Strategy: [{ _id: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(A.userId), name: 'HeikenAshi' }] });
  const manager = loadEngineFixture(t, model);
  const runner = manager.getRunner(`${A.userId}_HeikenAshi`);
  runner.userId = A.userId;
  runner.accountContext = context;
  runner.brokerReady = true;
  runner.isRunning = true;
  runner.config = { underlying: 'NIFTY', liveTradingConsent: false, targetPoints: 20, slPoints: 30 };
  const originalInterval = global.setInterval;
  let monitor;
  global.setInterval = callback => { monitor = callback; return { fakeInterval: true }; };
  t.after(() => { global.setInterval = originalInterval; });
  const contract = { exchange: 'NFO', tradingsymbol: 'OPT-A', symboltoken: '7' };
  await runner.executeEntry(contract, 100, 'CE');
  let saved = stores.Trade[0];
  assert.equal(String(saved.brokerAccountId), A._id);
  assert.equal(String(saved.userId), A.userId);
  assert.equal(saved.executionMode, 'PAPER');
  assert.equal(saved.qty, 65);
  assert.equal(runner.entryPrice, 100);
  assert.equal(runner.config.slPoints, 30);
  assert.equal(runner.config.targetPoints, 20);
  global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, text: async () => JSON.stringify({ ltp: 120, quoteTimestamp: Date.now() }) }; };
  await accounts.run(context, monitor);
  saved = stores.Trade[0];
  assert.equal(saved.exitPrice, 120);
  assert.equal(saved.pnl, 1300);
  assert.ok(stores.TradeControl.reads.every(query => String(query.userId) === A.userId && String(query.brokerAccountId) === A._id));
  assert.equal(calls.filter(call => call.url.includes('/market/ltp')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/internal/execution-fence')).length, 1);
  assert.ok(calls.some(call => call.url.includes('/market/ltp')));
});

test('manual strategy exit cannot use a foreign trade ID even in an owned runner', async t => {
  fixtures(t);
  const context = await accounts.resolve(A.userId);
  const queries = [];
  const manager = loadEngineFixture(t, { findOne: async query => { queries.push(query); return null; } });
  const runner = manager.getRunner(`${A.userId}_HeikenAshi`);
  runner.accountContext = context;
  runner.userId = A.userId;
  runner.activeTradeId = 'foreign-trade';
  await accounts.run(context, () => assert.rejects(manager.manualExitStrategy(A.userId, 'HeikenAshi'), { status: 404 }));
  assert.equal(queries[0].brokerAccountId, A._id);
  assert.equal(queries[0].userId, A.userId);
});

test('manual exit with no held position preserves its existing harmless status response', async t => {
  fixtures(t);
  const context = await accounts.resolve(A.userId);
  const manager = loadEngineFixture(t, { findOne: async () => { throw new Error('No trade lookup is needed'); } });
  const runner = manager.getRunner(`${A.userId}_HeikenAshi`);
  const expected = runner.getStatus();
  assert.deepEqual(await accounts.run(context, () => manager.manualExitStrategy(A.userId, 'HeikenAshi')), expected);
});

test('LIVE exit rejects missing or mismatched held instrument before any broker mutation', async t => {
  const { calls } = fixtures(t);
  const context = await accounts.resolve(A.userId);
  const manager = loadEngineFixture(t, { findOne: async () => ({ _id: 'trade-A', premium: 'OPT-A' }) });
  const runner = manager.getRunner(`${A.userId}_HeikenAshi`);
  runner.userId = A.userId;
  runner.accountContext = context;
  runner.activeTradeId = 'trade-A';
  runner.activeTradePremium = 'OPT-A';
  runner.config = { liveTradingConsent: true };
  for (const contract of [null, { tradingsymbol: 'OPT-B' }]) {
    await assert.rejects(runner.executeExit(contract, 100, 'Manual'), { status: 409 });
  }
  assert.equal(runner.activeTradeId, 'trade-A');
  assert.equal(calls.length, 0);
});

test('simultaneous same-account logins dispatch sequentially and advance verified generations', async t => {
  const { records } = fixtures(t);
  active.clearActiveAccount();
  const proxy = loadProxy(t);
  const originals = { reserve: BrokerAccount.findOneAndUpdate, update: BrokerAccount.updateOne,
    exposure: accounts.assertNoForeignExposure, indexes: accounts.verifyOwnershipIndexes };
  t.after(() => { BrokerAccount.findOneAndUpdate = originals.reserve; BrokerAccount.updateOne = originals.update;
    accounts.assertNoForeignExposure = originals.exposure; accounts.verifyOwnershipIndexes = originals.indexes; });
  accounts.assertNoForeignExposure = async () => {};
  accounts.verifyOwnershipIndexes = async () => {};
  BrokerAccount.findOneAndUpdate = (query, update) => ({ lean: async () => {
    const record = records.find(value => value._id === String(query._id) && value.sessionGeneration === query.sessionGeneration);
    if (!record) return null;
    Object.assign(record, update.$set);
    for (const [key, value] of Object.entries(update.$inc || {})) record[key] = (record[key] || 0) + value;
    return structuredClone(record);
  } });
  BrokerAccount.updateOne = async (query, update) => {
    const record = records.find(value => value._id === String(query._id) && value.sessionGeneration === query.sessionGeneration);
    if (!record) return { modifiedCount: 0 };
    Object.assign(record, update.$set);
    for (const [key, value] of Object.entries(update.$inc || {})) record[key] = (record[key] || 0) + value;
    return { modifiedCount: 1 };
  };
  let release;
  let count = 0;
  global.fetch = async (_url, options) => {
    count++;
    if (count === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ status: true,
      client_code: 'CLIENT-A', session_id: `session-${options.headers['X-Session-Generation']}` }) };
  };
  const req = { user: { _id: A.userId }, body: { clientCode: 'CLIENT-A', apiKey: 'fake', mpin: '1111', totpSecret: 'fake' }, query: {} };
  const firstRes = response();
  const secondRes = response();
  const first = proxy.login(req, firstRes);
  await new Promise(resolve => setImmediate(resolve));
  const second = proxy.login(req, secondRes);
  assert.equal(count, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(firstRes.statusCode, 200);
  assert.equal(secondRes.statusCode, 200);
  assert.equal(count, 2);
  assert.equal(active.getActiveAccount().sessionGeneration, 3);
  assert.equal(active.getActiveAccount().sessionId, 'session-3');
  assert.equal(accounts.assertAdmission(B.userId, B.brokerClientId).userId, B.userId);
});

for (const unknown of [false, true]) {
  test(unknown ? 'unknown login outcome consumes the candidate generation and fails closed' : 'definitive failed reconnect preserves the existing verified session without decreasing generation', async t => {
    const { records } = fixtures(t);
    const proxy = loadProxy(t);
    const originals = { reserve: BrokerAccount.findOneAndUpdate, update: BrokerAccount.updateOne,
      exposure: accounts.assertNoForeignExposure, indexes: accounts.verifyOwnershipIndexes };
    t.after(() => { BrokerAccount.findOneAndUpdate = originals.reserve; BrokerAccount.updateOne = originals.update;
      accounts.assertNoForeignExposure = originals.exposure; accounts.verifyOwnershipIndexes = originals.indexes; });
    accounts.assertNoForeignExposure = async () => {};
    accounts.verifyOwnershipIndexes = async () => {};
    BrokerAccount.findOneAndUpdate = (_query, update) => ({ lean: async () => {
      Object.assign(records[0], update.$set);
      records[0].version++;
      return structuredClone(records[0]);
    } });
    BrokerAccount.updateOne = async (_query, update) => {
      Object.assign(records[0], update.$set);
      for (const [key, value] of Object.entries(update.$inc || {})) records[0][key] += value;
      return { modifiedCount: 1 };
    };
    global.fetch = async () => {
      if (unknown) throw Object.assign(new Error('fake timeout'), { name: 'AbortError' });
      return { ok: false, status: 429, headers: new Headers(), text: async () => JSON.stringify({ detail: 'Rate limited' }) };
    };
    const res = response();
    await proxy.login({ user: { _id: A.userId }, body: { clientCode: 'CLIENT-A' }, query: {} }, res);
    if (unknown) {
      assert.equal(res.statusCode, 504);
      assert.equal(records[0].sessionGeneration, 2);
      assert.equal(records[0].status, 'SERVICE_UNAVAILABLE');
      assert.equal(active.getActiveAccount(), null);
    } else {
      assert.equal(res.statusCode, 429);
      assert.equal(records[0].sessionGeneration, 1);
      assert.equal(records[0].status, 'CONNECTED');
      assert.equal((await accounts.resolve(A.userId)).sessionId, 'session-A');
    }
  });
}

test('one broker session loss changes only runners owned by that broker account', t => {
  const manager = loadEngineFixture(t, { findOne: async () => null });
  const runnerA = manager.getRunner(`${A.userId}_HeikenAshi`);
  const runnerB = manager.getRunner(`${B.userId}_HeikenAshi`);
  runnerA.accountContext = accounts.mint(A, 'session-A');
  runnerB.accountContext = accounts.mint(B, 'session-B');
  runnerA.brokerReady = runnerB.brokerReady = true;
  manager.handleBrokerSessionLost('expired A session', A._id);
  assert.equal(runnerA.brokerReady, false);
  assert.equal(runnerB.brokerReady, true);
});

test('Phase 4 enables User A strategy start while User B remains connected', async t => {
  fixtures(t);
  const startupRecovery = require('../services/startupRecovery');
  const originalRecoveryGate = startupRecovery.assertStrategyStartAllowed;
  const strategySettingsService = require('../services/strategySettingsService');
  const originalSettingsSave = strategySettingsService.save;
  startupRecovery.assertStrategyStartAllowed = async () => {};
  strategySettingsService.save = async () => ({});
  t.after(() => { startupRecovery.assertStrategyStartAllowed = originalRecoveryGate; strategySettingsService.save = originalSettingsSave; });
  active.setActiveAccount({ userId: A.userId, clientCode: A.brokerClientId, brokerAccountId: A._id,
    sessionGeneration: 1, ownerGeneration: 0, sessionId: 'session-A' });
  active.setActiveAccount({ userId: B.userId, clientCode: B.brokerClientId, brokerAccountId: B._id,
    sessionGeneration: 1, ownerGeneration: 0, sessionId: 'session-B' });
  const startedUsers = [];
  const filename = require.resolve('../controllers/strategyController');
  const originalLoad = Module._load;
  const prior = require.cache[filename];
  const engine = { startStrategy: async userId => { startedUsers.push(userId); return {}; } };
  delete require.cache[filename];
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === filename && name === '../services/strategyEngine') return engine;
    if (parent?.filename === filename && name === '../services/strategyRegistry') return { init: async () => {}, hasPlugin: () => true };
    if (parent?.filename === filename && name === '../services/startupRecovery') return { assertStrategyStartAllowed: async () => {} };
    return originalLoad.call(this, name, parent, isMain);
  };
  let controller;
  try { controller = require(filename); } finally { Module._load = originalLoad; }
  t.after(() => { if (prior) require.cache[filename] = prior; else delete require.cache[filename]; });
  const resA = response();
  const resB = response();
  await controller.startStrategy({ user: { _id: A.userId }, accountContext: { brokerAccountId: A._id },
    params: { strategyName: 'HeikenAshi' }, body: {} }, resA);
  await controller.startStrategy({ user: { _id: B.userId }, accountContext: { brokerAccountId: B._id },
    params: { strategyName: 'HeikenAshi' }, body: {} }, resB);
  assert.equal(resA.statusCode, 200, JSON.stringify(resA.body));
  assert.equal(resB.statusCode, 200, JSON.stringify(resB.body));
  assert.deepEqual(startedUsers, [A.userId, B.userId]);
});
