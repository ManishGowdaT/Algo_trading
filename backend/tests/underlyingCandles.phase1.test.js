const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSession, sessionBounds, UnderlyingCandleStream } = require('../services/underlyingCandleStream');
const BaseStrategy = require('../trading/strategies/BaseStrategy');
const router = require('../services/marketDataService');
const accounts = require('../services/accountContext');
const { fixture } = require('./helpers/executionFixture');
const at = text => Date.parse(`2026-10-16T${text}+05:30`);
function bars(count = 15) {
  return Array.from({ length: count }, (_, i) => ({ ts: new Date(at('09:15:00') + i * 60000).toISOString(),
    open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 + i }));
}
function owner() {
  const context = accounts.mint({ userId: 'u', _id: 'a', brokerClientId: 'c', sessionGeneration: 1, ownerGeneration: 1 }, 's');
  const service = new router.AccountMarketDataService(context);
  service.autoInitSession = async () => {};
  service.validateUnderlyingContext = async () => {};
  return service;
}
test('all index instruments derive three exact OR bars; forming/previous day rows excluded', async () => {
  for (const index of ['NIFTY', 'BANKNIFTY', 'SENSEX']) {
    const service = owner();
    const stream = new UnderlyingCandleStream(service, index, () => at('09:30:01'));
    let request;
    service.requestPython = async (path, options) => { request = { path, options }; return { response: { ok: true }, data: { items: bars(16) } }; };
    await stream.refresh();
    const snapshot = stream.getSnapshot();
    assert.equal(snapshot.ready, true); assert.equal(snapshot.candles1m.length, 15); assert.equal(snapshot.candles5m.length, 3);
    assert.deepEqual(snapshot.candles5m.map(c => c.volume), [60, 85, 110]);
    assert.equal(snapshot.candles5m[0].open, 100); assert.equal(snapshot.candles5m[0].close, 105);
    assert.equal(snapshot.candles5m[0].high, 106); assert.equal(snapshot.candles5m[0].low, 99);
    assert.ok(request.path.includes('include_volume=true')); assert.equal(request.options.context, service.accountContext);
    assert.ok(request.path.includes(index === 'SENSEX' ? 'exchange=BSE' : 'exchange=NSE'));
    const previous = { ...bars(1)[0], ts: '2026-10-15T09:15:00+05:30' };
    assert.equal(normalizeSession([previous, ...bars()], at('09:30:01')).candles1m.length, 15);
  }
});
test('session completeness/volume validation fails closed without inventing bars', () => {
  const gap = bars(); gap.splice(2, 1);
  const result = normalizeSession(gap, at('09:30:01'));
  assert.equal(result.complete, false); assert.equal(result.missingBars, 1); assert.equal(result.candles5m.length, 2);
  for (const value of [null, undefined, -1, NaN, Infinity]) {
    const input = bars(); input[1].volume = value;
    assert.equal(normalizeSession(input, at('09:30:01')).complete, false);
  }
  const zero = bars().map(c => ({ ...c, volume: 0 }));
  assert.ok(normalizeSession(zero, at('09:30:01')).errors.includes('ZERO_CUMULATIVE_VOLUME'));
  zero[0].volume = 1; assert.equal(normalizeSession(zero, at('09:30:01')).complete, true);
  const synthetic = bars(); synthetic[0].synthetic = true;
  assert.equal(normalizeSession(synthetic, at('09:30:01')).complete, false);
});
test('identical overlap never double counts; conflicting duplicates/out-of-order are degraded', () => {
  const input = bars(); input.splice(1, 0, { ...input[0] });
  const result = normalizeSession(input, at('09:30:01'));
  assert.equal(result.complete, true); assert.equal(result.candles5m[0].volume, 60);
  input[1].volume++;
  assert.equal(normalizeSession(input, at('09:30:01')).complete, false);
  assert.equal(normalizeSession(bars().reverse(), at('09:30:01')).complete, false);
});
test('full-day history retains opening data after 200 bars, freshness expires and date resets', async () => {
  const service = owner(); let now = at('13:00:01');
  const stream = new UnderlyingCandleStream(service, 'NIFTY', () => now);
  service.requestPython = async () => ({ response: { ok: true }, data: { items: bars(226) } });
  await stream.refresh(); assert.equal(stream.getSnapshot().candles1m.length, 225);
  assert.equal(stream.getSnapshot().candles5m[0].time, at('09:15:00') / 1000);
  now += 6000; assert.equal(stream.getSnapshot().ready, false);
  now += 86400000; assert.equal(stream.getSnapshot().candles1m.length, 0);
  assert.equal(sessionBounds(at('09:30:01')).date, '2026-10-16');
});
test('refresh is non-overlapping, publishes 5M before 1M, repairs gaps and emits no duplicates', async () => {
  const service = owner(); const events = []; service.on('candle:closed', e => events.push(e));
  const stream = new UnderlyingCandleStream(service, 'NIFTY', () => at('09:30:01'));
  let resolve, calls = 0;
  service.requestPython = () => { calls++; return new Promise(r => { resolve = r; }); };
  const a = stream.refresh(), b = stream.refresh();
  await Promise.resolve();
  resolve({ response: { ok: true }, data: { items: bars(14) } }); await Promise.all([a, b]);
  assert.equal(calls, 1); assert.equal(events.length, 0);
  service.requestPython = async () => ({ response: { ok: true }, data: { items: bars() } });
  await stream.refresh(); await stream.refresh();
  assert.deepEqual(events.map(e => e.interval), ['FIVE_MINUTE', 'ONE_MINUTE']);
  assert.equal(events[0].sessionId, 's'); assert.equal(events[0].role, 'underlying');
  events[0].candles[0].volume = 999;
  assert.equal(stream.getSnapshot().candles5m[0].volume, 60);
});
test('account streams reference-count independently and retired in-flight results cannot publish', async () => {
  const service = owner(); const events = [];service.on('candle:closed', e => events.push(e));
  service.requestPython = async () => ({ response: { ok: true }, data: { items: [] } });
  await service.subscribeUnderlying('NIFTY'); await service.subscribeUnderlying('NIFTY');
  service.unsubscribeUnderlying('NIFTY'); assert.equal(service.underlyingStreams.size, 1);
  service.unsubscribeUnderlying('NIFTY'); assert.equal(service.underlyingStreams.size, 0);
  const stream = new UnderlyingCandleStream(service, 'SENSEX', () => at('09:30:01'));
  let resolve;service.requestPython = () => new Promise(r => { resolve = r; });
  const pending = stream.refresh();await Promise.resolve();service.resetAccountSession();
  resolve({ response: { ok: true }, data: { items: bars() } });await pending;
  assert.equal(events.length, 0);
});
test('ownership is revalidated after history response and repair polling is bounded', async () => {
  const service = owner(); let validations = 0; let emitted = 0;
  service.on('candle:closed', () => emitted++);
  service.validateUnderlyingContext = async () => { if (++validations > 1) throw new Error('Retired account generation'); };
  service.requestPython = async () => ({ response: { ok: true }, data: { items: bars() } });
  const stream = new UnderlyingCandleStream(service, 'NIFTY', () => at('09:30:01'));
  await stream.refresh();assert.equal(stream.getSnapshot().ready, false);assert.equal(emitted, 0);
  for (let i = 0; i < 4; i++) {
    stream.schedule();clearTimeout(stream.timer);stream.timer = null;
  }
  assert.equal(stream.nextRefreshAt, at('09:31:01'));
  stream.stop();
});
test('legacy manifests stay valid and opt-in multi-timeframe requirements reject unknown frames', () => {
  for (const file of ['heikenAshiPlugin', 'modifiedHeikenAshiPlugin', 'breakout5minPlugin']) {
    assert.equal(BaseStrategy.validateManifest(require(`../trading/strategies/plugins/${file}`).manifest), true);
  }
  const manifest = { id: 'test', name: 'test', engineVersion: '1.0.0', requires: {
    dataStreams: ['UNDERLYING_CANDLES'], timeframes: ['ONE_MINUTE', 'FIVE_MINUTE'] } };
  assert.equal(BaseStrategy.validateManifest(manifest), true);
  assert.throws(() => BaseStrategy.validateManifest({ ...manifest, requires: { ...manifest.requires, timeframes: ['1m'] } }));
});
test('cancelled pending router subscription does not install an underlying stream', async () => {
  const routed = new router.MarketDataRouter();const service = owner();
  let resolve, installs = 0;
  routed._service = () => new Promise(r => { resolve = r; });
  service.subscribeUnderlying = () => { installs++; };
  await accounts.run(service.accountContext, async () => {
    const pending = routed.subscribeUnderlying('NIFTY');
    routed.unsubscribeUnderlying('NIFTY');resolve(service);await pending;
  });
  assert.equal(installs, 0);assert.equal(routed.pendingRoutes.size, 0);
});
test('opt-in underlying strategy resolves contracts without subscribing CE/PE signal candles', async t => {
  const f = await fixture(t);const runner = await f.runner(0, 'Phase1UnderlyingOnly');
  const registry = require('../services/strategyRegistry');const contracts = require('../services/contractManager');
  const original = contracts.resolveContracts;
  registry.plugins.set(runner.strategyName, { manifest: { requires: { dataStreams: ['UNDERLYING_CANDLES'], timeframes: ['ONE_MINUTE', 'FIVE_MINUTE'] } } });
  contracts.resolveContracts = async () => ({ selectedExpiry: '2026-10-30', atmStrike: 25000,
    ceContract: f.contract, peContract: { ...f.contract, symboltoken: '78', tradingsymbol: 'HELD-PE' } });
  t.after(() => { contracts.resolveContracts = original;registry.plugins.delete(runner.strategyName); });
  await f.accounts.run(f.contexts[0], () => runner.startContractLoop());
  const service = await f.accounts.run(f.contexts[0], () => f.feeds._service());
  assert.equal(service.subscribers.size, 0);assert.equal(runner.ceContract.symboltoken, '77');
});
test('runner routes only matching account/session/index/timeframe events without submitting entries', async t => {
  const f = await fixture(t);const runner = await f.runner();
  const service = await f.accounts.run(f.contexts[0], () => f.feeds._service());
  const info = normalizeSession(bars(), at('09:30:01'));info.ready = true;
  service.subscribeUnderlying = async () => info;
  service.getUnderlyingSnapshot = () => info;
  await f.accounts.run(f.contexts[0], () => runner.startUnderlyingDataLoop({ timeframes: ['ONE_MINUTE', 'FIVE_MINUTE'] }));
  const good = { ...service.sessionIdentity, role: 'underlying', underlying: 'NIFTY', exchange: 'NSE', symboltoken: '99926000', interval: 'ONE_MINUTE' };
  for (const wrong of [{ brokerAccountId: 'other' }, { sessionId: 'old' }, { exchange: 'NFO' }, { interval: 'THREE_MINUTE' }, { role: 'scanner' }, { symboltoken: '77' }]) {
    runner.underlyingData = null;service.emit('candle:closed', { ...good, ...wrong });assert.equal(runner.underlyingData, null);
  }
  service.emit('candle:closed', good);assert.equal(runner.underlyingData.ready, true);
  assert.equal(runner.activeTradeId, null);
});
