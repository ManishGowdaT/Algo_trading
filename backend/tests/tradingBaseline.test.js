const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');

const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trading-baseline.json'), 'utf8'));

test('baseline fixture is tied to the reviewed code revision and known strategy parameters', () => {
  assert.equal(baseline.revision, '30b763b1fb4140426508fb6be2620a6109316d03');
  assert.deepEqual(baseline.engineExpectations.defaultQuantity, { SENSEX: 20, NIFTY: 65, BANKNIFTY: 30, CRUDEOILM: 1 });
  assert.deepEqual(baseline.engineExpectations.cooldownMinutes, { breakoutAnyExit: 1, stopLoss: 4, target: 2, trailingStop: 2 });
});

test('Heiken Ashi plugins characterize current bullish entry and bearish reversal rules', () => {
  const HeikenAshi = require('../trading/strategies/plugins/heikenAshiPlugin');
  const ModifiedHeikenAshi = require('../trading/strategies/plugins/modifiedHeikenAshiPlugin');
  const indicators = require('../trading/indicators');
  const bullishCandles = Array.from({ length: 30 }, (_, i) => {
    const open = 100 + i;
    return { time: i, open, high: open + 1, low: open, close: open + 1 };
  });
  const bearishCandles = Array.from({ length: 30 }, (_, i) => {
    const open = 200 - i;
    return { time: i, open, high: open, low: open - 1, close: open - 1 };
  });
  for (const Plugin of [HeikenAshi, ModifiedHeikenAshi]) {
    const plugin = new Plugin({ emaPeriod: 20, jmaLength: 7 });
    const signal = plugin.analyze({ items: bullishCandles, indicators, userId: 'baseline-user' });
    assert.equal(signal.isEntry, true);
    assert.equal(signal.isExit, false);
    assert.equal(signal.trend, 'BULLISH');
    assert.equal(signal.lastNoWick, true);
    assert.equal(signal.jmaGtEma, true);
    assert.equal(signal.closeGtJma, true);

    const bearish = plugin.analyze({ items: bearishCandles, indicators, userId: 'baseline-user' });
    assert.equal(bearish.isEntry, false);
    assert.equal(bearish.isExit, true);
    assert.equal(bearish.trend, 'BEARISH');
  }
});

test('Heiken Ashi signal rejects insufficient data and reports failed conditions', () => {
  const HeikenAshi = require('../trading/strategies/plugins/heikenAshiPlugin');
  const plugin = new HeikenAshi();
  assert.deepEqual(plugin.analyze({ items: [], indicators: {} }).failedReasons, ['Insufficient candle data']);
  const signal = plugin.analyze({
    items: [{}, {}],
    indicators: {
      computeHeikenAshi: () => [{ open: 10, low: 9, close: 10 }, { open: 10, low: 9, close: 9 }],
      computeEMA: () => [10, 10], computeJMA: () => [10, 9],
    },
  });
  assert.equal(signal.isEntry, false);
  assert.ok(signal.failedReasons.length > 0);
});

test('breakout helper preserves close-only breakout, range validity, and stop buffer rules', () => {
  const { computePremiumRange, detectBreakoutCloseOnly, computeStopLossAndTarget, shouldProcessCandle } = require('../trading/strategies/premiumRangeBreakout');
  const range = computePremiumRange([
    { high: 110, low: 100 }, { open: 102, close: 108 }, { open: 105, close: 109 },
  ], 3, 30);
  assert.deepEqual(range, { rangeHigh: 110, rangeLow: 100, size: 10, isValid: true });
  assert.equal(detectBreakoutCloseOnly({ candleClose: 111, range }), true);
  assert.equal(detectBreakoutCloseOnly({ candleClose: 110, range }), false);
  assert.equal(detectBreakoutCloseOnly({ candleClose: 111, range: { ...range, isValid: false } }), false);
  assert.deepEqual(computeStopLossAndTarget({ entryPrice: 115, rangeLow: 100 }), { stopLoss: 98, target: 132 });
  assert.equal(shouldProcessCandle({ lastProcessedTs: null, nextTs: 'candle-1' }), true);
  assert.equal(shouldProcessCandle({ lastProcessedTs: 'candle-1', nextTs: 'candle-1' }), false);
});

test('breakout plugin emits the current entry, SL, target, and duplicate-candle outputs', () => {
  const Breakout = require('../trading/strategies/plugins/breakout5minPlugin');
  const plugin = new Breakout({ lookback: 3, maxRangeLimit: 30, bufferPoints: 2, targetPoints: 20 });
  const currentMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const candles = [
    { ts: new Date(currentMinute - 4 * 60_000).toISOString(), open: 105, high: 110, low: 100, close: 106 },
    { ts: new Date(currentMinute - 3 * 60_000).toISOString(), open: 105, high: 109, low: 101, close: 108 },
    { ts: new Date(currentMinute - 2 * 60_000).toISOString(), open: 106, high: 109, low: 102, close: 107 },
    { ts: new Date(currentMinute - 1 * 60_000).toISOString(), open: 108, high: 112, low: 107, close: 111 },
  ];
  const signal = plugin.analyze({ items: candles, lastProcessedTs: null });
  assert.equal(signal.isBreakout, true);
  assert.equal(signal.entryPrice, 111);
  assert.equal(signal.stopLoss, 98);
  assert.equal(signal.target, 131);
  assert.equal(plugin.analyze({ items: candles, lastProcessedTs: candles[3].ts }).isBreakout, false);

  const timeOnlyCandles = candles.map(({ ts, ...candle }) => ({ ...candle, time: ts }));
  assert.deepEqual(plugin.analyze({ items: timeOnlyCandles, lastProcessedTs: null }).failedReasons, ['Completed candle window unavailable']);
});

test('strategy routes preserve existing authenticated API paths and methods', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'strategyRoutes.js'), 'utf8');
  for (const [method, routePath] of baseline.engineExpectations.api) {
    assert.match(source, new RegExp(`router\\.${method.toLowerCase()}\\(['"]${routePath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}['"]`));
  }
  assert.match(source, /router\.use\(authController\.protect\)/);
});

test('active broker sessions remain isolated by user and account', () => {
  const activeAccount = require('../services/activeAccountService');
  activeAccount.clearActiveAccount();
  activeAccount.setActiveAccount({ userId: 'user-A', clientCode: '12345678', brokerAccountId: 'account-A', sessionId: 'session-A' });
  activeAccount.setActiveAccount({ userId: 'user-B', clientCode: '87654321', brokerAccountId: 'account-B', sessionId: 'session-B' });
  assert.equal(activeAccount.getActiveAccount('user-A', 'account-A').sessionId, 'session-A');
  assert.equal(activeAccount.getActiveAccount('user-B', 'account-B').sessionId, 'session-B');
  assert.equal(activeAccount.getActiveAccount(), null); // ambiguous legacy read fails closed
  assert.throws(() => activeAccount.assertActiveUser('user-B', 'account-A'), error => error.code === 'INACTIVE_BROKER_ACCOUNT' && error.status === 409);
  activeAccount.clearActiveAccount('user-A', 'account-A');
  assert.equal(activeAccount.getActiveAccount('user-B', 'account-B').sessionId, 'session-B');
  activeAccount.clearActiveAccount('user-B', 'account-B');
});

test('runner executes PAPER/LIVE entry and SL/target/trailing exits with the current recorded thresholds', async (t) => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const requests = [];
  const dbTrades = new Map();
  let nextId = 1;
  let quote = 100;
  let lastOrderId = null;
  const market = new EventEmitter();
  const orderUpdates = new EventEmitter();
  const tradeModel = {
    async create(doc) {
      const trade = { ...doc, _id: { toString: () => `trade-${nextId}` }, async save() {}, toObject() { return { ...this }; } };
      nextId += 1;
      dbTrades.set(trade._id.toString(), trade);
      return trade;
    },
    async findById(id) { return dbTrades.get(String(id)) || null; },
    async findByIdAndUpdate() {},
    async findOne() { return { select: () => ({ lean: async () => null }) }; },
  };
  const strategyModel = { async findOne() { return { _id: 'strategy-1' }; } };
  const fakeRequestPython = async (endpoint, options = {}) => {
    requests.push({ endpoint, ...options });
    if (endpoint === '/angel/status') return { response: { ok: true }, data: { connected: true }, text: '' };
    if (endpoint === '/market/ltp?') return { response: { ok: true }, data: { ltp: quote }, text: '' };
    if (endpoint.startsWith('/market/ltp')) return { response: { ok: true }, data: { ltp: quote }, text: '' };
    if (endpoint === '/angel/orders/simple' && options.body?.transactiontype === 'BUY') {
      lastOrderId = `order-${nextId}`;
      return { response: { ok: true }, data: { item: { response: { data: { orderid: lastOrderId } } } }, text: '' };
    }
    if (endpoint === '/angel/orders/simple' && options.body?.ordertype === 'SL') {
      return { response: { ok: true }, data: { item: { response: { data: { orderid: `protect-${nextId}` } } } }, text: '' };
    }
    if (endpoint === '/angel/orders/simple' && options.body?.transactiontype === 'SELL') {
      lastOrderId = `sell-${nextId}`;
      return { response: { ok: true }, data: { item: { response: { data: { orderid: lastOrderId } } } }, text: '' };
    }
    if (endpoint === '/angel/orderbook') return { response: { ok: true }, data: { data: [{ orderid: lastOrderId, status: 'complete', averageprice: String(String(lastOrderId).startsWith('order-') ? 104 : quote) }] }, text: '' };
    if (endpoint.includes('/cancel')) return { response: { ok: true }, data: {}, text: '' };
    throw new Error(`Unexpected fixture broker request ${endpoint}`);
  };
  const mocks = {
    '../models/Trade': tradeModel,
    '../models/Strategy': strategyModel,
    './contractManager': {},
    './marketDataService': market,
    './orderUpdateService': orderUpdates,
    './marketSessionManager': { startMonitoring() {} },
    './notificationService': { notifyUrgent: async () => {} },
    './pythonApiClient': { requestPython: fakeRequestPython },
    './strategyRegistry': { init: async () => {}, hasPlugin: () => true },
    '../trading/indicators': {},
  };
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === path.join(__dirname, '..', 'services', 'strategyEngine.js') && Object.hasOwn(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setInterval = (callback) => ({ callback, fakeInterval: true });
  global.clearInterval = () => {};
  global.setTimeout = (callback, ms, ...args) => {
    if (ms === 1000 || ms === 5000) {
      const handle = originalSetTimeout(() => callback(...args), 0);
      return handle;
    }
    return originalSetTimeout(callback, ms, ...args);
  };
  const enginePath = require.resolve('../services/strategyEngine');
  delete require.cache[enginePath];
  let manager;
  t.after(() => {
    if (manager) {
      for (const runner of manager.runners.values()) {
        runner.isRunning = false;
        runner.monitorInterval = null;
      }
      manager.runners.clear();
    }
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    delete require.cache[enginePath];
  });
  manager = require('../services/strategyEngine');

  const userARunner = manager.getRunner('userA_HeikenAshi');
  const userBRunner = manager.getRunner('userB_HeikenAshi');
  userARunner.isRunning = true;
  userBRunner.isRunning = true;
  market.emit('session:lost', { reason: 'fixture session loss' });
  assert.equal(userARunner.brokerReady, false);
  assert.equal(userBRunner.brokerReady, false, 'current process-wide session event is broadcast to both users');
  userARunner.isRunning = false;
  userBRunner.isRunning = false;

  const contract = { exchange: 'NFO', tradingsymbol: 'NIFTY-OPT', symboltoken: 'token-1' };
  async function enter(strategyName, config, entryPrice = 100, stopLoss = null) {
    const runner = manager.getRunner(`baseline${nextId}_${strategyName}`);
    runner.config = config;
    runner.userId = `baseline${nextId}`;
    runner.brokerReady = true;
    runner.isRunning = true;
    runner.state = 'SCANNING';
    runner.stopLoss = stopLoss;
    await runner.executeEntry(contract, entryPrice, 'BULLISH');
    return runner;
  }

  const paper = await enter('HeikenAshi', { underlying: 'NIFTY', quantity: 7, liveTradingConsent: false, targetPoints: 20, slPoints: 30 });
  assert.equal(paper.entryPrice, 100);
  assert.equal(paper.positionState, 'PROTECTED');
  assert.equal(dbTrades.get(paper.activeTradeId).executionMode, 'PAPER');
  assert.equal(requests.length, 0, 'PAPER entry must not submit broker orders');
  quote = 70;
  await paper.monitorInterval.callback();
  assert.equal(paper.lastCompletedTrade.exitReason, 'SL');
  assert.equal(paper.state, 'COOLDOWN');
  assert.ok(Math.abs(paper.cooldownUntil - (Date.now() + 4 * 60 * 1000)) < 250);

  quote = 100;
  const target = await enter('HeikenAshi', { underlying: 'SENSEX', quantity: 20, liveTradingConsent: false, targetPoints: 20, slPoints: 30 });
  quote = 120;
  await target.monitorInterval.callback();
  assert.equal(target.lastCompletedTrade.exitReason, 'Target');
  assert.ok(Math.abs(target.cooldownUntil - (Date.now() + 2 * 60 * 1000)) < 250);

  quote = 100;
  const trailing = await enter('ModifiedHeikenAshi', { underlying: 'CRUDEOILM', quantity: 1, liveTradingConsent: false, exitStrategy: 'TRAILING_SL', initialSlPoints: 30, trailingStopPoints: 20, finalTargetPoints: 100 });
  assert.equal(trailing.activeTrailingSl, 70);
  quote = 120;
  await trailing.monitorInterval.callback();
  assert.equal(trailing.activeTrailingSl, 90);
  quote = 90;
  await trailing.monitorInterval.callback();
  assert.equal(trailing.lastCompletedTrade.exitReason, 'Trailing SL');
  assert.ok(Math.abs(trailing.cooldownUntil - (Date.now() + 2 * 60 * 1000)) < 250);

  quote = 100;
  const breakout = await enter('5minBreakout', { underlying: 'NIFTY', quantity: 65, liveTradingConsent: false, targetPoints: 20 }, 100, 98);
  quote = 120;
  await breakout.monitorInterval.callback();
  assert.equal(breakout.lastCompletedTrade.exitReason, 'Target');
  assert.ok(Math.abs(breakout.cooldownUntil - (Date.now() + 1 * 60 * 1000)) < 250);

  quote = 100;
  const live = await enter('HeikenAshi', { underlying: 'NIFTY', liveTradingConsent: true, targetPoints: 20, slPoints: 30 }, 100);
  assert.equal(live.entryPrice, 104, 'LIVE uses the completed broker fill price');
  assert.equal(dbTrades.get(live.activeTradeId).executionMode, 'LIVE');
  const buy = requests.find(item => item.endpoint === '/angel/orders/simple' && item.body?.transactiontype === 'BUY');
  const protective = requests.find(item => item.endpoint === '/angel/orders/simple' && item.body?.ordertype === 'SL');
  assert.equal(buy.body.quantity, 65, 'NIFTY default quantity is used when config quantity is absent');
  assert.equal(protective.body.quantity, 65);
  assert.equal(protective.body.triggerprice, 74);
  quote = 110;
  await live.monitorInterval.callback();
  assert.equal(live.message, 'Position Active | LTP: ₹110.00 | PnL: ₹60.00', 'current display uses fallback quantity 10 despite 65-unit entry');
  quote = 130;
  await live.monitorInterval.callback();
  assert.equal(live.lastCompletedTrade.exitReason, 'Target');
  assert.ok(requests.some(item => item.endpoint === '/angel/orders/simple' && item.body?.transactiontype === 'SELL'));
  assert.ok(requests.some(item => item.endpoint.startsWith('/angel/orders/') && item.endpoint.endsWith('/cancel')));

  for (const runner of manager.runners.values()) {
    runner.isRunning = false;
    runner.monitorInterval = null;
  }
  manager.runners.clear();
});
