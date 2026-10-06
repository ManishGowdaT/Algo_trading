'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionConfig, isPrivateHost, redact, audit } = require('../services/productionHardening');
const { OperationalWatchdog } = require('../services/operationalWatchdog');
const { offboardAccount } = require('../services/accountOffboarding');
const { drainRuntime } = require('../services/gracefulShutdown');
const { createGlobalRequestBudget } = require('../middleware/globalRequestBudget');
const BrokerAccountModel = require('../models/BrokerAccount');
const executionLeases = require('../services/executionLeaseService');
const EventEmitter = require('node:events');

function query(rows) { return { select() { return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); } }; }

test('Phase 8 production config fails closed on weak internal auth, public HTTP and insecure origins', () => {
  assert.deepEqual(validateProductionConfig({ NODE_ENV: 'test' }), []);
  const errors = validateProductionConfig({ NODE_ENV: 'production', MONGO_URI: 'mongodb+srv://db', INTERNAL_SERVICE_KEY: 'short',
    ANGEL_ONE_API_BASE: 'http://python.example.com', CORS_ORIGIN: 'http://app.example.com' });
  assert.equal(errors.length, 3);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('python.example.com'), false);
  assert.deepEqual(validateProductionConfig({ NODE_ENV: 'production', MONGO_URI: 'mongodb+srv://db', INTERNAL_SERVICE_KEY: 'a'.repeat(40),
    ANGEL_ONE_API_BASE: 'http://python.internal', ALLOW_PRIVATE_HTTP_SERVICE: 'true', CORS_ORIGIN: 'https://app.example.com' }), []);
});

test('Phase 8 global HTTP admission is bounded and releases capacity once per response', () => {
  const budget = createGlobalRequestBudget({ limit: 1 });
  assert.throws(() => createGlobalRequestBudget({ limit: 10_001 }), /between 1 and 10000/);
  const first = new EventEmitter();
  first.status = code => { first.statusCode = code; return first; };
  first.json = body => { first.body = body; return first; };
  let nextCount = 0;
  budget.middleware({}, first, () => { nextCount += 1; });
  const rejected = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  budget.middleware({}, rejected, () => { nextCount += 1; });
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.body.code, 'SERVICE_CAPACITY_EXCEEDED');
  first.emit('finish'); first.emit('close');
  assert.deepEqual(budget.snapshot(), { inFlight: 0, limit: 1 });
  assert.equal(nextCount, 1);
});

test('Phase 8 Express app admits requests before JSON body parsing', () => {
  const { app } = require('../index');
  const stack = app.router.stack;
  const budget = require('../middleware/globalRequestBudget').globalRequestBudget.middleware;
  const budgetIndex = stack.findIndex(layer => layer.handle === budget);
  const parserIndex = stack.findIndex(layer => layer.name === 'jsonParser');
  assert.ok(budgetIndex >= 0 && parserIndex >= 0);
  assert.ok(budgetIndex < parserIndex, 'request capacity must be checked before express.json buffers/parses the body');
});

test('Phase 8 audit redacts credential-shaped data and retains explicit tenant identity', () => {
  assert.equal(redact('api_key=do-not-log'), 'api_key=[REDACTED]');
  const row = audit('order_submit', { userId: 'user-a', brokerAccountId: 'account-a', sessionGeneration: 4 }, { apiKey: 'hidden', orderType: 'MARKET' });
  assert.equal(row.userId, 'user-a');
  assert.equal(row.brokerAccountId, 'account-a');
  assert.equal(row.attributes.apiKey, undefined);
});

test('Credential redaction covers JSON, quoted whitespace, escaped values and complete auth schemes', () => {
  const cases = [
    '{"apiKey":"dummy-secret"}', '{"refresh_token": "dummy secret"}',
    "password='dummy secret'", 'Authorization: Bearer dummy-secret',
    'authorization=Basic dummy-secret', '{"totp":"dummy-secret"}',
    '{"feed_token":"dummy\\\"secret"}',
  ];
  for (const value of cases) {
    assert.equal(redact(value).includes('dummy'), false, value);
    assert.ok(redact(value).includes('[REDACTED]'));
  }
  assert.equal(redact('order=123 strategy=HeikenAshi'), 'order=123 strategy=HeikenAshi');
});

test('Phase 8 alert transport failure never logs webhook URL or transport message', async t => {
  const originalUrl = process.env.ALERT_WEBHOOK_URL;
  const originalFetch = global.fetch;
  const originalError = console.error;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ALERT_WEBHOOK_URL; else process.env.ALERT_WEBHOOK_URL = originalUrl;
    global.fetch = originalFetch; console.error = originalError;
  });
  const secret = 'webhook-secret-token';
  process.env.ALERT_WEBHOOK_URL = `https://hooks.example/${secret}`;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  global.fetch = async () => { throw new Error(`failed connecting to ${process.env.ALERT_WEBHOOK_URL}`); };
  const result = await require('../services/notificationService').notifyUrgent('BROKER_SESSION_FAILURE', { userId: 'u1', brokerAccountId: 'a1' });
  assert.equal(result.reason, 'webhook transport failed');
  assert.ok(!lines.join(' ').includes(secret));
});

test('Watchdog attributes quote health to each durable position on the same account', async t => {
  const f = await require('./helpers/executionFixture').fixture(t, { readyFeed: true });
  const first = await f.runner(0, 'HeikenAshi', false);
  const second = await f.runner(0, 'ModifiedHeikenAshi', false);
  await first.executeEntry(f.contract, 100, 'BULLISH');
  await second.executeEntry(f.contract, 100, 'BULLISH');
  first.lastQuoteReceivedAt = Date.now(); second.lastQuoteReceivedAt = Date.now() - 60000;
  const calls = [];
  const watchdog = new OperationalWatchdog({ recovery: { listStates: () => [] }, notify: async (event, details) => { calls.push({ event, details }); return { delivered: true }; } });
  await watchdog.check();
  const stale = calls.filter(call => call.event === 'STALE_POSITION_QUOTE');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].details.positionId, String(f.stores.Position[1]._id));
  first.lastQuoteReceivedAt = Date.now() - 60000;
  await watchdog.check();
  assert.equal(calls.filter(call => call.event === 'STALE_POSITION_QUOTE').length, 2, 'each position has its own alert deduplication key');
});

test('Phase 8 watchdog scopes exposure, stale-quote, unresolved-intent, broker and recovery alerts per account', async () => {
  const calls = [];
  const lease = { userId: 'u1', brokerAccountId: 'a1', ownerId: executionLeases.ownerId, generation: 4, leaseUntil: new Date(20_000_000) };
  const deps = {
    Position: { find: () => query([{ userId: 'u1', brokerAccountId: 'a1', status: 'UNPROTECTED', executionSnapshot: { executionMode: 'LIVE' },
      executionOwnerId: executionLeases.ownerId, executionOwnerGeneration: 4, remainingQuantity: 1 }]) },
    OrderIntent: { find: () => query([{ userId: 'u2', brokerAccountId: 'a2', status: 'UNKNOWN', updatedAt: new Date(0) }]) },
    ExecutionLease: { find: () => query([lease]) },
    BrokerAccount: { find: () => query([{ userId: 'u2', _id: 'a2', status: 'SESSION_EXPIRED' }]) },
    recovery: { listStates: () => [['u1', 'a1', { status: 'DEGRADED', message: 'recovery blocked' }]] },
    getRuntimePositions: () => [], now: () => 10_000_000,
    notify: async (event, context) => calls.push({ event, context }),
  };
  const watchdog = new OperationalWatchdog(deps);
  await watchdog.check();
  assert.deepEqual(new Set(calls.map(call => call.event)), new Set([
    'STALE_POSITION_QUOTE', 'UNPROTECTED_EXPOSURE', 'UNRESOLVED_ORDER_INTENT', 'BROKER_SESSION_FAILURE', 'RECOVERY_FAILED',
  ]));
  assert.ok(calls.every(({ context }) => context.userId && context.brokerAccountId));
  const prior = calls.length;
  await watchdog.check();
  assert.equal(calls.length, prior, 'repeated alerts are deduplicated until the condition clears');
});

test('Phase 8 watchdog reports DB scan failure to active accounts without global notification fallback', async () => {
  const calls = [];
  const watchdog = new OperationalWatchdog({
    Position: { find: () => { throw new Error('database unavailable'); } },
    OrderIntent: {}, ExecutionLease: {}, BrokerAccount: {}, recovery: {}, getRuntimePositions: () => [],
    notify: async (event, context) => calls.push({ event, context }),
  });
  const active = require('../services/activeAccountService');
  const before = active.listActiveAccounts;
  active.listActiveAccounts = () => [{ userId: 'u1', brokerAccountId: 'a1' }];
  try { await assert.rejects(watchdog.check(), /database unavailable/); }
  finally { active.listActiveAccounts = before; }
  assert.equal(calls[0].event, 'PERSISTENCE_FAILURE');
  assert.equal(calls[0].context.brokerAccountId, 'a1');
});

test('Phase 8 watchdog redacts persistence failures and continues account alert fanout after notifier throws', async t => {
  const active = require('../services/activeAccountService');
  const before = active.listActiveAccounts;
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  active.listActiveAccounts = () => [{ userId: 'u1', brokerAccountId: 'a1' }, { userId: 'u2', brokerAccountId: 'a2' }];
  const alerted = [];
  const watchdog = new OperationalWatchdog({
    Position: { find: () => { throw new Error('internal_service_key=secret-value database unavailable'); } },
    OrderIntent: {}, ExecutionLease: {}, BrokerAccount: {}, recovery: {}, getRuntimePositions: () => [],
    notify: async (_event, context) => { alerted.push(context.brokerAccountId); if (context.brokerAccountId === 'a1') throw new Error('secret'); return { delivered: true }; },
  });
  t.after(() => { active.listActiveAccounts = before; console.error = originalError; });
  await assert.rejects(watchdog.check(), /internal_service_key/);
  assert.deepEqual(alerted, ['a1', 'a2']);
  const text = logs.join('\n');
  assert.equal(text.includes('secret-value'), false);
  assert.equal(text.includes('secret'), false);
});

for (const type of ['Position', 'OrderIntent', 'Trade']) test(`Offboarding checks real Mongoose ${type} account links`, async t => {
  const f = await require('./helpers/executionFixture').fixture(t, { readyFeed: false });
  const context = f.contexts[0];
  const account = f.stores.BrokerAccount[0]; account.status = 'DISCONNECTED'; account.version = 0;
  require('../services/activeAccountService').clearActiveAccount(context.userId, context.brokerAccountId);
  const record = { _id: new (require('mongoose').Types.ObjectId)(), userId: account.userId, brokerAccountId: account._id,
    ...(type === 'Position' ? { status: 'OPEN' } : type === 'OrderIntent' ? { status: 'UNKNOWN' } : { executionMode: 'LIVE' }) };
  f.stores[type].push(record);
  await assert.rejects(offboardAccount(context), { code: 'UNRESOLVED_EXPOSURE' });
  assert.equal(account.status, 'DISCONNECTED');
  record.userId = f.rows[1].userId; record.brokerAccountId = f.rows[1]._id;
  assert.equal((await offboardAccount(context)).status, 'DISABLED');
  assert.equal(f.stores[type].length, 1, 'offboarding must retain records');
});

test('Phase 8 account offboarding retains records and refuses unresolved exposure', async () => {
  const userId = '111111111111111111111111';
  const brokerAccountId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const accountContext = {
    assertVerified: value => value,
    owned: async () => ({ _id: brokerAccountId, version: 7, status: 'DISCONNECTED' }),
    denied: message => Object.assign(new Error(message), { status: 404 }),
  };
  const context = { userId, brokerAccountId };
  const observedFilters = [];
  const BrokerAccount = {
    async findOne(filter) {
      observedFilters.push(filter);
      const query = BrokerAccountModel.findOne(filter);
      query.cast(); // Apply the real Mongoose schema's path casting.
      assert.deepEqual(Object.keys(query.getFilter()).sort(), ['_id', 'userId']);
      return { _id: brokerAccountId, version: 7, status: 'DISCONNECTED' };
    },
    async findOneAndUpdate(filter) {
      observedFilters.push(filter);
      const query = BrokerAccountModel.findOne(filter);
      query.cast();
      assert.deepEqual(Object.keys(query.getFilter()).sort(), ['_id', 'status', 'userId', 'version']);
      return { status: 'DISABLED' };
    },
  };
  const activeAccounts = { getActiveAccount: () => null };
  await assert.rejects(offboardAccount(context, { accountContext, BrokerAccount,
    Position: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'p1' }) }) }) },
    OrderIntent: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
    Trade: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) }, activeAccounts }), { status: 409, code: 'UNRESOLVED_EXPOSURE' });
  const result = await offboardAccount(context, { accountContext, BrokerAccount,
    Position: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
    OrderIntent: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
    Trade: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) }, activeAccounts });
  assert.deepEqual(result, { status: 'DISABLED', historyRetained: true });
  assert.equal(observedFilters.length, 3);
  assert.equal(BrokerAccountModel.schema.path('brokerAccountId'), undefined);
});

test('Phase 8 graceful drain keeps position monitoring alive for the handoff window after HTTP closes', async () => {
  const order = [];
  const started = Date.now();
  let monitorTicks = 0;
  const monitor = setInterval(() => { monitorTicks += 1; }, 5);
  const result = await drainRuntime({
    server: { close(callback) { order.push('http-close'); callback(); } },
    beginDrain: () => order.push('draining'),
    stopNewEntries: async () => { order.push('stop-entries'); return { positionsStillManaged: 2 }; },
    stopHealthServices: () => order.push('stop-health-only'),
    finishHandoff: async () => { order.push('ownership-handoff'); return { handedOff: true }; },
    timeoutMs: 60,
    logger: { warn() {} },
  });
  clearInterval(monitor);
  assert.deepEqual(order, ['draining', 'stop-entries', 'stop-health-only', 'http-close', 'ownership-handoff']);
  assert.ok(Date.now() - started >= 50, 'position monitoring must survive the configured drain window');
  assert.ok(monitorTicks >= 1, 'process-local position monitor timers must keep running during drain');
  assert.deepEqual(result, { drained: true, handoffReady: true, positionsStillManaged: 2 });
});

test('Phase 8 shutdown ownership handoff releases only the local lease generation after monitors quiesce', async t => {
  const leaseModel = require('../models/ExecutionLease');
  const originals = { findOne: leaseModel.findOne, create: leaseModel.create, findOneAndUpdate: leaseModel.findOneAndUpdate, updateOne: leaseModel.updateOne };
  const userId = '111111111111111111111111';
  const brokerAccountId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const context = { userId, brokerAccountId };
  const persisted = { userId, brokerAccountId, generation: 0, ownerId: null, leaseUntil: new Date(0), state: 'IDLE' };
  let releaseFilter;
  let releaseUpdate;
  leaseModel.findOne = () => query(persisted);
  leaseModel.create = async () => persisted;
  leaseModel.findOneAndUpdate = (_filter, update) => {
    Object.assign(persisted, update.$set);
    persisted.generation += update.$inc.generation;
    return query({ ...persisted, leaseUntil: new Date(Date.now() + 30_000) });
  };
  leaseModel.updateOne = async (filter, update) => { releaseFilter = filter; releaseUpdate = update; return { matchedCount: 1 }; };
  t.after(() => {
    Object.assign(leaseModel, originals);
    executionLeases.releaseLocal(context);
  });
  const token = await executionLeases.acquire(context);
  const released = await executionLeases.releaseOwned();
  assert.equal(released.length, 1);
  assert.equal(releaseFilter.ownerId, token.ownerId);
  assert.equal(releaseFilter.generation, token.generation);
  assert.equal(releaseUpdate.$set.ownerId, null);
  assert.equal(releaseUpdate.$set.state, 'IDLE');
  assert.equal(executionLeases.current(context), null);
});

test('Phase 8 watchdog retries a critical alert after failed delivery while condition remains active', async () => {
  let attempts = 0;
  const watchdog = new OperationalWatchdog({
    Position: { find: () => query([{ userId: 'u1', brokerAccountId: 'a1', status: 'UNPROTECTED', executionOwnerId: 'owner', executionOwnerGeneration: 1,
      executionSnapshot: { executionMode: 'LIVE' }, remainingQuantity: 1 }]) },
    OrderIntent: { find: () => query([]) }, ExecutionLease: { find: () => query([{ userId: 'u1', brokerAccountId: 'a1', ownerId: 'owner', generation: 1, leaseUntil: new Date(50_000) }]) },
    BrokerAccount: { find: () => query([]) }, recovery: { listStates: () => [] }, getRuntimePositions: () => [], now: () => 10_000,
    notify: async event => { if (event === 'UNPROTECTED_EXPOSURE' && ++attempts === 1) return { delivered: false }; return { delivered: true }; },
  });
  await watchdog.check(); await watchdog.check();
  assert.equal(attempts, 2);
});

test('Phase 8 watchdog does not report another replica owner quote as stale during rolling deployment', async () => {
  const calls = [];
  const watchdog = new OperationalWatchdog({
    Position: { find: () => query([{ userId: 'u1', brokerAccountId: 'a1', status: 'OPEN', executionOwnerId: 'old-process', executionOwnerGeneration: 8,
      executionSnapshot: { executionMode: 'PAPER' }, remainingQuantity: 1 }]) },
    OrderIntent: { find: () => query([]) }, ExecutionLease: { find: () => query([{ userId: 'u1', brokerAccountId: 'a1', ownerId: 'old-process', generation: 8, leaseUntil: new Date(50_000) }]) },
    BrokerAccount: { find: () => query([]) }, recovery: { listStates: () => [] }, getRuntimePositions: () => [], now: () => 10_000,
    notify: async (event, context) => { calls.push(event); return { delivered: true }; },
  });
  await watchdog.check();
  assert.equal(calls.includes('STALE_POSITION_QUOTE'), false);
});

test('Phase 8 shutdown handling retains an exposed legacy monitor while stopping scanner timers', () => {
  const engine = require('../services/strategyEngine');
  const monitor = setInterval(() => {}, 10000);
  const scanner = setInterval(() => {}, 10000);
  const runner = { accountContext: null, activeTradeId: 'held-trade', activeTradePremium: 'HELD', positionState: 'OPEN',
    monitorInterval: monitor, scanInterval: scanner, contractInterval: null, heartbeatInterval: null,
    getBaseTimeframe: () => 'FIVE_MINUTE', releaseFeed() {} };
  engine.runners.set('phase8-shutdown-drain', runner);
  try {
    const result = engine.stopAllForShutdown();
    assert.equal(result.positionsStillManaged, 1);
    assert.equal(runner.isRunning, false);
    assert.equal(runner.shutdownDraining, true);
    assert.equal(runner.monitorInterval, monitor);
  } finally {
    clearInterval(monitor); clearInterval(scanner);
    engine.runners.delete('phase8-shutdown-drain');
    require('../services/marketSessionManager').stopMonitoring();
  }
});

test('Phase 8 position persistence failure emits an explicit account-scoped alert and retains degraded state', async t => {
  const f = await require('./helpers/executionFixture').fixture(t);
  const runner = await f.runner(0, 'HeikenAshi', false);
  const notifyService = require('../services/notificationService');
  const original = notifyService.notifyUrgent;
  const events = [];
  notifyService.notifyUrgent = async (event, scope) => { events.push({ event, scope }); return { delivered: true }; };
  t.after(() => { notifyService.notifyUrgent = original; });
  require('../services/positionExecution').forRunner(runner).degraded(Object.assign(new Error('write concern failed'), { name: 'MongoServerError' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.positionState, 'RECONCILIATION_REQUIRED');
  assert.equal(events[0].event, 'PERSISTENCE_FAILURE');
  assert.equal(events[0].scope.userId, f.contexts[0].userId);
  assert.equal(events[0].scope.brokerAccountId, f.contexts[0].brokerAccountId);
});
