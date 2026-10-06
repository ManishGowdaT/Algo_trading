const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Breakout = require('../trading/strategies/plugins/breakout5minPlugin');
const feeds = require('../services/marketDataService');
const engine = require('../services/strategyEngine');
const registry = require('../services/strategyRegistry');
require('../services/marketSessionManager').stopMonitoring();

function candles(breakout = true, offset = 0) {
  const end = Math.floor(Date.now() / 60000) * 60000;
  return Array.from({ length: 6 }, (_, i) => ({
    time: (end - (6 - i + offset) * 60000) / 1000,
    open: 105, high: i === 5 && breakout ? 112 : 110, low: 100,
    close: i === 5 && breakout ? 111 : 106,
  }));
}

test('real tick candle builder output produces the same breakout as REST timestamps', () => {
  const service = new EventEmitter();
  service.getIntervalMs = () => 60000;
  service.sessionIdentity = {};
  const builder = { interval: 'ONE_MINUTE', candles: [], activeCandle: null };
  const process = feeds.AccountMarketDataService.prototype.processTickForBuilder;
  for (const candle of candles()) {
    for (const [offset, ltp] of [[0, candle.open], [1000, candle.high], [2000, candle.low], [3000, candle.close]]) {
      process.call(service, builder, { timestamp: candle.time * 1000 + offset, ltp });
    }
  }
  process.call(service, builder, { timestamp: Math.floor(Date.now() / 60000) * 60000, ltp: 111 });
  const before = structuredClone(builder.candles);
  const plugin = new Breakout();
  const actual = plugin.analyze({ items: builder.candles, lastProcessedTs: null });
  const rest = plugin.analyze({ items: builder.candles.map(c => ({ ...c, ts: new Date(c.time * 1000).toISOString() })), lastProcessedTs: null });
  assert.deepEqual(actual, rest);
  assert.equal(actual.isBreakout, true);
  assert.equal(actual.entryPrice, 111);
  assert.equal(actual.stopLoss, 98);
  assert.equal(actual.target, 131);
  assert.deepEqual(builder.candles, before);
  assert.equal(plugin.analyze({ items: builder.candles, lastProcessedTs: actual.nextTs }).isBreakout, false);
  const current = Math.floor(Date.now() / 60000) * 60;
  assert.equal(plugin.analyze({ items: candles().slice(1).concat({ ...candles()[5], time: current }), lastProcessedTs: null }).isBreakout, false);
});

test('real scanner accepts late PE breakout after CE minute is processed and deduplicates per instrument', async t => {
  const oldGetBuffer = feeds.getBuffer;
  const oldPlugin = registry.plugins.get('5minBreakout');
  registry.plugins.set('5minBreakout', Breakout);
  const context = require('../services/accountContext').mint({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', brokerClientId: 'BREAKOUT-TEST', sessionGeneration: 1, ownerGeneration: 0 }, 'test-session');
  const service = new feeds.AccountMarketDataService(context);
  const feedKey = feeds._key(context);
  feeds.accounts.set(feedKey, service);
  const runner = engine.replaceForRecovery('breakout-regression', '5minBreakout');
  Object.assign(runner, { accountContext: context, isRunning: true, brokerReady: true, feedScanReady: true, state: 'WAITING', config: {},
    ceContract: { exchange: 'NFO', symboltoken: 'CE', tradingsymbol: 'CE' },
    peContract: { exchange: 'NFO', symboltoken: 'PE', tradingsymbol: 'PE' } });
  let pe = candles(false, 1);
  feeds.getBuffer = (_exchange, token) => token === 'CE' ? candles(false) : pe;
  const entries = [];
  runner.executeEntry = async (contract, price, side) => { entries.push({ token: contract.symboltoken, price, side }); };
  t.after(() => {
    feeds.removeListener('candle:closed', runner.candleListener);
    service.resetAccountSession();
    feeds.accounts.delete(feedKey);
    engine.runners.delete('breakout-regression_5minBreakout');
    feeds.getBuffer = oldGetBuffer;
    if (oldPlugin) registry.plugins.set('5minBreakout', oldPlugin); else registry.plugins.delete('5minBreakout');
  });
  await runner.startScanLoop();
  const event = { userId: context.userId, brokerAccountId: context.brokerAccountId,
    sessionId: context.sessionId, sessionGeneration: context.sessionGeneration };
  await runner.candleListener({ ...event, symboltoken: 'CE' });
  assert.equal(entries.length, 0);
  pe = candles(true);
  await runner.candleListener({ ...event, symboltoken: 'PE' });
  assert.deepEqual(entries, [{ token: 'PE', price: 111, side: 'BEARISH' }]);
  await runner.candleListener({ ...event, symboltoken: 'PE' });
  assert.equal(entries.length, 1);
  runner.peContract = { ...runner.peContract, symboltoken: 'PE-NEW', tradingsymbol: 'PE-NEW' };
  await runner.candleListener({ ...event, symboltoken: 'PE-NEW' });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].token, 'PE-NEW');
});
